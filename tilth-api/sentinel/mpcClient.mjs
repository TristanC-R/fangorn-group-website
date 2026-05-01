/**
 * Microsoft Planetary Computer (MPC) client.
 *
 * Two endpoints we use against MPC's free, public APIs:
 *
 *   1. STAC API (`/api/stac/v1/search`) — find Sentinel-2 L2A scenes
 *      intersecting a field's bounding box, filter by date and cloud
 *      cover. STAC items include the COG hrefs but those are pre-signed
 *      with very short SAS tokens; we never download them ourselves —
 *      titiler does it.
 *
 *   2. Data API / titiler (`/api/data/v1/item/...`) — accepts a STAC
 *      item identifier (collection + id) and either:
 *      a) `/statistics` — per-polygon NDVI stats over a GeoJSON Feature
 *         (we POST the field boundary, get mean / min / max / stddev /
 *         valid_count back).
 *      b) `/tiles/{tileMatrixSetId}/{z}/{x}/{y}.png` — a pre-rendered
 *         PNG tile in EPSG:3857, ready to drop into FieldMapThree2D's
 *         existing `mode: "tile"` overlay slot.
 *
 * MPC handles the SAS-signing internally as long as we identify items
 * by `collection=...&item=...` (rather than passing raw COG URLs).
 *
 * Auth: none required for public read. If `MPC_SUBSCRIPTION_KEY` is set
 * we forward it as `Ocp-Apim-Subscription-Key` for higher rate limits
 * (recommended for production — the unauthenticated quota is very
 * generous but not guaranteed). Get one at:
 *
 *   https://planetarycomputer.developer.azure-api.net/
 *
 * Docs:
 *   https://planetarycomputer.microsoft.com/docs/concepts/sas/
 *   https://planetarycomputer.microsoft.com/docs/reference/data/
 */

const STAC_API = (process.env.MPC_STAC_API_URL || "https://planetarycomputer.microsoft.com/api/stac/v1").replace(
  /\/$/,
  ""
);
const DATA_API = (process.env.MPC_DATA_API_URL || "https://planetarycomputer.microsoft.com/api/data/v1").replace(
  /\/$/,
  ""
);
const SAS_API = (process.env.MPC_SAS_API_URL || "https://planetarycomputer.microsoft.com/api/sas/v1").replace(
  /\/$/,
  ""
);
const SUBSCRIPTION_KEY = (process.env.MPC_SUBSCRIPTION_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = Math.max(5000, Number(process.env.MPC_TIMEOUT_MS || 25_000));
const STATISTICS_TIMEOUT_MS = Math.max(10_000, Number(process.env.MPC_STATISTICS_TIMEOUT_MS || 45_000));
const USER_AGENT =
  (process.env.MPC_USER_AGENT || "").trim() ||
  `FangornTilth/1.0 (+sentinel-2 ndvi; ${(process.env.OSM_CONTACT_EMAIL || "no-contact").trim()})`;

const SENTINEL2_COLLECTION = "sentinel-2-l2a";

// Sentinel-2 L2A Scene Classification Layer (SCL) class codes:
//   0  no_data
//   1  saturated / defective
//   2  dark_area_pixels
//   3  cloud_shadow
//   4  vegetation                  ← keep
//   5  not_vegetated (bare soil)   ← keep
//   6  water
//   7  unclassified                ← DROPPED. Sen2Cor uses 7 as the dumping
//                                     ground for "ambiguous" pixels and it
//                                     famously catches thin cloud, cloud
//                                     edges and cirrus over bright surfaces.
//                                     Including it consistently produced
//                                     scenes where field_masked = 0% but
//                                     mean NDVI ≈ 0 (cloud reflectance).
//                                     The cost is a few % fewer valid pixels
//                                     near field boundaries on partly-cloudy
//                                     scenes — well worth it.
//   8  cloud_medium_probability
//   9  cloud_high_probability
//   10 thin_cirrus
//   11 snow
//
// We wrap the NDVI computation in `where(SCL_OK, NDVI, NODATA)` so cloud,
// shadow, water and snow pixels never enter the per-field mean (or the
// rendered raster). The sentinel value is -9999 paired with `nodata=-9999`
// so titiler treats those pixels as transparent (raster) and excludes
// them from `valid_count` (statistics).
//
// Numexpr operator precedence: `&`/`|` are bitwise, lower than comparison
// ops (`==`, `!=`), so the parenthesisation here is not strictly required
// but it keeps the URL-encoded version readable when debugging.
const NDVI_NODATA_SENTINEL = "-9999";
const NDVI_EXPRESSION_MASKED =
  "where((SCL==4)|(SCL==5),(B08-B04)/(B08+B04)," + NDVI_NODATA_SENTINEL + ")";
// Unmasked fallback — exposed via opts so callers can opt out of the SCL
// gate (e.g. for diagnostics or for collections without an SCL band).
const NDVI_EXPRESSION_RAW = "(B08-B04)/(B08+B04)";

const NDVI_DEFAULT_RESCALE = "0.0,0.9";
const NDVI_DEFAULT_COLORMAP = "rdylgn";

const SPECTRAL_TILE_CONFIG = {
  ndvi: {
    assets: ["B04", "B08"],
    expressionMasked: NDVI_EXPRESSION_MASKED,
    expressionRaw: NDVI_EXPRESSION_RAW,
    rescale: NDVI_DEFAULT_RESCALE,
    colormap: NDVI_DEFAULT_COLORMAP,
  },
  evi: {
    assets: ["B02", "B04", "B08"],
    expressionMasked: "where((SCL==4)|(SCL==5),2.5*(B08-B04)/(B08+6*B04-7.5*B02+10000)," + NDVI_NODATA_SENTINEL + ")",
    expressionRaw: "2.5*(B08-B04)/(B08+6*B04-7.5*B02+10000)",
    rescale: "0.0,0.8",
    colormap: "rdylgn",
  },
  ndwi: {
    assets: ["B03", "B08"],
    expressionMasked: "where((SCL==4)|(SCL==5),(B03-B08)/(B03+B08)," + NDVI_NODATA_SENTINEL + ")",
    expressionRaw: "(B03-B08)/(B03+B08)",
    rescale: "-0.6,0.5",
    colormap: "brbg",
  },
  ndmi: {
    assets: ["B08", "B11"],
    expressionMasked: "where((SCL==4)|(SCL==5),(B08-B11)/(B08+B11)," + NDVI_NODATA_SENTINEL + ")",
    expressionRaw: "(B08-B11)/(B08+B11)",
    rescale: "-0.5,0.6",
    colormap: "brbg",
  },
  ndre: {
    assets: ["B05", "B8A"],
    expressionMasked: "where((SCL==4)|(SCL==5),(B8A-B05)/(B8A+B05)," + NDVI_NODATA_SENTINEL + ")",
    expressionRaw: "(B8A-B05)/(B8A+B05)",
    rescale: "0.0,0.55",
    colormap: "rdylgn",
  },
  savi: {
    assets: ["B04", "B08"],
    expressionMasked: "where((SCL==4)|(SCL==5),1.5*(B08-B04)/(B08+B04+5000)," + NDVI_NODATA_SENTINEL + ")",
    expressionRaw: "1.5*(B08-B04)/(B08+B04+5000)",
    rescale: "0.0,0.8",
    colormap: "rdylgn",
  },
  nbr: {
    assets: ["B08", "B12"],
    expressionMasked: "where((SCL==4)|(SCL==5),(B08-B12)/(B08+B12)," + NDVI_NODATA_SENTINEL + ")",
    expressionRaw: "(B08-B12)/(B08+B12)",
    rescale: "-0.2,0.8",
    colormap: "rdylgn",
  },
};

function spectralTileConfig(index) {
  return SPECTRAL_TILE_CONFIG[String(index || "ndvi").toLowerCase()] || SPECTRAL_TILE_CONFIG.ndvi;
}

function authHeaders(extra) {
  const h = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...(extra || {}),
  };
  if (SUBSCRIPTION_KEY) {
    h["Ocp-Apim-Subscription-Key"] = SUBSCRIPTION_KEY;
  }
  return h;
}

async function fetchWithTimeout(url, init = {}, ms = UPSTREAM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Compute the [minLng, minLat, maxLng, maxLat] bounding box of a closed
 * ring of `{ lat, lng }` points. Returns null for empty/invalid input.
 */
export function bboxOfRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    const lng = Number(p?.lng);
    const lat = Number(p?.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

/** Convert a closed `{ lat, lng }` ring to a GeoJSON Feature (Polygon). */
export function ringToGeoJsonFeature(ring, properties = {}) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const coords = ring.map((p) => [Number(p.lng), Number(p.lat)]);
  // Ensure closed ring (GeoJSON requires first == last for polygons).
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [coords] },
    properties: { ...properties },
  };
}

/**
 * Search the MPC STAC catalog for Sentinel-2 L2A scenes. Returns the raw
 * STAC items (not paginated — we cap at `limit`). We sort by datetime
 * descending so the newest scenes come first.
 *
 * The MPC instance honours both `bbox` (4-tuple) and `intersects`
 * (GeoJSON geometry); bbox is fine for our use because field bboxes are
 * tiny relative to a Sentinel-2 tile. We also push `eo:cloud_cover` /
 * `s2:nodata_pixel_percentage` filters down so we don't waste a round
 * trip computing stats for cloud-saturated scenes.
 */
export async function searchSentinel2Scenes({
  bbox,
  startDate,
  endDate,
  maxCloudCover = 60,
  limit = 80,
} = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    throw new Error("searchSentinel2Scenes: invalid bbox");
  }
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error("searchSentinel2Scenes: invalid startDate");
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new Error("searchSentinel2Scenes: invalid endDate");
  }
  const datetime = `${start.toISOString()}/${end.toISOString()}`;

  const body = {
    collections: [SENTINEL2_COLLECTION],
    bbox,
    datetime,
    limit: Math.min(1000, Math.max(1, Math.round(limit))),
    "filter-lang": "cql2-json",
    filter: {
      op: "and",
      args: [
        {
          op: "<=",
          args: [{ property: "eo:cloud_cover" }, Math.max(0, Math.min(100, maxCloudCover))],
        },
      ],
    },
    sortby: [{ field: "properties.datetime", direction: "desc" }],
  };

  const res = await fetchWithTimeout(
    `${STAC_API}/search`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    },
    UPSTREAM_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MPC STAC search failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.features) ? json.features : [];
}

/**
 * Compute NDVI statistics for one Sentinel-2 item over a GeoJSON polygon.
 *
 * Workaround (Apr 2026): MPC's titiler `/item/statistics` POST endpoint
 * returns 500 Internal Server Error for all Sentinel-2 items from mid-2025
 * onward — a server-side regression, not anything in our request. The GET
 * (whole-tile) endpoint still works, as do `/item/crop` and `/item/tiles`.
 *
 * Strategy: POST the field polygon to `/item/crop?format=npy`, which
 * returns a polygon-clipped numpy array of the NDVI values. We parse the
 * binary numpy header, read the raw float values, and compute
 * mean/median/min/max/stddev/valid_count ourselves. SCL masking still
 * works because the `where(SCL==4|SCL==5, NDVI, -9999)` expression
 * evaluates server-side — masked pixels come back as -9999 and we
 * exclude them during aggregation.
 *
 * The `nodata` query parameter is deliberately omitted: passing it
 * alongside the where() expression also triggers the 500 bug. Instead
 * we filter the sentinel value client-side, which is equivalent.
 *
 * Returns an object with shape:
 *   {
 *     mean, min, max, stddev, median,
 *     valid_count, total_count, valid_pct,
 *   }
 * — or `null` if there are zero valid pixels (entirely cloudy / outside
 * the swath).
 */
export async function ndviStatisticsForItem({ collection, itemId, feature, applySclMask = true }) {
  if (!collection || !itemId) {
    throw new Error("ndviStatisticsForItem: collection + itemId required");
  }
  if (!feature || feature.type !== "Feature" || !feature.geometry) {
    throw new Error("ndviStatisticsForItem: GeoJSON Feature required");
  }
  const url = new URL(`${DATA_API}/item/crop`);
  url.searchParams.set("collection", collection);
  url.searchParams.set("item", itemId);
  url.searchParams.append("assets", "B04");
  url.searchParams.append("assets", "B08");
  if (applySclMask) {
    url.searchParams.append("assets", "SCL");
    url.searchParams.set("expression", NDVI_EXPRESSION_MASKED);
  } else {
    url.searchParams.set("expression", NDVI_EXPRESSION_RAW);
  }
  url.searchParams.set("asset_as_band", "true");
  url.searchParams.set("resampling", "nearest");
  url.searchParams.set("max_size", "1024");
  url.searchParams.set("format", "npy");

  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(feature),
    },
    STATISTICS_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MPC titiler crop failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return statsFromNumpyBuffer(buf, Number(NDVI_NODATA_SENTINEL));
}

/**
 * Parse a numpy `.npy` buffer and compute descriptive statistics,
 * excluding pixels whose value equals `nodata` (the SCL-mask sentinel).
 *
 * Supports numpy format v1 and v2 with little-endian float32 or float64.
 *
 * Titiler's crop endpoint returns shape `(bands, height, width)` where
 * band 0 is the expression result and band 1 is a validity mask. We
 * only iterate band 0 (the first `h*w` elements).
 */
function statsFromNumpyBuffer(buf, nodata) {
  if (!buf || buf.length < 12) return null;
  const major = buf[6];
  let headerLen, dataStart;
  if (major <= 1) {
    headerLen = buf.readUInt16LE(8);
    dataStart = 10 + headerLen;
  } else {
    headerLen = buf.readUInt32LE(8);
    dataStart = 12 + headerLen;
  }
  const header = buf.toString("ascii", major <= 1 ? 10 : 12, dataStart);
  const descrMatch = header.match(/'descr'\s*:\s*'([^']+)'/);
  const shapeMatch = header.match(/'shape'\s*:\s*\(([^)]+)\)/);
  const dtype = descrMatch?.[1] || "<f8";
  const dims = (shapeMatch?.[1] || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  if (!dims.length) return null;

  // Shape is (bands, h, w) or (h, w). Only read band 0.
  const pixelsPerBand =
    dims.length === 3 ? dims[1] * dims[2] : dims.reduce((a, b) => a * b, 1);
  if (pixelsPerBand === 0) return null;

  const is32 = dtype.includes("f4");
  const bytesPerElement = is32 ? 4 : 8;
  const readFn = is32 ? "readFloatLE" : "readDoubleLE";

  let validCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const vals = [];
  for (let i = 0; i < pixelsPerBand; i++) {
    const offset = dataStart + i * bytesPerElement;
    if (offset + bytesPerElement > buf.length) break;
    const v = buf[readFn](offset);
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v - nodata) < 1) continue;
    if (v < -1 || v > 1) continue;
    validCount += 1;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    vals.push(v);
  }
  if (validCount === 0) return null;
  const mean = sum / validCount;
  vals.sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / validCount;
  return {
    mean: clampNdvi(mean),
    min: clampNdvi(min),
    max: clampNdvi(max),
    stddev: Math.sqrt(variance),
    median: clampNdvi(median),
    valid_count: validCount,
    total_count: pixelsPerBand,
    valid_pct: (validCount / pixelsPerBand) * 100,
  };
}

/**
 * Fetch raw Sentinel-2 bands for a scene×field and compute NDVI, EVI,
 * NDWI, NDMI, NDRE, SAVI, and NBR in one pass. Returns:
 *   { ndvi: {mean,min,max,stddev,median,valid_count,total_count,valid_pct},
 *     evi: {mean}, ndwi: {mean}, ndmi: {mean}, ndre: {mean}, savi: {mean}, nbr: {mean} }
 * or null if zero valid pixels.
 *
 * We request all bands WITHOUT an expression so titiler returns a
 * (9, h, w) numpy array where band order matches the `assets` order.
 * SCL masking is applied client-side: only pixels where SCL ∈ {4,5}
 * (vegetation, not-vegetated) are included.
 */
export async function multiIndexStatisticsForItem({ collection, itemId, feature }) {
  if (!collection || !itemId) throw new Error("multiIndexStatisticsForItem: collection + itemId required");
  if (!feature?.geometry) throw new Error("multiIndexStatisticsForItem: GeoJSON Feature required");

  const url = new URL(`${DATA_API}/item/crop`);
  url.searchParams.set("collection", collection);
  url.searchParams.set("item", itemId);
  for (const band of ["B02", "B03", "B04", "B05", "B08", "B8A", "B11", "B12", "SCL"]) {
    url.searchParams.append("assets", band);
  }
  url.searchParams.set("asset_as_band", "true");
  url.searchParams.set("resampling", "nearest");
  url.searchParams.set("max_size", "512");
  url.searchParams.set("format", "npy");

  const res = await fetchWithTimeout(
    url.toString(),
    { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(feature) },
    STATISTICS_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MPC multi-index crop failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return multiIndexFromNumpyBuffer(buf);
}

/**
 * Parse a multi-band (9, h, w) numpy array and compute per-index stats.
 * Band order: [B02, B03, B04, B05, B08, B8A, B11, B12, SCL].
 * Only pixels where SCL ∈ {4,5} are used.
 */
function multiIndexFromNumpyBuffer(buf) {
  if (!buf || buf.length < 12) return null;
  const major = buf[6];
  let headerLen, dataStart;
  if (major <= 1) {
    headerLen = buf.readUInt16LE(8);
    dataStart = 10 + headerLen;
  } else {
    headerLen = buf.readUInt32LE(8);
    dataStart = 12 + headerLen;
  }
  const headerStr = buf.slice(major <= 1 ? 10 : 12, dataStart).toString("latin1");
  const shapeMatch = headerStr.match(/'shape'\s*:\s*\(([^)]+)\)/);
  const dtypeMatch = headerStr.match(/'descr'\s*:\s*'([^']+)'/);
  if (!shapeMatch || !dtypeMatch) return null;

  const dtype = dtypeMatch[1];
  const littleEndian = dtype.startsWith("<") || dtype.startsWith("|");
  const kind = dtype.replace(/[<>=|]/g, "").slice(0, 1);
  const byteSize = Number(dtype.match(/(\d+)$/)?.[1] || 0);
  const bytesPerElem = byteSize || (dtype === "float32" ? 4 : dtype === "float64" ? 8 : 0);
  if (![1, 2, 4, 8].includes(bytesPerElem)) return null;
  const readFn = (() => {
    if (dtype === "float32" || dtype.endsWith("f4")) return (o) => buf.readFloatLE(o);
    if (dtype === "float64" || dtype.endsWith("f8")) return (o) => buf.readDoubleLE(o);
    if (kind === "u") {
      if (bytesPerElem === 1) return (o) => buf.readUInt8(o);
      if (bytesPerElem === 2) return (o) => littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
      if (bytesPerElem === 4) return (o) => littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    }
    if (kind === "i") {
      if (bytesPerElem === 1) return (o) => buf.readInt8(o);
      if (bytesPerElem === 2) return (o) => littleEndian ? buf.readInt16LE(o) : buf.readInt16BE(o);
      if (bytesPerElem === 4) return (o) => littleEndian ? buf.readInt32LE(o) : buf.readInt32BE(o);
    }
    return null;
  })();
  if (!readFn) return null;

  const dims = shapeMatch[1].split(",").map((s) => parseInt(s.trim(), 10));
  let bands, h, w;
  if (dims.length === 3) { [bands, h, w] = dims; }
  else if (dims.length === 2) { bands = 1; [h, w] = dims; }
  else return null;

  if (bands < 9) return null;
  const pixels = h * w;

  const ndviVals = [];
  const eviVals = [];
  const ndwiVals = [];
  const ndmiVals = [];
  const ndreVals = [];
  const saviVals = [];
  const nbrVals = [];

  for (let i = 0; i < pixels; i++) {
    const sclOffset = dataStart + (8 * pixels + i) * bytesPerElem;
    const scl = Math.round(readFn(sclOffset));
    if (scl !== 4 && scl !== 5) continue;

    const b02 = readFn(dataStart + (0 * pixels + i) * bytesPerElem);
    const b03 = readFn(dataStart + (1 * pixels + i) * bytesPerElem);
    const b04 = readFn(dataStart + (2 * pixels + i) * bytesPerElem);
    const b05 = readFn(dataStart + (3 * pixels + i) * bytesPerElem);
    const b08 = readFn(dataStart + (4 * pixels + i) * bytesPerElem);
    const b8a = readFn(dataStart + (5 * pixels + i) * bytesPerElem);
    const b11 = readFn(dataStart + (6 * pixels + i) * bytesPerElem);
    const b12 = readFn(dataStart + (7 * pixels + i) * bytesPerElem);

    if (!Number.isFinite(b04) || !Number.isFinite(b08)) continue;

    // NDVI = (NIR - Red) / (NIR + Red)
    const nirRed = b08 + b04;
    if (nirRed !== 0) ndviVals.push((b08 - b04) / nirRed);

    // EVI = 2.5 * (NIR - Red) / (NIR + 6*Red - 7.5*Blue + 1)
    // Sentinel-2 L2A reflectance is scaled 0..10000
    const eviDenom = b08 + 6 * b04 - 7.5 * b02 + 10000;
    if (eviDenom !== 0) {
      const evi = 2.5 * (b08 - b04) / eviDenom;
      if (Number.isFinite(evi) && evi >= -1 && evi <= 1) eviVals.push(evi);
    }

    // NDWI (McFeeters green variant) = (Green - NIR) / (Green + NIR)
    const gNir = b03 + b08;
    if (gNir !== 0) {
      const ndwi = (b03 - b08) / gNir;
      if (Number.isFinite(ndwi)) ndwiVals.push(ndwi);
    }

    // NDMI = (NIR_narrow - SWIR) / (NIR_narrow + SWIR)
    if (Number.isFinite(b8a) && Number.isFinite(b11)) {
      const ms = b8a + b11;
      if (ms !== 0) {
        const ndmi = (b8a - b11) / ms;
        if (Number.isFinite(ndmi)) ndmiVals.push(ndmi);
      }
    }

    // NDRE = (Red-edge NIR - Red edge 1) / (Red-edge NIR + Red edge 1)
    // Useful for chlorophyll/N stress after NDVI begins to saturate.
    if (Number.isFinite(b8a) && Number.isFinite(b05)) {
      const redEdge = b8a + b05;
      if (redEdge !== 0) {
        const ndre = (b8a - b05) / redEdge;
        if (Number.isFinite(ndre)) ndreVals.push(ndre);
      }
    }

    // SAVI with L=0.5, more stable than NDVI over sparse crop/bare soil.
    const saviDenom = b08 + b04 + 5000;
    if (saviDenom !== 0) {
      const savi = 1.5 * (b08 - b04) / saviDenom;
      if (Number.isFinite(savi) && savi >= -1 && savi <= 1) saviVals.push(savi);
    }

    // NBR = (NIR - SWIR2) / (NIR + SWIR2), helpful for residue/exposure/damage.
    if (Number.isFinite(b12)) {
      const nbrDenom = b08 + b12;
      if (nbrDenom !== 0) {
        const nbr = (b08 - b12) / nbrDenom;
        if (Number.isFinite(nbr)) nbrVals.push(nbr);
      }
    }
  }

  if (!ndviVals.length) return null;

  const computeStats = (arr) => {
    if (!arr.length) return { mean: null };
    arr.sort((a, b) => a - b);
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / arr.length;
    const mid = Math.floor(arr.length / 2);
    const median = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    let variance = 0;
    for (const v of arr) variance += (v - mean) ** 2;
    const stddev = Math.sqrt(variance / arr.length);
    return {
      mean, median, min: arr[0], max: arr[arr.length - 1],
      stddev, valid_count: arr.length, total_count: pixels,
      valid_pct: (arr.length / pixels) * 100,
    };
  };

  return {
    ndvi: computeStats(ndviVals),
    evi: { mean: eviVals.length ? eviVals.reduce((a, b) => a + b, 0) / eviVals.length : null },
    ndwi: { mean: ndwiVals.length ? ndwiVals.reduce((a, b) => a + b, 0) / ndwiVals.length : null },
    ndmi: { mean: ndmiVals.length ? ndmiVals.reduce((a, b) => a + b, 0) / ndmiVals.length : null },
    ndre: { mean: ndreVals.length ? ndreVals.reduce((a, b) => a + b, 0) / ndreVals.length : null },
    savi: { mean: saviVals.length ? saviVals.reduce((a, b) => a + b, 0) / saviVals.length : null },
    nbr: { mean: nbrVals.length ? nbrVals.reduce((a, b) => a + b, 0) / nbrVals.length : null },
  };
}

/**
 * Build the URL for a single PNG NDVI tile rendered by MPC's titiler.
 *
 * Tile is in EPSG:3857 (`WebMercatorQuad`), 256×256 PNG, with a
 * red→yellow→green colour map clamped to NDVI [0.0, 0.9]. We pin the
 * rescale range across all tiles so the workspace's per-field colour
 * legend is consistent year-round.
 *
 * Cloud / shadow / water / snow pixels are masked out via SCL and
 * rendered transparent (so the satellite basemap shows through),
 * matching the masking applied in `ndviStatisticsForItem` so the tile
 * and the per-field mean tell the same story.
 *
 * @returns string URL — the proxy in server.mjs fetches it and forwards
 *          the bytes to the browser, so we don't need to bake a SAS
 *          token into anything client-side.
 */
export function buildSpectralIndexTileUrl({ collection, itemId, z, x, y, index = "ndvi", opts = {} }) {
  if (!collection || !itemId) {
    throw new Error("buildSpectralIndexTileUrl: collection + itemId required");
  }
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("buildSpectralIndexTileUrl: invalid z/x/y");
  }
  const cfg = spectralTileConfig(index);
  const applySclMask = opts.applySclMask !== false;
  const params = new URLSearchParams();
  params.set("collection", collection);
  params.set("item", itemId);
  for (const asset of cfg.assets) params.append("assets", asset);
  if (applySclMask) {
    params.append("assets", "SCL");
    params.set("expression", opts.expression || cfg.expressionMasked);
    // `nodata` parameter deliberately omitted: MPC's titiler (as of
    // Apr 2026) returns 500 Internal Server Error for all 2025+
    // Sentinel-2 items when `nodata=-9999` is present. Without it,
    // masked pixels (-9999) fall outside the rescale range and render
    // transparent via the colormap — visually identical.
  } else {
    params.set("expression", opts.expression || cfg.expressionRaw);
  }
  params.set("asset_as_band", "true");
  params.set("rescale", opts.rescale || cfg.rescale);
  params.set("colormap_name", opts.colormap || cfg.colormap);
  params.set("resampling", opts.resampling || "bilinear");
  return `${DATA_API}/item/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?${params.toString()}`;
}

export function buildNdviTileUrl(args) {
  return buildSpectralIndexTileUrl({ ...args, index: "ndvi" });
}

/** Build an MPC titiler tile URL for true-colour Sentinel-2 visualisation. */
export function buildTrueColorTileUrl({ collection, itemId, z, x, y }) {
  const params = new URLSearchParams();
  params.set("collection", collection);
  params.set("item", itemId);
  params.set("assets", "B04");
  params.append("assets", "B03");
  params.append("assets", "B02");
  // S2 surface reflectance is scaled 0..10000; rescale per band into 0..255.
  params.set("rescale", "0,3000");
  return `${DATA_API}/item/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?${params.toString()}`;
}

function clampNdvi(v) {
  if (!Number.isFinite(v)) return null;
  if (v > 1) return 1;
  if (v < -1) return -1;
  return v;
}

export const sentinel2 = {
  collection: SENTINEL2_COLLECTION,
};

// Exported so server.mjs and workspace tile URLs can use the same
// defaults without re-declaring them.
export const ndviRender = {
  defaultRescale: NDVI_DEFAULT_RESCALE,
  defaultColormap: NDVI_DEFAULT_COLORMAP,
  expressionMasked: NDVI_EXPRESSION_MASKED,
  expressionRaw: NDVI_EXPRESSION_RAW,
  nodataSentinel: NDVI_NODATA_SENTINEL,
  spectralTileConfig,
};

export function mpcConfigSummary() {
  return {
    stacApi: STAC_API,
    dataApi: DATA_API,
    sasApi: SAS_API,
    hasSubscriptionKey: Boolean(SUBSCRIPTION_KEY),
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    statisticsTimeoutMs: STATISTICS_TIMEOUT_MS,
  };
}

/**
 * Proxy a single titiler tile through to the caller, returning the raw
 * bytes + content-type. Used by the `/api/sentinel/...` route in
 * server.mjs so the browser sees same-origin URLs and we can layer
 * caching on top of MPC.
 */
export async function fetchTitilerTile(url) {
  const res = await fetchWithTimeout(
    url,
    { headers: authHeaders({ Accept: "image/png,image/*;q=0.9,*/*;q=0.5" }) },
    UPSTREAM_TIMEOUT_MS
  );
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) {
    const text = contentType.includes("text") || contentType.includes("xml")
      ? (await res.text().catch(() => "")).slice(0, 240)
      : "";
    return { ok: false, status: res.status, contentType, text };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status, contentType, body: buf };
}

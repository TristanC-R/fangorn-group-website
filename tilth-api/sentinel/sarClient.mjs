/**
 * Microsoft Planetary Computer — Sentinel-1 RTC client.
 *
 * Sentinel-1 RTC (Radiometric Terrain Corrected) is a cloud-piercing
 * synthetic-aperture radar product, ideal for the UK climate where
 * Sentinel-2 is regularly cloud-blocked. Each scene gives us two
 * polarisations:
 *
 *   - VV — vertically-transmitted, vertically-received backscatter.
 *          Sensitive to surface roughness and dielectric (wet vs dry).
 *   - VH — vertically-transmitted, horizontally-received backscatter
 *          (cross-pol). Sensitive to vegetation volume; the headline
 *          band for crop biomass / canopy structure monitoring.
 *
 * Values come back as **linear power**, NOT decibels. Convert to dB
 * for human interpretation: `db = 10 * log10(linear)`. We store both
 * forms (linear stays as the source of truth; dB is a derived view).
 *
 * Mirrors the shape of `mpcClient.mjs` (NDVI) so the two pipelines
 * compose cleanly. Shared helpers (bbox, ringToGeoJson) are imported
 * to avoid duplication.
 *
 * Auth, headers and timeouts are intentionally duplicated for now —
 * once SAR is stable we'll lift the HTTP plumbing into a shared
 * `mpcCore.mjs`.
 *
 * Docs:
 *   https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc
 *   https://sentinels.copernicus.eu/web/sentinel/user-guides/sentinel-1-sar
 */

import { bboxOfRing, ringToGeoJsonFeature } from "./mpcClient.mjs";

const STAC_API = (
  process.env.MPC_STAC_API_URL ||
  "https://planetarycomputer.microsoft.com/api/stac/v1"
).replace(/\/$/, "");
const DATA_API = (
  process.env.MPC_DATA_API_URL ||
  "https://planetarycomputer.microsoft.com/api/data/v1"
).replace(/\/$/, "");
const SUBSCRIPTION_KEY = (process.env.MPC_SUBSCRIPTION_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.MPC_TIMEOUT_MS || 25_000)
);
const STATISTICS_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.MPC_STATISTICS_TIMEOUT_MS || 45_000)
);
const USER_AGENT =
  (process.env.MPC_USER_AGENT || "").trim() ||
  `FangornTilth/1.0 (+sentinel-1 sar; ${(process.env.OSM_CONTACT_EMAIL || "no-contact").trim()})`;

const SENTINEL1_COLLECTION = "sentinel-1-rtc";

// Default tile rendering ranges (dB) for each band the workspace can
// visualise. VH is the headline biomass band; VV is sensitive to soil
// roughness and moisture; the VH/VV ratio (in dB, equivalent to
// VH_db − VV_db) separates vegetation from bare/wet surfaces independent
// of total backscatter intensity. Ranges are tuned for UK arable.
//
//   VH:    -25..-5  dB  (open water → forest)
//   VV:    -20..0   dB  (smooth water → buildings / rough soil)
//   ratio: -15..-3  dB  (bare / wet → dense crop canopy)
const SAR_BAND_DEFAULTS = {
  vh: { rescale: "-25,-5", colormap: "viridis" },
  vv: { rescale: "-20,0", colormap: "magma" },
  ratio: { rescale: "-15,-3", colormap: "viridis" },
};
const VH_DEFAULT_RESCALE_DB = SAR_BAND_DEFAULTS.vh.rescale;
const VH_DEFAULT_COLORMAP = SAR_BAND_DEFAULTS.vh.colormap;

// Convert linear power to dB. Caller responsible for filtering 0/null.
function linearToDb(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  return 10 * Math.log10(v);
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
 * Search MPC's STAC for Sentinel-1 RTC scenes intersecting `bbox`
 * within [`startDate`, `endDate`]. SAR has no cloud filter — that's
 * the whole point.
 */
export async function searchSentinel1Scenes({
  bbox,
  startDate,
  endDate,
  limit = 80,
} = {}) {
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some((n) => !Number.isFinite(n))
  ) {
    throw new Error("searchSentinel1Scenes: invalid bbox");
  }
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  const datetime = `${start.toISOString()}/${end.toISOString()}`;

  const body = {
    collections: [SENTINEL1_COLLECTION],
    bbox,
    datetime,
    limit: Math.min(1000, Math.max(1, Math.round(limit))),
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
    throw new Error(
      `MPC STAC SAR search failed (${res.status}): ${text.slice(0, 240)}`
    );
  }
  const json = await res.json();
  return Array.isArray(json?.features) ? json.features : [];
}

/**
 * Compute VV and VH backscatter statistics for one Sentinel-1 RTC
 * item over a GeoJSON polygon.
 *
 * Workaround (Apr 2026): MPC's `/item/statistics` POST returns 500
 * for all recent items. We use `/item/crop?format=npy` instead and
 * compute the stats ourselves from the raw float32 pixel data. Same
 * approach as the NDVI workaround in mpcClient.mjs.
 *
 * We request each band separately so we can parse the numpy arrays
 * independently (multi-asset crop returns a multi-band array whose
 * band ordering depends on titiler internals).
 *
 * Returns:
 *   {
 *     vv: { mean, min, max, stddev, median, valid_count, total_count, mean_db },
 *     vh: { ... },
 *     vh_vv_ratio_mean,        // VH/VV in linear space
 *     vh_vv_ratio_mean_db,     // 10*log10(VH/VV) ≈ VH_db - VV_db
 *   }
 *
 * Or `null` if titiler reports zero valid pixels.
 */
export async function sarStatisticsForItem({ collection, itemId, feature }) {
  if (!collection || !itemId) {
    throw new Error("sarStatisticsForItem: collection + itemId required");
  }
  if (!feature || feature.type !== "Feature" || !feature.geometry) {
    throw new Error("sarStatisticsForItem: GeoJSON Feature required");
  }

  async function fetchBand(assetName) {
    const url = new URL(`${DATA_API}/item/crop`);
    url.searchParams.set("collection", collection);
    url.searchParams.set("item", itemId);
    url.searchParams.append("assets", assetName);
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
      throw new Error(
        `MPC titiler SAR crop failed for ${assetName} (${res.status}): ${text.slice(0, 240)}`
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const [vvBuf, vhBuf] = await Promise.all([
    fetchBand("vv"),
    fetchBand("vh"),
  ]);

  const vv = sarStatsFromNpy(vvBuf);
  const vh = sarStatsFromNpy(vhBuf);
  if (!vv && !vh) return null;

  let vh_vv_ratio_mean = null;
  let vh_vv_ratio_mean_db = null;
  if (vv && vh && Number.isFinite(vv.mean) && vv.mean > 0 && Number.isFinite(vh.mean)) {
    vh_vv_ratio_mean = vh.mean / vv.mean;
    vh_vv_ratio_mean_db = linearToDb(vh_vv_ratio_mean);
  }

  return { vv, vh, vh_vv_ratio_mean, vh_vv_ratio_mean_db };
}

/**
 * Parse a single-band numpy `.npy` buffer of SAR linear-power values
 * and compute descriptive statistics. Invalid pixels (≤ 0, NaN, Inf)
 * are excluded.
 */
function sarStatsFromNpy(buf) {
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
  const dtype = descrMatch?.[1] || "<f4";
  const dims = (shapeMatch?.[1] || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  if (!dims.length) return null;

  // Shape may be (bands, h, w) — only read band 0.
  const pixelsPerBand =
    dims.length === 3 ? dims[1] * dims[2] : dims.reduce((a, b) => a * b, 1);
  if (pixelsPerBand === 0) return null;

  const is32 = dtype.includes("f4") || !dtype.includes("f8");
  const bpe = is32 ? 4 : 8;
  const readFn = is32 ? "readFloatLE" : "readDoubleLE";

  let validCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const vals = [];
  for (let i = 0; i < pixelsPerBand; i++) {
    const offset = dataStart + i * bpe;
    if (offset + bpe > buf.length) break;
    const v = buf[readFn](offset);
    if (!Number.isFinite(v) || v <= 0) continue;
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
    mean,
    min,
    max,
    stddev: Math.sqrt(variance),
    median,
    valid_count: validCount,
    total_count: pixelsPerBand,
    mean_db: linearToDb(mean),
    median_db: linearToDb(median),
  };
}

/**
 * Build a titiler tile URL for SAR backscatter visualisation.
 *
 * `band` selects the polarisation visualised:
 *   - "vh"    — cross-pol VH in dB (default; vegetation volume)
 *   - "vv"    — co-pol VV in dB (surface roughness / soil moisture)
 *   - "ratio" — 10·log10(VH/VV) in dB (vegetation structure index)
 *
 * The `+1e-10` bias inside the log expression avoids titiler painting
 * `-∞` for nodata pixels (linear 0). Pixels actually outside the
 * scene boundary are still returned transparent by titiler.
 */
export function buildSarTileUrl({
  collection,
  itemId,
  band = "vh",
  z,
  x,
  y,
  opts = {},
} = {}) {
  if (!collection || !itemId) {
    throw new Error("buildSarTileUrl: collection + itemId required");
  }
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("buildSarTileUrl: invalid z/x/y");
  }
  const which = String(band).toLowerCase();
  const defaults = SAR_BAND_DEFAULTS[which] || SAR_BAND_DEFAULTS.vh;

  const params = new URLSearchParams();
  params.set("collection", collection);
  params.set("item", itemId);

  let expression;
  if (which === "vv") {
    params.append("assets", "vv");
    expression = opts.expression || "10*log10(vv+1e-10)";
  } else if (which === "ratio") {
    params.append("assets", "vh");
    params.append("assets", "vv");
    // VH/VV ratio in dB ≡ VH_db - VV_db. Computing the ratio first
    // avoids a divide-by-zero blow-up: linear vv can equal 0 and we
    // need it to fall through to nodata, not -∞.
    expression = opts.expression || "10*log10((vh+1e-10)/(vv+1e-10))";
  } else {
    params.append("assets", "vh");
    expression = opts.expression || "10*log10(vh+1e-10)";
  }

  params.set("expression", expression);
  params.set("asset_as_band", "true");
  params.set("rescale", opts.rescale || defaults.rescale);
  params.set("colormap_name", opts.colormap || defaults.colormap);
  params.set("resampling", opts.resampling || "bilinear");
  return `${DATA_API}/item/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?${params.toString()}`;
}

// Back-compat alias — older code paths may still call buildVhTileUrl.
export function buildVhTileUrl(args) {
  return buildSarTileUrl({ ...args, band: "vh" });
}

export const sentinel1 = {
  collection: SENTINEL1_COLLECTION,
};

export const sarRender = {
  vhDefaultRescaleDb: VH_DEFAULT_RESCALE_DB,
  vhDefaultColormap: VH_DEFAULT_COLORMAP,
  bands: { ...SAR_BAND_DEFAULTS },
};

// Re-export shared helpers so the SAR ingest can import them from a
// single module without reaching back into mpcClient.
export { bboxOfRing, ringToGeoJsonFeature };

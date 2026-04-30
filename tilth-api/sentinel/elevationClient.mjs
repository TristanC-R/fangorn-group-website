/**
 * Microsoft Planetary Computer — Copernicus DEM 30 m client.
 *
 * The Copernicus DEM GLO-30 is a 30 m global elevation model derived
 * from TanDEM-X SAR interferometry. Unlike Sentinel-2/1 it is a static
 * mosaic — one coverage per location, not a time series.
 *
 * We use the same `/item/crop?format=npy` approach as Sentinel-2/1 to
 * avoid the broken `/item/statistics` endpoint on MPC.
 *
 * From the raw elevation raster we compute per-field:
 *   - Elevation stats (mean, min, max, range, stddev, median)
 *   - Slope (degrees) via finite differences on the DEM grid
 *   - Aspect (degrees from north, 0-360)
 *   - TWI — simplified Topographic Wetness Index ≈ ln(A / tan(slope))
 *     where A is approximated as cell area (30 m²) since we don't have
 *     full flow accumulation data.
 *
 * Docs:
 *   https://planetarycomputer.microsoft.com/dataset/cop-dem-glo-30
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
  Number(process.env.MPC_STATISTICS_TIMEOUT_MS || 60_000)
);
const USER_AGENT =
  (process.env.MPC_USER_AGENT || "").trim() ||
  `FangornTilth/1.0 (+cop-dem; ${(process.env.OSM_CONTACT_EMAIL || "no-contact").trim()})`;

const DEM_COLLECTION = "cop-dem-glo-30";
const CELL_SIZE_M = 30;

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
 * Search MPC STAC for Copernicus DEM tiles intersecting `bbox`.
 * Returns STAC feature array.
 */
export async function searchDemTiles({ bbox, limit = 10 } = {}) {
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some((n) => !Number.isFinite(n))
  ) {
    throw new Error("searchDemTiles: invalid bbox");
  }
  const body = {
    collections: [DEM_COLLECTION],
    bbox,
    limit: Math.min(100, Math.max(1, Math.round(limit))),
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
      `MPC STAC DEM search failed (${res.status}): ${text.slice(0, 240)}`
    );
  }
  const json = await res.json();
  return Array.isArray(json?.features) ? json.features : [];
}

/**
 * Fetch the raw DEM raster for a field polygon from one STAC item.
 * Returns a Node.js Buffer (numpy .npy format).
 */
async function fetchDemCrop({ collection, itemId, feature }) {
  const url = new URL(`${DATA_API}/item/crop`);
  url.searchParams.set("collection", collection);
  url.searchParams.set("item", itemId);
  url.searchParams.append("assets", "data");
  url.searchParams.set("resampling", "bilinear");
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
      `MPC DEM crop failed (${res.status}): ${text.slice(0, 240)}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Parse a single-band numpy .npy buffer of elevation values and compute
 * elevation stats + slope/aspect/TWI derivatives.
 */
function elevationStatsFromNpy(buf) {
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

  let h, w;
  if (dims.length === 3) {
    [, h, w] = dims;
  } else if (dims.length === 2) {
    [h, w] = dims;
  } else {
    return null;
  }
  if (!h || !w) return null;

  const is32 =
    dtype.includes("f4") || dtype.includes("i2") || !dtype.includes("f8");
  const bpe = is32 ? 4 : 8;
  const readFn = is32 ? "readFloatLE" : "readDoubleLE";
  const isInt16 = dtype.includes("i2") || dtype.includes("int16");

  const elev = new Float64Array(h * w);
  let validCount = 0;

  for (let i = 0; i < h * w; i++) {
    const offset = dataStart + i * (isInt16 ? 2 : bpe);
    if (offset + (isInt16 ? 2 : bpe) > buf.length) break;
    let v;
    if (isInt16) {
      v = buf.readInt16LE(offset);
      if (v === -32768 || v === -9999) { elev[i] = NaN; continue; }
    } else {
      v = buf[readFn](offset);
      if (!Number.isFinite(v) || v <= -9999) { elev[i] = NaN; continue; }
    }
    elev[i] = v;
    validCount++;
  }

  if (validCount < 4) return null;

  const elevVals = [];
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < elev.length; i++) {
    if (!Number.isFinite(elev[i]) || Number.isNaN(elev[i])) continue;
    const v = elev[i];
    elevVals.push(v);
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (elevVals.length === 0) return null;
  const mean = sum / elevVals.length;
  elevVals.sort((a, b) => a - b);
  const median = elevVals[Math.floor(elevVals.length / 2)];
  const variance =
    elevVals.reduce((a, v) => a + (v - mean) ** 2, 0) / elevVals.length;
  const stddev = Math.sqrt(variance);

  const slopeDeg = new Float64Array(h * w);
  const aspectDeg = new Float64Array(h * w);
  const slopeVals = [];
  const aspectVals = [];

  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const idx = r * w + c;
      const z = elev[idx];
      if (!Number.isFinite(z)) continue;

      const zN = elev[(r - 1) * w + c];
      const zS = elev[(r + 1) * w + c];
      const zE = elev[r * w + (c + 1)];
      const zW = elev[r * w + (c - 1)];
      if (
        !Number.isFinite(zN) ||
        !Number.isFinite(zS) ||
        !Number.isFinite(zE) ||
        !Number.isFinite(zW)
      )
        continue;

      const dzdx = (zE - zW) / (2 * CELL_SIZE_M);
      const dzdy = (zS - zN) / (2 * CELL_SIZE_M);
      const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      const slopeDegVal = (slopeRad * 180) / Math.PI;
      slopeDeg[idx] = slopeDegVal;
      slopeVals.push(slopeDegVal);

      let asp = (Math.atan2(-dzdy, -dzdx) * 180) / Math.PI;
      if (asp < 0) asp += 360;
      aspectDeg[idx] = asp;
      aspectVals.push(asp);
    }
  }

  let slopeMean = null,
    slopeMax = null,
    slopeStddev = null;
  if (slopeVals.length > 0) {
    slopeMean =
      slopeVals.reduce((a, v) => a + v, 0) / slopeVals.length;
    slopeMax = Math.max(...slopeVals);
    const sv =
      slopeVals.reduce((a, v) => a + (v - slopeMean) ** 2, 0) /
      slopeVals.length;
    slopeStddev = Math.sqrt(sv);
  }

  let aspectMean = null, aspectDominant = null;
  if (aspectVals.length > 0) {
    let sinSum = 0, cosSum = 0;
    for (const a of aspectVals) {
      sinSum += Math.sin((a * Math.PI) / 180);
      cosSum += Math.cos((a * Math.PI) / 180);
    }
    let meanAsp = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
    if (meanAsp < 0) meanAsp += 360;
    aspectMean = meanAsp;
    aspectDominant = compassDirection(meanAsp);
  }

  let twiMean = null, twiMin = null, twiMax = null;
  const twiVals = [];
  const A = CELL_SIZE_M * CELL_SIZE_M;
  for (let i = 0; i < slopeVals.length; i++) {
    const sRad = (slopeVals[i] * Math.PI) / 180;
    const tanS = Math.tan(sRad);
    if (tanS <= 0.001) continue;
    const twi = Math.log(A / tanS);
    if (Number.isFinite(twi)) twiVals.push(twi);
  }
  if (twiVals.length > 0) {
    twiMean = twiVals.reduce((a, v) => a + v, 0) / twiVals.length;
    twiMin = Math.min(...twiVals);
    twiMax = Math.max(...twiVals);
  }

  return {
    elevation: { mean, min, max, range: max - min, stddev, median },
    slope: { mean_deg: slopeMean, max_deg: slopeMax, stddev_deg: slopeStddev },
    aspect: { mean_deg: aspectMean, dominant: aspectDominant },
    twi: { mean: twiMean, min: twiMin, max: twiMax },
    valid_pixel_count: validCount,
    total_pixel_count: h * w,
    grid: { h, w },
  };
}

function compassDirection(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx];
}

/**
 * Full pipeline: search DEM tiles → crop → compute stats + derivatives
 * for one field polygon.
 */
export async function elevationForField({ ring, fieldId, fieldName }) {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new Error("elevationForField: ring must have ≥ 3 vertices");
  }
  const bbox = bboxOfRing(ring);
  if (!bbox) throw new Error("elevationForField: invalid bbox");

  const feature = ringToGeoJsonFeature(ring, {
    field_id: fieldId || "",
    field_name: fieldName || "",
  });
  if (!feature) throw new Error("elevationForField: GeoJSON conversion failed");

  const tiles = await searchDemTiles({ bbox, limit: 4 });
  if (!tiles.length) {
    throw new Error("No Copernicus DEM tiles found for this location");
  }

  let lastError = null;
  for (const tile of tiles) {
    const itemId = tile?.id;
    if (!itemId) continue;
    try {
      const buf = await fetchDemCrop({
        collection: DEM_COLLECTION,
        itemId,
        feature,
      });
      const stats = elevationStatsFromNpy(buf);
      if (stats && stats.valid_pixel_count > 0) {
        return { itemId, collection: DEM_COLLECTION, ...stats };
      }
    } catch (e) {
      lastError = e;
      console.warn(
        `[elevation] tile ${itemId} failed for field ${fieldId}: ${e?.message || e}`
      );
    }
  }

  if (lastError) throw lastError;
  throw new Error("No valid elevation data found in any DEM tile");
}

export const copDem = { collection: DEM_COLLECTION };

export { bboxOfRing, ringToGeoJsonFeature };

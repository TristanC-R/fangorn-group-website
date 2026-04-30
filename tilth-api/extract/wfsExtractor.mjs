/**
 * WFS extraction strategy.
 *
 * For each (field, layer) we:
 *   1. POST a WFS 2.0 GetFeature request with the field's bbox (so the
 *      upstream pre-filters server-side — most Defra typeNames are huge
 *      nationwide layers and we'd time out without a bbox cap).
 *   2. Parse the GeoJSON response.
 *   3. Clip each returned feature to the field polygon (turf.intersect).
 *   4. Stamp `class` + `label` + `color` properties on each feature so the
 *      frontend can render straight from the row without consulting the
 *      legend separately.
 *
 * Returns { features, count, status } — status='partial' if the upstream
 * truncated the result set (we hit the WFS recordCount cap), 'error' on
 * upstream failure, 'ok' otherwise.
 */

import {
  featureCollection,
  intersect,
  polygon as turfPolygon,
  multiPolygon as turfMultiPolygon,
} from "@turf/turf";

import { boundaryToGeoJsonPolygon, lonLatToMeters } from "./geo.mjs";

const WFS_TIMEOUT_MS = Math.max(5000, Number(process.env.TILTH_WFS_TIMEOUT_MS || 25_000));
const WFS_MAX_FEATURES = Math.max(100, Number(process.env.TILTH_WFS_MAX_FEATURES || 5000));

/**
 * Build a stable RGB hex from a class string. Layer swatches are used as
 * "anchor" hues so the palette stays close to the upstream's WMS rendering;
 * if no anchor matches we fall back to a hash-derived hue.
 */
function colorForClass(classKey, swatches = [], idx = 0) {
  if (!classKey) return swatches[0] || "#5a8550";
  if (swatches.length) return swatches[idx % swatches.length];
  // Cheap deterministic hash → HSL → hex.
  let h = 0;
  for (let i = 0; i < classKey.length; i++) {
    h = ((h << 5) - h + classKey.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  const sat = 55;
  const lit = 45;
  return hslToHex(hue, sat, lit);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Convert our boundary { lat, lng } ring into a WFS 2.0 BBOX param.
 *
 * IMPORTANT axis-order quirk: with `urn:ogc:def:crs:EPSG::4326` the OGC
 * mandate is **lat,lon** (north,east), not the lng,lat we use everywhere
 * else. Defra/EA WFS endpoints follow the spec strictly — sending lng,lat
 * silently returns `numberMatched=0` because the bbox lands in the wrong
 * hemisphere.
 *
 * We therefore default to the legacy `EPSG:4326` URN, which Defra/EA
 * happily interpret as lng,lat,lng,lat — same as our internal convention.
 * Callers requesting the urn-style CRS get axes swapped automatically.
 */
function bboxParamFromBoundary(boundary, srs = "urn:ogc:def:crs:EPSG::4326") {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of boundary || []) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  if (!Number.isFinite(minLat)) return null;
  // ~50 m of pad in degrees so the upstream still hits boundary-overlapping
  // features even when the field hugs the dataset edge.
  const latPad = 0.0005;
  const lngPad = 0.0008;
  // urn-style CRS → lat,lon order; URI-style EPSG:4326 → lon,lat order.
  if (typeof srs === "string" && srs.toLowerCase().startsWith("urn:")) {
    return `${minLat - latPad},${minLng - lngPad},${maxLat + latPad},${maxLng + lngPad},${srs}`;
  }
  return `${minLng - lngPad},${minLat - latPad},${maxLng + lngPad},${maxLat + latPad},${srs}`;
}

/**
 * Pull a value from a feature's properties object case-insensitively.
 * Defra WFS sometimes returns lowercased keys; ArcGIS sources keep camel
 * case. We normalise so the EXTRACT_CONFIG.classify reads stay simple.
 */
function readProp(props, name) {
  if (!props || !name) return null;
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(props)) {
    if (k.toLowerCase() === lower) return props[k];
  }
  return null;
}

async function fetchWfs(url, params, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const sep = url.includes("?") ? "&" : "?";
    const full = `${url}${sep}${params.toString()}`;
    const res = await fetch(full, {
      headers: {
        Accept: "application/json,application/geo+json,*/*;q=0.5",
        "User-Agent":
          process.env.WMS_USER_AGENT ||
          `FangornTilth/1.0 (extractor; ${process.env.OSM_CONTACT_EMAIL || "contact missing"})`,
      },
      signal: ctrl.signal,
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      const text = (await res.text()).slice(0, 400);
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    if (!ct.includes("json")) {
      const text = (await res.text()).slice(0, 400);
      return { ok: false, status: res.status, error: `non-json upstream (${ct}): ${text}` };
    }
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export async function extractWfs({ layerDef, extractCfg, field }) {
  const url = extractCfg.url;
  const typeName = extractCfg.typeName;
  if (!url || !typeName) {
    return { status: "error", error: "WFS config missing url/typeName", features: null, count: 0 };
  }
  // Match SRS between bbox and srsName so the axis-order swap stays in
  // sync. urn-form mandates lat,lon — bboxParamFromBoundary handles that.
  const SRS = "urn:ogc:def:crs:EPSG::4326";
  const bboxParam = bboxParamFromBoundary(field.boundary, SRS);
  if (!bboxParam) {
    return { status: "error", error: "field boundary has no valid points", features: null, count: 0 };
  }
  const fieldPoly = boundaryToGeoJsonPolygon(field.boundary);
  if (!fieldPoly) {
    return { status: "error", error: "field boundary invalid", features: null, count: 0 };
  }

  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    srsName: SRS,
    outputFormat: "application/json",
    count: String(WFS_MAX_FEATURES),
    bbox: bboxParam,
  });
  const result = await fetchWfs(url, params, WFS_TIMEOUT_MS);
  if (!result.ok) {
    return { status: "error", error: result.error, features: null, count: 0 };
  }
  const fc = result.json;
  const inFeatures = Array.isArray(fc?.features) ? fc.features : [];
  if (!inFeatures.length) {
    return {
      status: "ok",
      features: { type: "FeatureCollection", features: [] },
      count: 0,
    };
  }

  const swatches = Array.isArray(layerDef?.swatches) ? layerDef.swatches : [];
  const classifyCfg = extractCfg.classify || {};
  const seenClasses = new Map(); // classKey -> idx
  const out = [];
  for (const feat of inFeatures) {
    if (!feat?.geometry) continue;
    let clipped = null;
    try {
      const geom = feat.geometry;
      const wrapped =
        geom.type === "Polygon"
          ? turfPolygon(geom.coordinates, feat.properties || {})
          : geom.type === "MultiPolygon"
            ? turfMultiPolygon(geom.coordinates, feat.properties || {})
            : null;
      if (wrapped) {
        // Turf 7: intersect signature changed to take a FeatureCollection.
        clipped = intersect(featureCollection([fieldPoly, wrapped]));
      } else {
        // Lines / points: keep as-is, the frontend can decide whether to render.
        clipped = { type: "Feature", properties: feat.properties || {}, geometry: geom };
      }
    } catch {
      clipped = null;
    }
    if (!clipped || !clipped.geometry) continue;

    const props = feat.properties || {};
    const classRaw = readProp(props, classifyCfg.fromProperty);
    const labelRaw = readProp(props, classifyCfg.labelProperty);
    const classKey =
      (classRaw == null || classRaw === "") ? "default" : String(classRaw);
    const label =
      labelRaw == null || labelRaw === "" ? classKey : String(labelRaw);
    let idx = seenClasses.get(classKey);
    if (idx === undefined) {
      idx = seenClasses.size;
      seenClasses.set(classKey, idx);
    }
    const color = colorForClass(classKey, swatches, idx);

    clipped.properties = {
      class: classKey,
      label,
      color,
      ...props,
    };
    out.push(clipped);
  }

  // Defra paginates; if the upstream returned exactly the cap we asked for,
  // call it 'partial' so the frontend can show a "more data omitted" hint.
  const status = inFeatures.length >= WFS_MAX_FEATURES ? "partial" : "ok";
  return {
    status,
    features: { type: "FeatureCollection", features: out },
    count: out.length,
  };
}

// Force a touch to the unused mercator helper so if someone later edits this
// to handle EPSG:3857 input they don't have to re-import.
void lonLatToMeters;

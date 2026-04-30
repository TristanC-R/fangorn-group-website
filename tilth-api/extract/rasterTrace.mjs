/**
 * Raster → vector tracer for ArcGIS / WMS layers without a /query endpoint.
 *
 * Pipeline per (field, layer):
 *   1. Render the upstream as a PNG that covers the field bbox at the
 *      configured pixel resolution (default 1024 px on the longer axis).
 *   2. Decode the PNG into RGBA pixels.
 *   3. Quantise colours by frequency-weighted RGB clustering (legend-aware
 *      where possible — see `paletteFromLegend`).
 *   4. For each palette class build a binary mask and run marching-squares
 *      (d3-contour) to recover polygon outlines in pixel space.
 *   5. Convert pixel coords → EPSG:3857 metres → EPSG:4326 lat/lng.
 *   6. Simplify each polygon (Douglas–Peucker) to keep the GeoJSON small.
 *   7. Clip every polygon to the actual field boundary so we don't
 *      paint outside the field.
 *
 * Output: GeoJSON FeatureCollection in EPSG:4326 with one feature per
 * (class) connected region. Each feature carries:
 *   - properties.class : the quantised RGB hex of the upstream class
 *   - properties.label : human label from the legend (or hex if no match)
 *   - properties.color : same hex as `class`, surfaced for the renderer
 */

import { PNG } from "pngjs";
import { contours as d3Contours } from "d3-contour";
import simplify from "simplify-js";
import { featureCollection, intersect, polygon as turfPolygon } from "@turf/turf";

import {
  bboxFromBoundary,
  boundaryToGeoJsonPolygon,
  metersToLonLat,
} from "./geo.mjs";

const TRACE_TIMEOUT_MS = Math.max(5000, Number(process.env.TILTH_TRACE_TIMEOUT_MS || 30_000));
const TRACE_RES_DEFAULT = Math.max(
  256,
  Math.min(2048, Number(process.env.TILTH_TRACE_RESOLUTION_PX || 1024))
);
const SIMPLIFY_TOLERANCE_DEG = Number(
  process.env.TILTH_TRACE_SIMPLIFY_DEG || 0.000_03
); // ~3.3 m at UK latitudes

/* ---------- PNG fetch + decode ---------- */

function buildArcgisExportUrl(def, minx, miny, maxx, maxy, w, h) {
  const params = new URLSearchParams({
    bbox: `${minx.toFixed(4)},${miny.toFixed(4)},${maxx.toFixed(4)},${maxy.toFixed(4)}`,
    bboxSR: "3857",
    imageSR: "3857",
    size: `${Math.round(w)},${Math.round(h)}`,
    format: def.format || "png32",
    transparent: "true",
    f: "image",
  });
  if (def.layers) params.set("layers", def.layers);
  if (def.mapScale) params.set("mapScale", String(def.mapScale));
  if (def.dpi) params.set("dpi", String(def.dpi));
  const base = String(def.url).replace(/\/(WMSServer|export)\/?$/i, "");
  return `${base}/export?${params.toString()}`;
}

function buildWmsExportUrl(def, minx, miny, maxx, maxy, w, h) {
  const version = def.version || "1.3.0";
  const format = def.format || "image/png";
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: version,
    LAYERS: def.layer || "",
    STYLES: def.styles || "",
    FORMAT: format,
    TRANSPARENT: "TRUE",
    WIDTH: String(Math.round(w)),
    HEIGHT: String(Math.round(h)),
  });
  if (version.startsWith("1.3")) {
    params.set("CRS", def.crs || "EPSG:3857");
  } else {
    params.set("SRS", def.crs || "EPSG:3857");
  }
  params.set(
    "BBOX",
    `${minx.toFixed(4)},${miny.toFixed(4)},${maxx.toFixed(4)},${maxy.toFixed(4)}`
  );
  const sep = String(def.url).includes("?") ? "&" : "?";
  return `${def.url}${sep}${params.toString()}`;
}

function buildExportUrl(def, minx, miny, maxx, maxy, w, h) {
  if (def.kind === "arcgis") return buildArcgisExportUrl(def, minx, miny, maxx, maxy, w, h);
  if (def.kind === "wms") return buildWmsExportUrl(def, minx, miny, maxx, maxy, w, h);
  return null;
}

async function fetchPng(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TRACE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "image/png,image/*;q=0.9",
        "User-Agent":
          process.env.WMS_USER_AGENT ||
          `FangornTilth/1.0 (extractor; ${process.env.OSM_CONTACT_EMAIL || "contact missing"})`,
        Referer: "https://fangorn.tilth",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      const text = (await res.text()).slice(0, 200);
      return { ok: false, status: res.status, error: `non-image upstream (${ct}): ${text}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, body: buf };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function decodePng(buf) {
  return new Promise((resolve, reject) => {
    new PNG().parse(buf, (err, data) => {
      if (err) reject(err);
      else resolve(data); // { width, height, data: Uint8Array RGBA }
    });
  });
}

/* ---------- Palette extraction ---------- */

/**
 * Quantise pixels into a small palette by binning RGB to 4-bit per channel
 * (16³ = 4096 bins) then merging bins whose centres are within
 * `mergeThreshold` Euclidean RGB distance. Pixels with alpha < `alphaCutoff`
 * are treated as background (mapped to class -1).
 */
function buildPalette(pixels, width, height, opts = {}) {
  const alphaCutoff = opts.alphaCutoff ?? 32;
  const mergeThreshold = opts.mergeThreshold ?? 16;
  const minClassFrac = opts.minClassFrac ?? 0.001; // drop classes <0.1% of opaque pixels
  const bins = new Map(); // bin key -> { r, g, b, count }
  const total = width * height;
  let opaque = 0;
  for (let i = 0; i < total; i++) {
    const a = pixels[i * 4 + 3];
    if (a < alphaCutoff) continue;
    opaque++;
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = bins.get(key);
    if (cur) {
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.count += 1;
    } else {
      bins.set(key, { r, g, b, count: 1 });
    }
  }
  if (!opaque) return [];
  // Average each bin to centre, sort by frequency descending.
  const cands = [];
  for (const v of bins.values()) {
    cands.push({
      r: Math.round(v.r / v.count),
      g: Math.round(v.g / v.count),
      b: Math.round(v.b / v.count),
      count: v.count,
    });
  }
  cands.sort((a, b) => b.count - a.count);
  const merged = [];
  for (const c of cands) {
    if (c.count / opaque < minClassFrac) continue;
    let absorbedInto = -1;
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const dr = c.r - m.r;
      const dg = c.g - m.g;
      const db = c.b - m.b;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < mergeThreshold) {
        absorbedInto = i;
        break;
      }
    }
    if (absorbedInto >= 0) {
      const m = merged[absorbedInto];
      const total = m.count + c.count;
      m.r = Math.round((m.r * m.count + c.r * c.count) / total);
      m.g = Math.round((m.g * m.count + c.g * c.count) / total);
      m.b = Math.round((m.b * m.count + c.b * c.count) / total);
      m.count = total;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

function rgbToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Match each palette class against the layer legend to recover human labels
 * where possible. The legend swatches are tiny PNGs (data URIs); we don't
 * need to fully decode them — sampling the centre pixel is enough to get
 * the swatch colour, then nearest-RGB wins.
 */
function labelPalette(palette, legendEntries) {
  if (!Array.isArray(legendEntries) || !legendEntries.length) {
    return palette.map((p) => ({ ...p, label: rgbToHex(p.r, p.g, p.b) }));
  }
  // Decode each legend swatch to its dominant RGB. The data URIs come from
  // ArcGIS `/legend?f=json` and are usually 16×16 PNGs.
  const legendPalette = [];
  for (const e of legendEntries) {
    if (!e?.swatch) continue;
    const m = /^data:[^;]+;base64,(.+)$/.exec(e.swatch);
    if (!m) continue;
    try {
      const buf = Buffer.from(m[1], "base64");
      // Quick & dirty: parse synchronously via PNG.sync.
      const png = PNG.sync.read(buf);
      // Sample the centre 4×4 region's average opaque colour.
      const cx = Math.floor(png.width / 2);
      const cy = Math.floor(png.height / 2);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
          const idx = (y * png.width + x) * 4;
          if (png.data[idx + 3] < 128) continue;
          r += png.data[idx];
          g += png.data[idx + 1];
          b += png.data[idx + 2];
          n++;
        }
      }
      if (!n) continue;
      legendPalette.push({
        r: Math.round(r / n),
        g: Math.round(g / n),
        b: Math.round(b / n),
        label: e.label || "",
      });
    } catch {
      // Skip malformed swatches.
    }
  }
  if (!legendPalette.length) {
    return palette.map((p) => ({ ...p, label: rgbToHex(p.r, p.g, p.b) }));
  }
  return palette.map((p) => {
    let best = null;
    let bestD = Infinity;
    for (const l of legendPalette) {
      const dr = p.r - l.r;
      const dg = p.g - l.g;
      const db = p.b - l.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    // Only accept legend match when reasonably close (RGB Euclid <= 30).
    const accept = best && bestD <= 30 * 30;
    return {
      ...p,
      label: accept ? best.label || rgbToHex(p.r, p.g, p.b) : rgbToHex(p.r, p.g, p.b),
    };
  });
}

/* ---------- Mask + contour ---------- */

function buildClassMask(pixels, width, height, palette) {
  // For every opaque pixel, snap to nearest palette class.
  // Returns Int8Array length=W*H, value = class index (-1 = transparent).
  const out = new Int8Array(width * height);
  out.fill(-1);
  const np = palette.length;
  for (let i = 0; i < width * height; i++) {
    const a = pixels[i * 4 + 3];
    if (a < 32) continue;
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    let bestIdx = -1;
    let bestD = Infinity;
    for (let p = 0; p < np; p++) {
      const c = palette[p];
      const dr = r - c.r;
      const dg = g - c.g;
      const db = b - c.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        bestIdx = p;
      }
    }
    out[i] = bestIdx;
  }
  return out;
}

/**
 * Build a binary mask for one palette class, padded with a 1-pixel zero
 * border. The padding is critical: d3-contour traces the boundary between
 * cells where value < threshold and value ≥ threshold, so a uniform mask
 * (small field that falls entirely inside one geological/soil class)
 * produces zero contours unless we surround it with explicit "outside"
 * cells. The padded width/height are exposed via the return value so
 * callers stay in sync with the contour pixel coordinates.
 */
function pixelsToBinaryPadded(classMask, classIdx, w, h) {
  const W = w + 2;
  const H = h + 2;
  const arr = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      arr[(y + 1) * W + (x + 1)] = classMask[y * w + x] === classIdx ? 1 : 0;
    }
  }
  return { arr, W, H };
}

/**
 * Convert d3-contour MultiPolygon (pixel coords) → array of GeoJSON
 * features in EPSG:4326, each clipped to the field polygon.
 *
 * d3-contour pixel convention: ring vertices are at half-pixel centres;
 * coordinate (0,0) is the top-left of the *cell grid*, increasing right/
 * down. We map (px, py) → mercator (minx + px/W*spanX, maxy - py/H*spanY).
 */
function contourMultiPolyToFeatures({
  multi,
  bbox3857,
  width,
  height,
  pad = 0,
  fieldPoly,
  cls,
}) {
  if (!multi || !Array.isArray(multi.coordinates) || !multi.coordinates.length) return [];
  const spanX = bbox3857.maxx - bbox3857.minx;
  const spanY = bbox3857.maxy - bbox3857.miny;
  // The binary mask was zero-padded by `pad` pixels on each side, so the
  // contourer's pixel coords are offset by `pad` from the original image.
  // Subtracting `pad` puts us back into image-pixel space, which matches
  // bbox3857 1:1.
  const projectRing = (ring) => {
    const out = [];
    for (const [px, py] of ring) {
      const ix = px - pad;
      const iy = py - pad;
      const mx = bbox3857.minx + (ix / width) * spanX;
      const my = bbox3857.maxy - (iy / height) * spanY;
      const ll = metersToLonLat(mx, my);
      out.push([ll.lng, ll.lat]);
    }
    if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
      out.push([out[0][0], out[0][1]]);
    }
    return out;
  };

  const features = [];
  for (const poly of multi.coordinates) {
    // poly = [outerRing, hole1, hole2, ...] in pixel coords.
    if (!poly?.length) continue;
    const projected = poly.map(projectRing).filter((r) => r.length >= 4);
    if (!projected.length) continue;
    // Simplify each ring (Douglas–Peucker on lng/lat).
    const simplified = projected.map((ring) => {
      const pts = ring.map(([lng, lat]) => ({ x: lng, y: lat }));
      const sp = simplify(pts, SIMPLIFY_TOLERANCE_DEG, true);
      const back = sp.map((p) => [p.x, p.y]);
      if (back.length && (back[0][0] !== back[back.length - 1][0] || back[0][1] !== back[back.length - 1][1])) {
        back.push([back[0][0], back[0][1]]);
      }
      return back;
    }).filter((r) => r.length >= 4);
    if (!simplified.length) continue;
    let candidate = null;
    try {
      candidate = turfPolygon(simplified, {});
    } catch {
      continue;
    }
    let clipped = null;
    try {
      // Turf 7: intersect takes a FeatureCollection, not two args. Older
      // call signature throws "Must specify at least 2 geometries", which
      // we caught silently — wiping out every traced polygon. Pass the
      // pair as a FeatureCollection so clipping actually happens.
      clipped = intersect(featureCollection([fieldPoly, candidate]));
    } catch {
      clipped = null;
    }
    if (!clipped || !clipped.geometry) continue;
    clipped.properties = {
      class: cls.classKey,
      label: cls.label,
      color: cls.classKey,
    };
    features.push(clipped);
  }
  return features;
}

/* ---------- Public API ---------- */

export async function extractArcgisTrace({
  layerDef,
  layerLegend, // optional { entries: [{ label, swatch }] }
  field,
  resolutionPx = TRACE_RES_DEFAULT,
}) {
  const bbox = bboxFromBoundary(field.boundary);
  if (!bbox) {
    return { status: "error", error: "field boundary has no valid points", features: null, count: 0 };
  }
  const fieldPoly = boundaryToGeoJsonPolygon(field.boundary);
  if (!fieldPoly) {
    return { status: "error", error: "field boundary invalid", features: null, count: 0 };
  }

  // Pick render dimensions to fit the longer axis; preserve aspect so
  // pixel projection stays uniform (no anisotropic stretch).
  const spanX = bbox.maxx - bbox.minx;
  const spanY = bbox.maxy - bbox.miny;
  const longSide = Math.max(spanX, spanY);
  const cap = Math.max(256, Math.min(2048, Math.round(resolutionPx)));
  const W = Math.max(64, Math.round((spanX / longSide) * cap));
  const H = Math.max(64, Math.round((spanY / longSide) * cap));

  const url = buildExportUrl(layerDef, bbox.minx, bbox.miny, bbox.maxx, bbox.maxy, W, H);
  if (!url) {
    return { status: "error", error: `layer kind not exportable: ${layerDef.kind}`, features: null, count: 0 };
  }
  const fetched = await fetchPng(url);
  if (!fetched.ok) {
    return { status: "error", error: fetched.error, features: null, count: 0 };
  }

  let png;
  try {
    png = await decodePng(fetched.body);
  } catch (e) {
    return { status: "error", error: `png decode: ${e?.message || e}`, features: null, count: 0 };
  }
  if (!png?.data || !png.width || !png.height) {
    return { status: "error", error: "png decode produced empty data", features: null, count: 0 };
  }

  const palette = buildPalette(png.data, png.width, png.height, {
    alphaCutoff: 32,
    mergeThreshold: 18,
    minClassFrac: 0.0015,
  });
  if (!palette.length) {
    return {
      status: "ok",
      features: { type: "FeatureCollection", features: [] },
      count: 0,
    };
  }
  const labelled = labelPalette(palette, layerLegend?.entries);
  const classMask = buildClassMask(png.data, png.width, png.height, labelled);

  // Pad by 1 pixel — see pixelsToBinaryPadded. Contourer must run at the
  // padded dimensions so the perimeter of full-frame regions becomes a
  // closed contour.
  const PAD = 1;
  const paddedW = png.width + PAD * 2;
  const paddedH = png.height + PAD * 2;
  const contourer = d3Contours().size([paddedW, paddedH]).thresholds([0.5]);

  const features = [];
  for (let p = 0; p < labelled.length; p++) {
    const cls = labelled[p];
    const classKey = rgbToHex(cls.r, cls.g, cls.b);
    const { arr: binary } = pixelsToBinaryPadded(classMask, p, png.width, png.height);
    const contoursOut = contourer(binary);
    const multi = contoursOut[0]; // single threshold
    const feats = contourMultiPolyToFeatures({
      multi,
      bbox3857: bbox,
      width: png.width,
      height: png.height,
      pad: PAD,
      fieldPoly,
      cls: { classKey, label: cls.label || classKey },
    });
    for (const f of feats) features.push(f);
  }

  return {
    status: features.length ? "ok" : "ok",
    features: { type: "FeatureCollection", features },
    count: features.length,
  };
}

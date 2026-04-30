import { getTilthApiBase } from "./tilthApi.js";
import { tilthStore } from "../tilth/state/localStore.js";

const SIMPLE_MAP = {
  heavy: "Clay",
  medium: "Loam",
  light: "Sandy loam",
};

const SOIL_OPTIONS = ["Clay", "Clay loam", "Loam", "Sandy loam", "Sandy", "Silty", "Peat", "Chalk"];

function matchDetailed(label) {
  if (!label) return null;
  const lc = label.toLowerCase();
  if (/peat/.test(lc)) return "Peat";
  if (/chalk/.test(lc)) return "Chalk";
  if (/silt/.test(lc)) return "Silty";
  if (/sandy\s*loam/.test(lc)) return "Sandy loam";
  if (/sand/.test(lc)) return "Sandy";
  if (/clay\s*loam/.test(lc) || /silty\s*clay/.test(lc)) return "Clay loam";
  if (/clay/.test(lc)) return "Clay";
  if (/loam/.test(lc)) return "Loam";
  for (const opt of SOIL_OPTIONS) {
    if (lc.includes(opt.toLowerCase())) return opt;
  }
  return null;
}

async function identifyLayer(apiBase, layerId, lat, lng) {
  const params = new URLSearchParams({ lon: String(lng), lat: String(lat), z: "12" });
  const url = `${apiBase}/api/wms/${encodeURIComponent(layerId)}/identify?${params}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data?.features) ? data.features : [];
}

async function detectSoilType(apiBase, lat, lng) {
  const simple = await identifyLayer(apiBase, "soil-texture-simple", lat, lng);
  if (simple?.length) {
    const label = (simple[0].label || "").toLowerCase().trim();
    const mapped = SIMPLE_MAP[label];
    if (mapped) return mapped;
  }

  const detailed = await identifyLayer(apiBase, "soil-texture-detailed", lat, lng);
  if (detailed?.length) {
    const mapped = matchDetailed(detailed[0].label || "");
    if (mapped) return mapped;
  }
  return null;
}

async function detectCropType(apiBase, lat, lng) {
  const crome = await identifyLayer(apiBase, "crome-2024", lat, lng);
  if (crome?.length) {
    const label = (crome[0].label || "").trim();
    if (label && label !== "—" && label.toLowerCase() !== "unknown") return label;
  }
  const prev = await identifyLayer(apiBase, "crome-2023", lat, lng);
  if (prev?.length) {
    const label = (prev[0].label || "").trim();
    if (label && label !== "—" && label.toLowerCase() !== "unknown") return label;
  }
  return null;
}

/**
 * Auto-fill soil and crop attributes for a field if not already set.
 * Queries the WMS proxy for soil-texture-simple/detailed and CROME layers.
 * Fire-and-forget — never throws.
 */
export async function autoFillFieldSoil(farmId, fieldId, boundary) {
  if (!farmId || !fieldId || !Array.isArray(boundary) || boundary.length < 3) return;

  const apiBase = getTilthApiBase();
  if (!apiBase) return;

  const existing = tilthStore.loadFieldAttrs(farmId);
  const needsSoil = !existing[fieldId]?.soil;
  const needsCrop = !existing[fieldId]?.crop;
  if (!needsSoil && !needsCrop) return;

  const midLat = boundary.reduce((a, p) => a + p.lat, 0) / boundary.length;
  const midLng = boundary.reduce((a, p) => a + (p.lng ?? p.lon ?? 0), 0) / boundary.length;

  try {
    const [soil, crop] = await Promise.all([
      needsSoil ? detectSoilType(apiBase, midLat, midLng) : null,
      needsCrop ? detectCropType(apiBase, midLat, midLng) : null,
    ]);

    if (!soil && !crop) return;

    const fresh = tilthStore.loadFieldAttrs(farmId);
    const patch = { ...(fresh[fieldId] || {}) };
    if (soil && !patch.soil) patch.soil = soil;
    if (crop && !patch.crop) patch.crop = crop;
    tilthStore.saveFieldAttrs(farmId, { ...fresh, [fieldId]: patch });
  } catch {
    /* swallowed */
  }
}

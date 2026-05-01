export const SPECTRAL_INDEX_ORDER = ["ndvi", "evi", "ndwi", "ndmi", "ndre", "savi", "nbr"];

const RED_YELLOW_GREEN = [
  { t: 0, rgb: [165, 0, 38] },
  { t: 0.5, rgb: [255, 255, 191] },
  { t: 1, rgb: [0, 104, 55] },
];

const BLUE_GREEN = [
  { t: 0, rgb: [191, 219, 254] },
  { t: 0.5, rgb: [240, 253, 244] },
  { t: 1, rgb: [20, 83, 45] },
];

const BROWN_GREEN = [
  { t: 0, rgb: [146, 64, 14] },
  { t: 0.5, rgb: [254, 243, 199] },
  { t: 1, rgb: [22, 101, 52] },
];

export const SPECTRAL_INDICES = {
  ndvi: {
    id: "ndvi",
    label: "NDVI",
    rowKey: "ndvi_mean",
    description: "Vegetation vigour and canopy density.",
    interpretation: "Best for overall crop biomass, emergence, peak canopy and broad performance comparisons.",
    lowLabel: "Sparse",
    midLabel: "Moderate",
    highLabel: "Canopy",
    min: 0,
    max: 0.9,
    warnBelow: 0.3,
    goodAbove: 0.55,
    colormap: "rdylgn",
    ramp: RED_YELLOW_GREEN,
    expression: "ndvi",
  },
  evi: {
    id: "evi",
    label: "EVI",
    rowKey: "evi_mean",
    description: "Enhanced vegetation signal for dense canopy.",
    interpretation: "Useful when NDVI starts to saturate in strong crops.",
    lowLabel: "Weak",
    midLabel: "Moderate",
    highLabel: "Dense",
    min: 0,
    max: 0.8,
    warnBelow: 0.2,
    goodAbove: 0.45,
    colormap: "rdylgn",
    ramp: RED_YELLOW_GREEN,
    expression: "evi",
  },
  ndwi: {
    id: "ndwi",
    label: "NDWI",
    rowKey: "ndwi_mean",
    description: "Canopy and surface water signal.",
    interpretation: "Helps spot wet surfaces, waterlogging risk and water-related scene context.",
    lowLabel: "Dry",
    midLabel: "Balanced",
    highLabel: "Wet",
    min: -0.6,
    max: 0.5,
    warnBelow: -0.35,
    goodAbove: -0.05,
    colormap: "brbg",
    ramp: BLUE_GREEN,
    expression: "ndwi",
  },
  ndmi: {
    id: "ndmi",
    label: "NDMI",
    rowKey: "ndmi_mean",
    description: "Canopy moisture and drought stress.",
    interpretation: "Best for moisture stress, irrigation timing and drought-prone patches.",
    lowLabel: "Dry",
    midLabel: "Moderate",
    highLabel: "Moist",
    min: -0.5,
    max: 0.6,
    warnBelow: -0.05,
    goodAbove: 0.18,
    colormap: "brbg",
    ramp: BLUE_GREEN,
    expression: "ndmi",
  },
  ndre: {
    id: "ndre",
    label: "NDRE",
    rowKey: "ndre_mean",
    description: "Red-edge chlorophyll and nitrogen stress.",
    interpretation: "Often picks up chlorophyll or nitrogen stress before NDVI fully reacts.",
    lowLabel: "Weak",
    midLabel: "Adequate",
    highLabel: "Strong",
    min: 0,
    max: 0.55,
    warnBelow: 0.18,
    goodAbove: 0.32,
    colormap: "rdylgn",
    ramp: RED_YELLOW_GREEN,
    expression: "ndre",
  },
  savi: {
    id: "savi",
    label: "SAVI",
    rowKey: "savi_mean",
    description: "Soil-adjusted vegetation signal for sparse canopy.",
    interpretation: "Useful during establishment and where bare soil influences NDVI.",
    lowLabel: "Thin",
    midLabel: "Building",
    highLabel: "Covered",
    min: 0,
    max: 0.8,
    warnBelow: 0.22,
    goodAbove: 0.45,
    colormap: "rdylgn",
    ramp: RED_YELLOW_GREEN,
    expression: "savi",
  },
  nbr: {
    id: "nbr",
    label: "NBR",
    rowKey: "nbr_mean",
    description: "Residue, exposed soil and disturbance context.",
    interpretation: "Adds context for residue cover, exposed soil, burn/scorch, and abrupt disturbance.",
    lowLabel: "Exposed",
    midLabel: "Mixed",
    highLabel: "Covered",
    min: -0.2,
    max: 0.8,
    warnBelow: 0.05,
    goodAbove: 0.35,
    colormap: "rdylgn",
    ramp: BROWN_GREEN,
    expression: "nbr",
  },
};

export const SPECTRAL_INDEX_LIST = SPECTRAL_INDEX_ORDER.map((id) => SPECTRAL_INDICES[id]);

export function spectralIndex(id) {
  return SPECTRAL_INDICES[id] || SPECTRAL_INDICES.ndvi;
}

export function spectralValue(row, id) {
  const cfg = spectralIndex(id);
  const value = row?.[cfg.rowKey];
  return Number.isFinite(value) ? value : null;
}

export function formatSpectralValue(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

export function spectralTone(value, id) {
  const cfg = spectralIndex(id);
  if (!Number.isFinite(value)) return "neutral";
  if (Number.isFinite(cfg.warnBelow) && value < cfg.warnBelow) return "warn";
  if (Number.isFinite(cfg.goodAbove) && value >= cfg.goodAbove) return "ok";
  return "neutral";
}

export function spectralColor(value, id) {
  const cfg = spectralIndex(id);
  if (!Number.isFinite(value)) return "#cfd9cf";
  const min = Number.isFinite(cfg.min) ? cfg.min : -1;
  const max = Number.isFinite(cfg.max) ? cfg.max : 1;
  const ramp = cfg.ramp || RED_YELLOW_GREEN;
  const t = Math.max(0, Math.min(1, (value - min) / Math.max(1e-6, max - min)));
  let lo = ramp[0];
  let hi = ramp[ramp.length - 1];
  for (let i = 0; i < ramp.length - 1; i += 1) {
    if (t >= ramp[i].t && t <= ramp[i + 1].t) {
      lo = ramp[i];
      hi = ramp[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, hi.t - lo.t);
  const k = (t - lo.t) / span;
  const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k);
  const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k);
  const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

export function spectralSummary(row) {
  return SPECTRAL_INDEX_LIST
    .map((cfg) => ({ ...cfg, value: spectralValue(row, cfg.id) }))
    .filter((item) => Number.isFinite(item.value));
}

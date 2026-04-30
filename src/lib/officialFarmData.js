export function rpaDatasetLinks(sbi) {
  const clean = String(sbi || "").replace(/\D/g, "");
  const base = "https://environment.data.gov.uk/rpa";
  return {
    valid: clean.length >= 6,
    sbi: clean,
    portal: clean ? `${base}?sbi=${encodeURIComponent(clean)}` : base,
    landParcels: clean ? `${base}/land-parcels?SBI=${encodeURIComponent(clean)}` : `${base}/land-parcels`,
    hedges: clean ? `${base}/hedges?SBI=${encodeURIComponent(clean)}` : `${base}/hedges`,
    landCovers: clean ? `${base}/land-covers?SBI=${encodeURIComponent(clean)}` : `${base}/land-covers`,
  };
}

export const DEFRA_DATA_LINKS = [
  {
    label: "RPA land parcels",
    blurb: "Registered land parcels for payment and scheme checks.",
    url: "https://environment.data.gov.uk/rpa",
  },
  {
    label: "RPA hedges",
    blurb: "Hedge records used by SFI and Countryside Stewardship checks.",
    url: "https://environment.data.gov.uk/rpa",
  },
  {
    label: "Defra spatial data",
    blurb: "Public environmental, flood, water, landscape and designation layers.",
    url: "https://environment.data.gov.uk/spatialdata",
  },
  {
    label: "Rural Payments service",
    blurb: "Official land registration, applications and agreement management.",
    url: "https://www.gov.uk/guidance/register-rural-land-on-the-rural-payments-service",
  },
];

export const SOIL_ENVIRONMENT_PRESETS = [
  {
    id: "land-cover",
    label: "Land cover",
    blurb: "Current RPA CROME layer for crop/land-cover checks.",
    layerIds: ["crome-2024"],
  },
  {
    id: "protected-land",
    label: "Protected land",
    blurb: "SSSI, AONB and National Park context for scheme constraints.",
    layerIds: ["sssi-england", "aonb-england", "national-parks-england"],
  },
  {
    id: "soil-risk",
    label: "Soil risk",
    blurb: "Erosion, peat and soil depth layers for management risk.",
    layerIds: ["soil-erosion-risk", "peat-coverage", "soil-depth-thickness"],
  },
  {
    id: "flood-context",
    label: "Flood context",
    blurb: "Environment Agency flood model location context.",
    layerIds: ["flood-model-locations"],
  },
];

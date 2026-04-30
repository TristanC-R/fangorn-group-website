/**
 * Canonical land-use categories for Tilth field boundaries. Stored on the
 * per-field attribute record (`tilthStore.loadFieldAttrs(farmId)[fieldId].landUse`)
 * and used both for map tinting and analytics grouping.
 *
 * Colours are tuned to sit well on both the Esri satellite and CartoDB light
 * basemaps at the opacity the map applies to choropleth fills (~0.55).
 */
export const LAND_USES = [
  {
    id: "arable",
    label: "Arable",
    color: "#104E3F",
    short: "Arable",
    blurb: "Cropped land — cereals, break crops, roots, veg.",
  },
  {
    id: "grass",
    label: "Grass paddock",
    color: "#8FB86A",
    short: "Grass",
    blurb: "Permanent or temporary grazing, leys, paddocks.",
  },
  {
    id: "woodland",
    label: "Woodland / Forest",
    color: "#35643A",
    short: "Wood",
    blurb: "Mature trees, plantations, agroforestry strips.",
  },
  {
    id: "hedgerow",
    label: "Hedgerow / Margin",
    color: "#AF8A3F",
    short: "Hedge",
    blurb: "Linear features, field margins, buffer strips.",
  },
  {
    id: "water",
    label: "Water / Pond",
    color: "#2F6077",
    short: "Water",
    blurb: "Ponds, ditches, reservoirs, wetland.",
  },
  {
    id: "other",
    label: "Other / Unmapped",
    color: "#6F7A74",
    short: "Other",
    blurb: "Hardstanding, yards, barns, access tracks.",
  },
];

export const LAND_USE_BY_ID = Object.fromEntries(
  LAND_USES.map((u) => [u.id, u])
);

export const DEFAULT_LAND_USE = "arable";

export function landUseColor(id) {
  return LAND_USE_BY_ID[id]?.color || LAND_USE_BY_ID[DEFAULT_LAND_USE].color;
}

export function landUseLabel(id) {
  return LAND_USE_BY_ID[id]?.label || LAND_USE_BY_ID[DEFAULT_LAND_USE].label;
}

/**
 * Per-layer extraction config.
 *
 * Maps layer id (matching WMS_LAYERS in server.mjs) → strategy + params.
 * Two strategies today:
 *   - 'wfs'           : real upstream vector via OGC WFS GetFeature.
 *   - 'arcgis_trace'  : render upstream as PNG, classify pixels, vectorise
 *                       the resulting masks, georeference and clip to the
 *                       field. Used for BGS / UKSO sources whose ArcGIS
 *                       MapServer disables /query and /identify.
 *
 * Anything not listed here falls back to 'unsupported' and the row is
 * recorded with status='ok' but features=null so the frontend can show a
 * sensible "not extractable" badge instead of a perpetual spinner.
 */

export const EXTRACT_CONFIG = {
  // --- Defra / Natural England / EA WFS ----------------------------------
  "sssi-england": {
    strategy: "wfs",
    url: "https://environment.data.gov.uk/spatialdata/sites-of-special-scientific-interest-england/wfs",
    typeName:
      "dataset-ba8dc201-66ef-4983-9d46-7378af21027e:Sites_of_Special_Scientific_Interest_England",
    classify: { fromProperty: "sssi_name", labelProperty: "sssi_name" },
  },
  "aonb-england": {
    strategy: "wfs",
    url: "https://environment.data.gov.uk/spatialdata/areas-of-outstanding-natural-beauty-england/wfs",
    typeName:
      "dataset-0c1ea47f-3c79-47f0-b0ed-094e0a136971:Areas_of_Outstanding_Natural_Beauty_England",
    classify: { fromProperty: "name", labelProperty: "name" },
  },
  "national-parks-england": {
    strategy: "wfs",
    url: "https://environment.data.gov.uk/spatialdata/national-parks-england/wfs",
    typeName:
      "dataset-e819098e-e248-4a8f-b684-5a21ca521b9b:National_Parks_England",
    classify: { fromProperty: "name", labelProperty: "name" },
  },
  "crome-2024": {
    strategy: "wfs",
    url: "https://environment.data.gov.uk/spatialdata/crop-map-of-england-2024/wfs",
    typeName:
      "dataset-0903079b-35a2-47de-b805-77a0cc0c57bf:Crop_Map_of_England_2024",
    classify: { fromProperty: "lucode", labelProperty: "crome_descript" },
  },
  "crome-2023": {
    strategy: "wfs",
    url: "https://environment.data.gov.uk/spatialdata/crop-map-of-england-2023/wfs",
    typeName:
      "dataset-a27312b5-d6c9-4710-ad5e-382d727c1b05:Crop_Map_of_England_2023",
    classify: { fromProperty: "lucode", labelProperty: "crome_descript" },
  },
  "flood-model-locations": {
    strategy: "wfs",
    url: "https://environment.data.gov.uk/spatialdata/flood-model-locations/wfs",
    typeName:
      "dataset-764046df-0a89-40fb-86d5-41a6a7fe2ea3:Flood_Model_Locations",
    classify: { fromProperty: "modelname", labelProperty: "modelname" },
  },

  // --- BGS / UKSO ArcGIS render+trace ------------------------------------
  "bgs-bedrock-50k": { strategy: "arcgis_trace" },
  "bgs-superficial-50k": { strategy: "arcgis_trace" },
  "bgs-mass-movement": { strategy: "arcgis_trace" },
  "bgs-gbase-shallow": { strategy: "arcgis_trace" },
  "coal-mining": { strategy: "arcgis_trace" },
  "uk-lime-areas": { strategy: "arcgis_trace" },
  "uk-plant-avail-mg": { strategy: "arcgis_trace" },
  "soil-texture-simple": { strategy: "arcgis_trace" },
  "soil-texture-detailed": { strategy: "arcgis_trace" },
  "soil-depth-thickness": { strategy: "arcgis_trace" },
  "soil-erosion-risk": { strategy: "arcgis_trace" },
  "peat-coverage": { strategy: "arcgis_trace" },
  "subsoil-grainsize": { strategy: "arcgis_trace" },
  "biosoil-toc": { strategy: "arcgis_trace" },

  // --- Pure basemap, nothing to extract ----------------------------------
  opentopo: { strategy: "unsupported" },
};

export function strategyFor(layerId) {
  const cfg = EXTRACT_CONFIG[layerId];
  if (!cfg) return "unsupported";
  return cfg.strategy;
}

export function configFor(layerId) {
  return EXTRACT_CONFIG[layerId] || { strategy: "unsupported" };
}

/**
 * Stable string capturing every part of `layerDef` + `extractCfg` that
 * influences extraction output. Stored as `upstream_version` and used to
 * detect "this layer config has been edited, re-extract on next request".
 */
export function upstreamVersionFor(layerId, layerDef, extractCfg) {
  const parts = [
    layerDef?.kind || "",
    layerDef?.url || "",
    layerDef?.layer || layerDef?.layers || "",
    layerDef?.mapScale || "",
    layerDef?.maxNativeZoom ?? "",
    extractCfg?.strategy || "",
    extractCfg?.url || "",
    extractCfg?.typeName || "",
  ];
  return parts.join("|");
}

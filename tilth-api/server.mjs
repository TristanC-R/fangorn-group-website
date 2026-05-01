/**
 * Small Tilth backend: proxies Nominatim + Overpass from your own machine (proper User-Agent / email).
 * Node 18+ (global fetch). No npm dependencies.
 *
 * Usage: from repo root — `npm run tilth-api`
 * Env: see tilth-api/.env.example (optional file `tilth-api/.env` is loaded automatically)
 */

// Side-effect import: populates process.env from tilth-api/.env *before* any
// downstream module (supabaseAdmin, extract/*) reads its top-level constants.
// Must stay the first import in this file.
import "./loadEnv.mjs";

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";

import { landuseAroundQuery, pickSmallestLandOutlineAtPoint } from "../src/tilth/osmFieldAtPoint.js";
import {
  enqueueExtractAll,
  enqueueExtraction,
  queueStatus,
  setLayerContextProvider,
} from "./extract/index.mjs";
import { strategyFor, EXTRACT_CONFIG } from "./extract/layers.mjs";
import {
  buildSpectralIndexTileUrl,
  fetchTitilerTile,
  mpcConfigSummary,
  ndviRender,
} from "./sentinel/mpcClient.mjs";
import { enqueueNdviIngest, ingestQueueStatus } from "./sentinel/ingest.mjs";
import { enqueueSarIngest, sarQueueStatus } from "./sentinel/sarIngest.mjs";
import { buildSarTileUrl, sarRender } from "./sentinel/sarClient.mjs";
import {
  refreshSchedulerStatus,
  runRefreshSweep,
  startRefreshScheduler,
} from "./sentinel/refreshScheduler.mjs";
import {
  enqueueElevationIngest,
  elevationQueueStatus,
} from "./sentinel/elevationIngest.mjs";
import {
  adminClient,
  fetchOwnedField,
  isConfigured as supabaseConfigured,
  userIdFromJwt,
} from "./supabaseAdmin.mjs";
import { getMarketPrices, marketStatus } from "./market/index.mjs";
import { handleDocumentVaultRoute } from "./documentVault.mjs";
import { handlePlatformAssistantRoute } from "./platformAssistant.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3847, 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW_LOCAL_DEV_ORIGINS = process.env.ALLOW_LOCAL_DEV_ORIGINS !== "0";
const OVERPASS_URLS = (process.env.OVERPASS_URLS || process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://overpass.kumi.systems/api/interpreter")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const NOMINATIM_URL = (process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(
  /\/$/,
  ""
);
const OSM_CONTACT_EMAIL = (process.env.OSM_CONTACT_EMAIL || "").trim();
const OSM_USER_AGENT =
  (process.env.OSM_USER_AGENT || "").trim() ||
  `FangornTilthApi/1.0 (${OSM_CONTACT_EMAIL || "set OSM_CONTACT_EMAIL per OSM policy"})`;

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_CALENDAR_REDIRECT_URL = (process.env.GOOGLE_CALENDAR_REDIRECT_URL || "").trim();
const GOOGLE_CALENDAR_APP_REDIRECT_URL =
  (process.env.GOOGLE_CALENDAR_APP_REDIRECT_URL || "http://localhost:5173/tilth/calendar").trim();
const GOOGLE_CALENDAR_TIMEZONE = (process.env.GOOGLE_CALENDAR_TIMEZONE || "Europe/London").trim();

const OVERPASS_MIN_GAP_MS = Math.max(250, Number(process.env.OVERPASS_MIN_GAP_MS || 1200));
const OVERPASS_CACHE_TTL_MS = Math.max(10_000, Number(process.env.OVERPASS_CACHE_TTL_MS || 180_000));
const overpassCache = new Map(); // key -> { t, status, text, retryAfter }
let overpassChain = Promise.resolve();
let lastOverpassAt = 0;

// --- WMS / ArcGIS / XYZ overlay proxy ----------------------------------------
// Proxies per-tile map imagery for the Tilth map overlays (soil, geology,
// flood risk etc.). The registry below is the server-side source of truth —
// the frontend never sees raw upstream URLs, so we can add caching, attribution,
// and rate-limiting in one place. Override per-tenant via a JSON file at the
// path `TILTH_WMS_LAYERS_FILE` (defaults to `tilth-api/layers.json` if present).
const WMS_USER_AGENT =
  (process.env.WMS_USER_AGENT || "").trim() ||
  `FangornTilth/1.0 (+tilth overlay proxy; ${OSM_CONTACT_EMAIL || "contact missing"})`;
const WMS_CACHE_MAX = Math.max(64, Number(process.env.WMS_CACHE_MAX || 2048));
const WMS_CACHE_TTL_MS = Math.max(60_000, Number(process.env.WMS_CACHE_TTL_MS || 86_400_000)); // 24h
const WMS_UPSTREAM_TIMEOUT_MS = Math.max(2000, Number(process.env.WMS_UPSTREAM_TIMEOUT_MS || 15_000));
const WMS_TILE_SIZE = 256;

// Pre-baked 1×1 transparent PNG — served instead of a 404/5xx from upstream so
// `TextureLoader` in the browser silently paints nothing for failing tiles and
// the map stays clean.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
  "base64"
);

// All entries below have been live-probed against the upstream endpoint —
// each returns a valid PNG tile for an EPSG:3857 bbox request. If you need a
// layer not listed here, add it via `tilth-api/layers.json` (merged at boot).
const WMS_DEFAULT_LAYERS = {
  // --- Geology ------------------------------------------------------------
  "bgs-bedrock-50k": {
    kind: "arcgis",
    label: "BGS bedrock 1:50k",
    provider: "British Geological Survey",
    blurb:
      "Bedrock geology at 1:50,000. Parent rock informs drainage, water-holding capacity and deep-rooting potential.",
    group: "Geology",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/BGS_Detailed_Geology/MapServer",
    layers: "show:4",
    attribution: "© British Geological Survey (BGS, UKRI) — contains OS data © Crown Copyright",
    swatches: ["#c5b283", "#8a7a4a", "#adb08e", "#746b56"],
  },
  "bgs-superficial-50k": {
    kind: "arcgis",
    label: "BGS superficial deposits 1:50k",
    provider: "British Geological Survey",
    blurb:
      "Quaternary drift — till, alluvium, blown sand, peat. Often more important than bedrock for topsoil behaviour.",
    group: "Geology",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/BGS_Detailed_Geology/MapServer",
    layers: "show:3",
    attribution: "© British Geological Survey (BGS, UKRI)",
    swatches: ["#d7c68d", "#a38a4f", "#b29a6b", "#76674a"],
  },
  "bgs-mass-movement": {
    kind: "arcgis",
    label: "BGS mass movement",
    provider: "British Geological Survey",
    blurb: "Mapped landslide, slump and solifluction features. Siting constraint for heavy stores and dams.",
    group: "Geology",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/BGS_Detailed_Geology/MapServer",
    layers: "show:1",
    attribution: "© British Geological Survey (BGS, UKRI)",
    swatches: ["#a03d2b", "#c76148", "#e38e72", "#efc2b3"],
  },
  "bgs-gbase-shallow": {
    kind: "arcgis",
    label: "G-BASE geochem — shallow",
    provider: "British Geological Survey",
    blurb:
      "Baseline stream-sediment + soil geochemistry at shallow sampling sites. Context for K, Mg, P and heavy metal interpretation.",
    group: "Geology",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS_GBASE/MapServer",
    layers: "show:0",
    attribution: "© British Geological Survey (BGS, UKRI) — G-BASE programme",
    swatches: ["#2f6077", "#4a8483", "#c07c12", "#b4412e"],
  },

  // --- Soil ---------------------------------------------------------------
  // UKSO MapServers often publish paired overview/detail sub-layers. Use the
  // detail sub-layers for field-scale rendering and keep the requested bbox
  // untouched; forcing ArcGIS `mapScale` makes it return a broader map extent,
  // which then gets compressed into the field.
  "uk-lime-areas": {
    kind: "arcgis",
    label: "Liming potential (UKSO)",
    provider: "British Geological Survey / UKSO",
    blurb:
      "Areas where soils are likely to benefit from liming, derived from pH and parent-material modelling across Great Britain.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS_AGRI/MapServer",
    layers: "show:0",
    renderMode: "fields",
    attribution: "© British Geological Survey (BGS, UKRI) — UK Soil Observatory",
    swatches: ["#eadfbf", "#c9b47a", "#a88f4a", "#644a1a"],
  },
  "uk-plant-avail-mg": {
    kind: "arcgis",
    label: "Plant-available magnesium",
    provider: "British Geological Survey / UKSO MAGNET",
    blurb:
      "Modelled plant-available Mg in topsoils — directly useful for interpreting grass/cereal tissue tests.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_MAGNET/MapServer",
    layers: "show:0",
    renderMode: "fields",
    attribution: "© British Geological Survey (BGS, UKRI) — UKSO MAGNET",
    swatches: ["#f3e3b8", "#d9b86a", "#a88438", "#5f4a1b"],
  },
  "soil-texture-simple": {
    kind: "arcgis",
    label: "Soil texture (simple classes)",
    provider: "BGS / UKSO",
    blurb:
      "Simplified soil texture bands at 1km resolution — light / medium / heavy. Drives rooting depth, trafficability and drainage planning.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS/MapServer",
    layers: "show:12",
    renderMode: "fields",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#d7ba7e", "#b9a57b", "#8d9a64", "#6f8a70"],
  },
  "soil-texture-detailed": {
    kind: "arcgis",
    label: "Soil texture (detailed classes)",
    provider: "BGS / UKSO",
    blurb:
      "Full 38-class parent-material soil texture at 1km — e.g. ‘chalky clay to chalky loam’, ‘sandy silt loam over gravel’. More granular than the simple bands.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS/MapServer",
    layers: "show:17",
    renderMode: "fields",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#c8a368", "#a3894a", "#6d7e55", "#5b6a45"],
  },
  "soil-depth-thickness": {
    kind: "arcgis",
    label: "Soil depth / layer thickness",
    provider: "BGS / UKSO",
    blurb:
      "Modelled soil-layer thickness at 1km — deep / intermediate / shallow. Useful for rooting-depth limits, subsoiling suitability and cultivation planning.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS/MapServer",
    layers: "show:16",
    renderMode: "fields",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#efe3c2", "#d5b676", "#a88438", "#5f4a1b"],
  },
  "soil-erosion-risk": {
    kind: "arcgis",
    label: "Bare-soil erosion risk",
    provider: "BGS / UKSO",
    blurb:
      "Modelled susceptibility of bare soil to water erosion at 1km — from ‘not applicable’ through ‘low’ to ‘very high. Rills likely most seasons, gullies form in very wet periods.’",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS/MapServer",
    layers: "show:20",
    renderMode: "fields",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#d9d0b6", "#cba66b", "#b56a36", "#8a2b15"],
  },
  "peat-coverage": {
    kind: "arcgis",
    label: "Peat coverage",
    provider: "BGS / UKSO",
    blurb:
      "Mapped peat soils at 1km — surface peat and buried peat layers. Critical for carbon accounting and drainage decisions.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS/MapServer",
    layers: "show:21",
    renderMode: "fields",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#4e3a1d", "#7a5a2e", "#a88438", "#d5b676"],
  },
  "subsoil-grainsize": {
    kind: "arcgis",
    label: "Subsoil grain size",
    provider: "BGS / UKSO",
    blurb:
      "Dominant grain-size class of the parent material — sand → clay gradient. Explains drainage and nutrient retention behaviour.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_BGS/MapServer",
    layers: "show:15",
    renderMode: "fields",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#f5e6b5", "#d9bd74", "#a88438", "#5f4a1b"],
  },
  "biosoil-toc": {
    kind: "arcgis",
    label: "Soil organic carbon (BioSoil 0–5 cm)",
    provider: "Forest Research / UKSO",
    blurb:
      "Measured topsoil total organic carbon (0–5 cm) at the EU BioSoil forest monitoring plots. Best national SOC proxy that is fully open — NSRI-modelled SOC requires a licence.",
    group: "Soil",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/UKSO/UKSO_Forest_Research/MapServer",
    layers: "show:1",
    renderMode: "fields",
    attribution: "© Forest Research / UKSO",
    swatches: ["#eadfbf", "#c9b47a", "#a88f4a", "#3d2d12"],
  },

  // --- Land-use: Crop Map of England (RPA) -------------------------------
  "crome-2024": {
    kind: "wms",
    label: "Crop Map of England 2024",
    provider: "Rural Payments Agency / Defra",
    blurb:
      "RPA CROME 2024 — classified crop type per hexagonal cell across England, derived from Sentinel-1 radar + Planet Fusion optical imagery.",
    group: "Land",
    url: "https://environment.data.gov.uk/spatialdata/crop-map-of-england-2024/wms",
    layer: "Crop_Map_of_England_2024",
    format: "image/png",
    version: "1.3.0",
    attribution: "© Rural Payments Agency / Defra (OGL v3)",
    swatches: ["#d7ba30", "#649a5c", "#af8a3f", "#c4ddd0"],
  },
  "crome-2023": {
    kind: "wms",
    label: "Crop Map of England 2023",
    provider: "Rural Payments Agency / Defra",
    blurb:
      "Previous year’s RPA CROME classification — useful for year-on-year rotation comparison.",
    group: "Land",
    url: "https://environment.data.gov.uk/spatialdata/crop-map-of-england-2023/wms",
    layer: "Crop_Map_of_England_2023",
    format: "image/png",
    version: "1.3.0",
    attribution: "© Rural Payments Agency / Defra (OGL v3)",
    swatches: ["#c9a82c", "#5a8550", "#9a7a34", "#b4ccc0"],
  },

  // --- Hazards ------------------------------------------------------------
  "coal-mining": {
    kind: "arcgis",
    label: "Coal-mining reporting areas",
    provider: "The Coal Authority / BGS",
    blurb:
      "Statutory reporting areas where coal-mining history may affect development, access, or pond siting.",
    group: "Hazards",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/CoalAuthority/coalauthority_coal_mining_reporting_areas/MapServer",
    attribution: "© The Coal Authority / BGS",
    swatches: ["#5a5149", "#7a6e61", "#b4412e", "#d5c4a8"],
  },
  "flood-model-locations": {
    kind: "wms",
    label: "EA flood model locations",
    provider: "Environment Agency",
    blurb:
      "Locations covered by current Environment Agency flood models. Useful context — follow up with bespoke flood-risk assessment for planning.",
    group: "Hazards",
    url: "https://environment.data.gov.uk/spatialdata/flood-model-locations/wms",
    layer: "Flood_Model_Locations",
    format: "image/png",
    version: "1.3.0",
    attribution: "© Environment Agency (Open Government Licence v3)",
    swatches: ["#2f6077", "#6f8aa0", "#b5c5d0", "#e4ebef"],
  },
  "opentopo": {
    kind: "xyz",
    label: "OpenTopoMap relief",
    provider: "OpenTopoMap",
    blurb:
      "Shaded relief + contours. Handy sanity layer that always loads — good for sense-checking the overlay stack.",
    group: "Hazards",
    url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "Map data © OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA)",
    swatches: ["#3d3d3d", "#6b6b6b", "#9e9e9e", "#dadada"],
  },

  // --- Land ---------------------------------------------------------------
  "sssi-england": {
    kind: "wms",
    label: "SSSI (Sites of Special Scientific Interest)",
    provider: "Natural England",
    blurb:
      "Statutorily protected sites — farming operations require consultation with Natural England.",
    group: "Land",
    url: "https://environment.data.gov.uk/spatialdata/sites-of-special-scientific-interest-england/wms",
    layer: "Sites_of_Special_Scientific_Interest_England",
    format: "image/png",
    version: "1.3.0",
    attribution: "© Natural England (Open Government Licence v3)",
    swatches: ["#4a8443", "#649a5c", "#8fb86a", "#c3d3c4"],
  },
  "aonb-england": {
    kind: "wms",
    label: "Areas of Outstanding Natural Beauty",
    provider: "Natural England",
    blurb: "AONB designations — relevant for stewardship options and landscape-level constraints.",
    group: "Land",
    url: "https://environment.data.gov.uk/spatialdata/areas-of-outstanding-natural-beauty-england/wms",
    layer: "Areas_of_Outstanding_Natural_Beauty_England",
    format: "image/png",
    version: "1.3.0",
    attribution: "© Natural England (Open Government Licence v3)",
    swatches: ["#af8a3f", "#c7a454", "#d7b878", "#eadfbf"],
  },
  "national-parks-england": {
    kind: "wms",
    label: "National Parks (England)",
    provider: "Natural England",
    blurb: "National Park boundaries — context for landscape character and planning consultations.",
    group: "Land",
    url: "https://environment.data.gov.uk/spatialdata/national-parks-england/wms",
    layer: "National_Parks_England",
    format: "image/png",
    version: "1.3.0",
    attribution: "© Natural England (Open Government Licence v3)",
    swatches: ["#35643a", "#4a8443", "#6f8a70", "#c3d3c4"],
  },
};

function loadWmsLayerOverrides() {
  const p = (process.env.TILTH_WMS_LAYERS_FILE || "").trim() ||
    path.join(__dirname, "layers.json");
  try {
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    console.warn(`[tilth-api] Failed to read WMS overrides at ${p}:`, e?.message || e);
  }
  return null;
}

const WMS_LAYERS = (() => {
  const overrides = loadWmsLayerOverrides();
  if (!overrides) return { ...WMS_DEFAULT_LAYERS };
  const merged = { ...WMS_DEFAULT_LAYERS };
  for (const [id, def] of Object.entries(overrides)) {
    if (def === null) {
      delete merged[id];
      continue;
    }
    merged[id] = { ...(merged[id] || {}), ...def };
  }
  return merged;
})();

// --- Web Mercator tile math ---
const MERC_EDGE = 20037508.342789244; // meters, 180° at equator in EPSG:3857

function tileToBBox3857(z, x, y) {
  const n = 2 ** z;
  const span = (MERC_EDGE * 2) / n;
  const minx = -MERC_EDGE + x * span;
  const maxx = minx + span;
  const maxy = MERC_EDGE - y * span;
  const miny = maxy - span;
  return { minx, miny, maxx, maxy };
}

function buildWmsUrl(def, z, x, y) {
  const { minx, miny, maxx, maxy } = tileToBBox3857(z, x, y);
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
    WIDTH: String(WMS_TILE_SIZE),
    HEIGHT: String(WMS_TILE_SIZE),
  });
  // WMS 1.3.0 uses CRS + (in many axis-order definitions) minx,miny,maxx,maxy
  // for EPSG:3857 — safe in both 1.1.1 and 1.3.0.
  if (version.startsWith("1.3")) {
    params.set("CRS", def.crs || "EPSG:3857");
  } else {
    params.set("SRS", def.crs || "EPSG:3857");
  }
  params.set(
    "BBOX",
    `${minx.toFixed(4)},${miny.toFixed(4)},${maxx.toFixed(4)},${maxy.toFixed(4)}`
  );
  const sep = def.url.includes("?") ? "&" : "?";
  return `${def.url}${sep}${params.toString()}`;
}

function buildArcgisUrl(def, z, x, y) {
  const { minx, miny, maxx, maxy } = tileToBBox3857(z, x, y);
  return buildArcgisExportUrl(def, minx, miny, maxx, maxy, WMS_TILE_SIZE, WMS_TILE_SIZE);
}

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
  // Do not pass ArcGIS `mapScale` here: it can change the returned map extent,
  // which makes broad UKSO imagery look squeezed into the requested field bbox.
  if (def.dpi) params.set("dpi", String(def.dpi));
  const base = def.url.replace(/\/(WMSServer|export)\/?$/i, "");
  const exportUrl = `${base}/export`;
  const sep = exportUrl.includes("?") ? "&" : "?";
  return `${exportUrl}${sep}${params.toString()}`;
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
  const sep = def.url.includes("?") ? "&" : "?";
  return `${def.url}${sep}${params.toString()}`;
}

// Builds an export URL for a layer at an arbitrary 3857 bbox + pixel size.
// Used by `/api/wms/:id/export` when the client asks for a single image
// covering its current viewport instead of fetching a tile mosaic — this
// avoids per-tile reprojection seams that show up on coarse rasters
// (e.g. UKSO 1km grids) at field zoom.
function buildUpstreamExportUrl(def, minx, miny, maxx, maxy, w, h) {
  switch (def.kind) {
    case "wms":
      return buildWmsExportUrl(def, minx, miny, maxx, maxy, w, h);
    case "arcgis":
      return buildArcgisExportUrl(def, minx, miny, maxx, maxy, w, h);
    default:
      return null;
  }
}

function buildXyzUrl(def, z, x, y) {
  return String(def.url || "")
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

function buildUpstreamTileUrl(def, z, x, y) {
  switch (def.kind) {
    case "wms":
      return buildWmsUrl(def, z, x, y);
    case "arcgis":
      return buildArcgisUrl(def, z, x, y);
    case "xyz":
      return buildXyzUrl(def, z, x, y);
    default:
      return null;
  }
}

// Minimal LRU cache (insertion-order delete-then-set trick).
const wmsCache = new Map();
function cacheGet(key) {
  const hit = wmsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > WMS_CACHE_TTL_MS) {
    wmsCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  wmsCache.delete(key);
  wmsCache.set(key, hit);
  return hit;
}
function cacheSet(key, entry) {
  if (wmsCache.has(key)) wmsCache.delete(key);
  wmsCache.set(key, entry);
  while (wmsCache.size > WMS_CACHE_MAX) {
    const firstKey = wmsCache.keys().next().value;
    if (!firstKey) break;
    wmsCache.delete(firstKey);
  }
}

// Separate LRU for Sentinel-2 NDVI tiles. They're keyed by item id (not
// layer id) so the keyspace is much wider than WMS — a year of weekly
// scenes for a few fields can produce thousands of distinct items.
// Smaller TTL too because MPC asset SAS tokens expire after ~hours; a
// stale 7-day cached PNG is fine to serve since the underlying scene
// doesn't change, but anything older than that we re-render to be safe.
const SENTINEL_TILE_CACHE_MAX = Math.max(256, Number(process.env.SENTINEL_TILE_CACHE_MAX || 4096));
const SENTINEL_TILE_CACHE_TTL_MS = Math.max(60_000, Number(process.env.SENTINEL_TILE_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000));
const sentinelTileCache = new Map();
function sentinelCacheGet(key) {
  const hit = sentinelTileCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > SENTINEL_TILE_CACHE_TTL_MS) {
    sentinelTileCache.delete(key);
    return null;
  }
  sentinelTileCache.delete(key);
  sentinelTileCache.set(key, hit);
  return hit;
}
function sentinelCacheSet(key, entry) {
  if (sentinelTileCache.has(key)) sentinelTileCache.delete(key);
  sentinelTileCache.set(key, entry);
  while (sentinelTileCache.size > SENTINEL_TILE_CACHE_MAX) {
    const firstKey = sentinelTileCache.keys().next().value;
    if (!firstKey) break;
    sentinelTileCache.delete(firstKey);
  }
}

async function fetchTile(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WMS_UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "image/png,image/*;q=0.9,*/*;q=0.5",
        "User-Agent": WMS_USER_AGENT,
        Referer: "https://fangorn.tilth",
      },
      signal: ctrl.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const text = contentType.includes("xml") || contentType.includes("text")
        ? (await res.text()).slice(0, 200)
        : "";
      return { ok: false, status: res.status, contentType, text };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, contentType, body: buf };
  } catch (e) {
    return { ok: false, status: 0, contentType: "", text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// --- Legend support ---------------------------------------------------------
// Map layers are useless without a key — farmers can't tell a Gleysol from a
// Podzol by colour. The upstream services already publish legends in two forms:
//   - ArcGIS MapServer: `/legend?f=json` → structured `{label, imageData}[]`
//   - OGC WMS:          `GetLegendGraphic` → a single combined PNG image
// We fetch/cache/normalise both shapes into one JSON schema:
//   { source, entries: [{ label, swatch (data URI or null) }] }
// and the frontend renders whatever it gets. Short-circuits return an empty
// entry list so the client can fall back to the static swatches in the manifest.

const LEGEND_TIMEOUT_MS = Math.max(2000, Number(process.env.LEGEND_TIMEOUT_MS || 10_000));
const legendCache = new Map();
function legendGet(id) {
  const hit = legendCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.t > WMS_CACHE_TTL_MS) {
    legendCache.delete(id);
    return null;
  }
  return hit.data;
}
function legendSet(id, data) {
  if (legendCache.has(id)) legendCache.delete(id);
  legendCache.set(id, { t: Date.now(), data });
  while (legendCache.size > 128) {
    const firstKey = legendCache.keys().next().value;
    if (!firstKey) break;
    legendCache.delete(firstKey);
  }
}

function parseArcgisLayerSelection(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const m = /^(show|include):(\d+(?:\s*,\s*\d+)*)$/i.exec(trimmed);
  if (!m) return null;
  return m[2].split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
}

// Hard cap so the legend payload stays small. Some BGS services (e.g. detailed
// geology) expose every rock type as a sub-layer, which would make the legend
// ~10k entries and several MB of base64 swatches. 120 is plenty for a scrolled
// panel; if a user needs more we'll add a raw-JSON fetch path later.
const LEGEND_MAX_ENTRIES = 120;

async function fetchArcgisLegend(def) {
  const base = def.url.replace(/\/(WMSServer|export)\/?$/i, "");
  const url = `${base}/legend?f=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LEGEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": WMS_USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) return { source: "arcgis-json", entries: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    if (!Array.isArray(data?.layers)) return { source: "arcgis-json", entries: [] };
    const wantedIds = parseArcgisLayerSelection(def.layers);
    const selected = wantedIds
      ? data.layers.filter((l) => wantedIds.includes(l.layerId))
      : data.layers;
    // Count everything the service offers upfront so we can honestly report
    // truncation. Dedupe is applied after — some BGS services repeat the same
    // label under several sub-layers and we don't want to double-count.
    const totalPublished = selected.reduce(
      (n, l) => n + (Array.isArray(l.legend) ? l.legend.length : 0),
      0
    );
    const uniqueLabels = new Set();
    for (const layer of selected) {
      for (const item of layer.legend || []) {
        uniqueLabels.add(String(item.label ?? "").trim());
      }
    }
    const seen = new Set();
    const entries = [];
    outer: for (const layer of selected) {
      for (const item of layer.legend || []) {
        const label = String(item.label ?? "").trim();
        const key = label || `${layer.layerId}:${item.url || seen.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          label,
          swatch: item.imageData
            ? `data:${item.contentType || "image/png"};base64,${item.imageData}`
            : null,
        });
        if (entries.length >= LEGEND_MAX_ENTRIES) break outer;
      }
    }
    return {
      source: "arcgis-json",
      entries,
      totalEntries: uniqueLabels.size,
      truncated: uniqueLabels.size > entries.length,
    };
  } catch (e) {
    return { source: "arcgis-json", entries: [], error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchWmsLegend(def) {
  if (!def.layer) return { source: "wms-image", entries: [] };
  let u;
  try {
    u = new URL(def.url);
  } catch {
    return { source: "wms-image", entries: [], error: "bad url" };
  }
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) params.set(k, v);
  params.set("service", "WMS");
  params.set("version", def.version || "1.3.0");
  params.set("request", "GetLegendGraphic");
  params.set("layer", def.layer);
  params.set("format", "image/png");
  u.search = params.toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LEGEND_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      headers: {
        Accept: "image/png,image/*;q=0.9",
        "User-Agent": WMS_USER_AGENT,
        Referer: "https://fangorn.tilth",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { source: "wms-image", entries: [], error: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      return { source: "wms-image", entries: [], error: `not image: ${ct}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Some services return ~100-200 byte transparent / "no legend" placeholders.
    // Anything under ~400 bytes is almost certainly not a real legend.
    if (buf.length < 400) {
      return { source: "wms-image", entries: [], error: "placeholder" };
    }
    const b64 = buf.toString("base64");
    return {
      source: "wms-image",
      entries: [{ label: def.label || "", swatch: `data:${ct};base64,${b64}`, full: true }],
    };
  } catch (e) {
    return { source: "wms-image", entries: [], error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchLegend(def) {
  switch (def.kind) {
    case "arcgis":
      return fetchArcgisLegend(def);
    case "wms":
      return fetchWmsLegend(def);
    default:
      return { source: "none", entries: [] };
  }
}

// --- Identify (click-to-query) ---------------------------------------------
//
// Given a (lon, lat) click, ask the upstream what feature(s) sit under it.
// Two flavours: WMS GetFeatureInfo and ArcGIS REST /identify. Each emits a
// uniform shape:
//   { features: [{ label, properties, layerName? }, ...] }
// so the frontend doesn't need branchy parsers per layer.
//
// The response is intentionally small — we only forward the upstream's own
// attribute table for the matched feature(s); we don't try to render HTML
// snippets or stitch in legend metadata here.

const IDENTIFY_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.TILTH_IDENTIFY_TIMEOUT_MS || 8000)
);

const IDENTIFY_R = 6378137;
function _lonLatToMeters(lon, lat) {
  const x = ((lon * Math.PI) / 180) * IDENTIFY_R;
  const y =
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * IDENTIFY_R;
  return { x, y };
}

/**
 * Generic upstream fetcher used by both WMS GetFeatureInfo and ArcGIS
 * /identify. Returns the body as either parsed JSON or raw text depending
 * on what we got back — callers branch on `json` vs `text`.
 */
async function fetchJsonLike(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), IDENTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json,application/geo+json,application/xml;q=0.9,*/*;q=0.5",
        "User-Agent": WMS_USER_AGENT,
      },
      signal: ctrl.signal,
      ...opts,
    });
    const contentType = res.headers.get("content-type") || "";
    const bodyText = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, contentType, text: bodyText.slice(0, 400) };
    }
    // Try JSON parse if the content-type advertises it OR if the body
    // looks like JSON (some servers still send text/plain for JSON).
    if (contentType.includes("json") || /^\s*[\{\[]/.test(bodyText)) {
      try {
        return { ok: true, status: res.status, contentType, json: JSON.parse(bodyText), text: bodyText };
      } catch {
        /* fall through to text */
      }
    }
    return { ok: true, status: res.status, contentType, text: bodyText };
  } catch (e) {
    return { ok: false, status: 0, contentType: "", text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// --- GetFeatureInfo body parsers ---------------------------------------
// WMS servers are wildly inconsistent about which INFO_FORMAT they honour
// — environment.data.gov.uk's GeoServer instances often ignore the JSON
// request and reply with HTML or GML regardless. We try a sequence of
// formats and parse whatever comes back. These parsers are deliberately
// regex-based and lenient: a real DOM/XML parser would be more correct
// but needs an extra dep, and the 0.1% of pathological responses are
// ones where QGIS also chokes.

function _stripXmlNamespaces(xml) {
  return xml
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/\s+xmlns(?::[\w-]+)?\s*=\s*"[^"]*"/g, "")
    .replace(/\s+xsi:schemaLocation\s*=\s*"[^"]*"/g, "")
    .replace(/<\/([\w-]+):/g, "</")
    .replace(/<([\w-]+):/g, "<");
}

function _decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function _stripTags(html) {
  return _decodeXmlEntities(String(html).replace(/<[^>]*>/g, ""));
}

const _GEOMETRY_KEYS = new Set([
  "boundedBy",
  "Box",
  "coordinates",
  "geometry",
  "the_geom",
  "shape",
  "SHAPE",
  "geom",
  "msGeometry",
  "lowerCorner",
  "upperCorner",
  "Point",
  "LineString",
  "Polygon",
  "MultiSurface",
  "Surface",
]);

function _extractLeafTextElements(xml) {
  const result = {};
  const re = /<([\w-]+)\b[^>]*>([^<]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[1];
    if (_GEOMETRY_KEYS.has(tag)) continue;
    const value = _decodeXmlEntities(m[2]).trim();
    if (!value) continue;
    if (!Object.prototype.hasOwnProperty.call(result, tag)) {
      result[tag] = value;
    }
  }
  return result;
}

function _parseTagAttrs(attrString) {
  const result = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString))) {
    result[m[1]] = _decodeXmlEntities(m[2]);
  }
  return result;
}

function parseGmlFeatures(xml) {
  if (!xml) return [];
  const features = [];
  const cleaned = _stripXmlNamespaces(xml);

  // ESRI WMS GetFeatureInfo: <FeatureInfoResponse>...<FIELDS PROP1="..." .../>...
  const fieldsRegex = /<FIELDS\b([^>]*?)\/?\s*>/gi;
  let fm;
  while ((fm = fieldsRegex.exec(cleaned))) {
    const attrs = _parseTagAttrs(fm[1]);
    if (Object.keys(attrs).length) {
      features.push({ properties: attrs, label: pickLabel(attrs) });
    }
  }
  if (features.length) return features;

  // GeoServer / WFS-style: <FeatureCollection>(<featureMember><Inner>...</Inner></featureMember>)+
  const memberRegex = /<featureMember[^>]*>([\s\S]*?)<\/featureMember>/gi;
  let mm;
  while ((mm = memberRegex.exec(cleaned))) {
    const inner = mm[1];
    const inn = /<([\w-]+)\b[^>]*>([\s\S]*?)<\/\1>/.exec(inner);
    if (!inn) continue;
    const props = _extractLeafTextElements(inn[2]);
    if (Object.keys(props).length) {
      features.push({ properties: props, label: pickLabel(props) });
    }
  }
  if (features.length) return features;

  // MapServer's msGMLOutput: <msGMLOutput><..._layer><..._feature>props</..._feature></..._layer></msGMLOutput>
  const featRegex = /<([\w-]+_feature)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let fr;
  while ((fr = featRegex.exec(cleaned))) {
    const props = _extractLeafTextElements(fr[2]);
    if (Object.keys(props).length) {
      features.push({ properties: props, label: pickLabel(props) });
    }
  }
  return features;
}

function parseHtmlFeatures(html) {
  if (!html) return [];
  // Cheap "are there even any feature attributes" check — if we see no
  // <table> we'd just emit garbage. GeoServer's default HTML wraps
  // attributes in a table; ArcGIS HTML output similarly.
  const features = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tb;
  while ((tb = tableRegex.exec(html))) {
    const tableContent = tb[1];
    const rowMatches = [...tableContent.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rowMatches.length < 2) {
      // Single-row table — could be vertical key/value pairs.
      const cellMatches = [...tableContent.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
      if (cellMatches.length >= 2 && cellMatches.length % 2 === 0) {
        const props = {};
        for (let i = 0; i < cellMatches.length; i += 2) {
          const k = _stripTags(cellMatches[i][1]).trim();
          const v = _stripTags(cellMatches[i + 1][1]).trim();
          if (k && v) props[k] = v;
        }
        if (Object.keys(props).length) features.push({ properties: props, label: pickLabel(props) });
      }
      continue;
    }
    const headerCells = [...rowMatches[0][1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
    const headers = headerCells.map((m) => _stripTags(m[1]).trim());
    for (let i = 1; i < rowMatches.length; i++) {
      const cellMatches = [...rowMatches[i][1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
      if (!cellMatches.length) continue;
      const props = {};
      for (let j = 0; j < cellMatches.length; j++) {
        const key = headers[j] || `field_${j}`;
        const val = _stripTags(cellMatches[j][1]).trim();
        if (key && val) props[key] = val;
      }
      if (Object.keys(props).length) features.push({ properties: props, label: pickLabel(props) });
    }
  }
  return features;
}

function parsePlainFeatures(text) {
  if (!text) return [];
  // Some servers emit `key = value` blocks separated by blank lines, one
  // per matched feature. Try both single and grouped layouts.
  const groups = String(text).split(/\n\s*\n+/);
  const features = [];
  for (const group of groups) {
    const props = {};
    for (const line of group.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][\w\-. ]{0,80}?)\s*[:=]\s*(.+?)\s*$/.exec(line);
      if (m) props[m[1]] = m[2];
    }
    if (Object.keys(props).length) {
      features.push({ properties: props, label: pickLabel(props) });
    }
  }
  return features;
}

function _looksLikeXml(text) {
  return /^\s*<\?xml/i.test(text) || /<wfs|<msGML|<FeatureInfoResponse|<featureMember|<FIELDS|<gml:/i.test(text);
}

function _looksLikeHtml(text) {
  return /<html|<table\b|<body\b/i.test(text);
}

/**
 * WMS 1.3.0 GetFeatureInfo. We try each INFO_FORMAT in turn until one
 * gives us something parseable — Defra/EA/NE GeoServer instances are
 * inconsistent and frequently ignore application/json. The BBOX is
 * EPSG:3857 to dodge the lat,lon axis-order trap of CRS:84/4326.
 *
 * `opts.halfM` (default 30 m → 60 m × 60 m window) controls the size of
 * the query window. Layers with scale-dependent visibility (UKSO 1:500k,
 * say) need a larger BBOX so the request scale falls inside the layer's
 * visible band; the caller can pass a halfM derived from def.mapScale.
 */
async function wmsGetFeatureInfo(def, lon, lat, opts = {}) {
  if (!def.layer) return { features: [], status: 0, error: "wms layer missing" };
  const m = _lonLatToMeters(lon, lat);
  const halfM = Number.isFinite(opts.halfM) && opts.halfM > 0 ? opts.halfM : 30;
  const minx = m.x - halfM;
  const miny = m.y - halfM;
  const maxx = m.x + halfM;
  const maxy = m.y + halfM;
  const baseParams = {
    SERVICE: "WMS",
    REQUEST: "GetFeatureInfo",
    VERSION: def.version || "1.3.0",
    LAYERS: def.layer,
    QUERY_LAYERS: def.layer,
    STYLES: def.styles || "",
    CRS: "EPSG:3857",
    BBOX: `${minx.toFixed(4)},${miny.toFixed(4)},${maxx.toFixed(4)},${maxy.toFixed(4)}`,
    WIDTH: "101",
    HEIGHT: "101",
    I: "50",
    J: "50",
    FEATURE_COUNT: "10",
    EXCEPTIONS: "application/vnd.ogc.se_xml",
  };
  // Order matters: we want JSON first because it's most reliable to parse,
  // then native GML variants (GeoServer happily emits these), then text/xml,
  // then plain/HTML which are last-resort.
  const formats = [
    "application/json",
    "application/geo+json",
    "application/vnd.ogc.gml/3.2",
    "application/vnd.ogc.gml/3.1.1",
    "application/vnd.ogc.gml",
    "text/xml",
    "application/xml",
    "text/plain",
    "text/html",
  ];
  let lastStatus = 0;
  let lastBody = "";
  let lastError = null;
  let lastUrl = "";
  for (const fmt of formats) {
    const params = new URLSearchParams({ ...baseParams, INFO_FORMAT: fmt });
    const sep = String(def.url).includes("?") ? "&" : "?";
    const url = `${def.url}${sep}${params.toString()}`;
    lastUrl = url;
    const result = await fetchJsonLike(url);
    if (!result.ok) {
      lastStatus = result.status || lastStatus;
      lastError = result.text || lastError;
      // 4xx on this format usually means "I don't speak that INFO_FORMAT"
      // — try the next one rather than bail.
      continue;
    }
    lastStatus = result.status || lastStatus;
    let features = [];
    if (result.json) {
      // FeatureCollection?
      if (Array.isArray(result.json.features)) {
        for (const feat of result.json.features) {
          const props = feat?.properties || {};
          if (Object.keys(props).length) {
            features.push({ label: pickLabel(props), properties: props });
          }
        }
      } else if (Array.isArray(result.json.results)) {
        // Some ESRI-flavoured WMS adapters return ArcGIS-shape JSON.
        for (const r of result.json.results) {
          const props = r?.attributes || {};
          if (Object.keys(props).length) {
            features.push({
              label: r?.value || pickLabel(props),
              layerName: r?.layerName || null,
              properties: props,
            });
          }
        }
      }
    }
    if (!features.length && result.text) {
      lastBody = result.text;
      const ct = (result.contentType || "").toLowerCase();
      if (ct.includes("xml") || ct.includes("gml") || _looksLikeXml(result.text)) {
        features = parseGmlFeatures(result.text);
      } else if (ct.includes("html") || _looksLikeHtml(result.text)) {
        features = parseHtmlFeatures(result.text);
      } else {
        features = parsePlainFeatures(result.text);
      }
    }
    if (features.length) {
      return {
        features: features.slice(0, 10),
        status: result.status || 200,
        info_format: fmt,
      };
    }
  }
  if (process.env.TILTH_DEBUG_IDENTIFY === "1") {
    console.warn(
      `[tilth-api] GetFeatureInfo no features for ${def.layer}\n  url=${lastUrl}\n  status=${lastStatus} body=${(lastBody || lastError || "").slice(0, 300)}`
    );
  }
  return {
    features: [],
    status: lastStatus || 0,
    error: lastError || "no features",
  };
}

// ArcGIS MapServer sub-layer index → WMS layer name. The BGS-hosted
// MapServers we proxy all advertise `capabilities: "Map"` only — REST
// /identify is disabled — but they expose WMS at /arcgis/services/.../
// MapServer/WMSServer. Conveniently, the REST sub-layer name and the
// WMS layer name are identical (e.g. `BGS.50k.Bedrock` for sub-layer 4),
// so we can fetch the REST `?f=json` once per MapServer and reuse it
// when we build the GetFeatureInfo URL.
const _arcgisLayerCache = new Map();
const _arcgisLayerInflight = new Map();

async function getArcgisLayerNames(baseUrl) {
  if (_arcgisLayerCache.has(baseUrl)) return _arcgisLayerCache.get(baseUrl);
  if (_arcgisLayerInflight.has(baseUrl)) return _arcgisLayerInflight.get(baseUrl);
  const promise = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), IDENTIFY_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}?f=json`, {
        headers: { "User-Agent": WMS_USER_AGENT, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const map = new Map();
      for (const l of j.layers || []) {
        if (l.id != null && l.name) map.set(Number(l.id), String(l.name));
      }
      _arcgisLayerCache.set(baseUrl, map);
      return map;
    } catch (e) {
      const empty = new Map();
      _arcgisLayerCache.set(baseUrl, empty);
      if (process.env.TILTH_DEBUG_IDENTIFY === "1") {
        console.warn(`[tilth-api] arcgis layer-name lookup failed for ${baseUrl}:`, e?.message || e);
      }
      return empty;
    } finally {
      clearTimeout(t);
      _arcgisLayerInflight.delete(baseUrl);
    }
  })();
  _arcgisLayerInflight.set(baseUrl, promise);
  return promise;
}

function _arcgisRestToWmsUrl(restBaseUrl) {
  // 'https://map.bgs.ac.uk/arcgis/rest/services/.../MapServer'
  //   -> 'https://map.bgs.ac.uk/arcgis/services/.../MapServer/WMSServer'
  return restBaseUrl.replace("/arcgis/rest/services/", "/arcgis/services/") + "/WMSServer";
}

/**
 * Identify against an ArcGIS MapServer. The BGS / UKSO / CoalAuth
 * services we proxy advertise `capabilities: "Map"` only — REST
 * /identify returns "Requested operation is not supported". So we
 * always reach for the matching WMS endpoint and run a regular
 * GetFeatureInfo against it. Layer names come from the REST `?f=json`
 * sub-layer list (cached per MapServer); they double as WMS layer
 * names on these servers.
 *
 * BBOX size is derived from `def.mapScale` if set, otherwise the
 * caller's zoom (passed in opts.zoom) — exactly the same trick QGIS
 * uses to satisfy each layer's MinScaleDenominator/MaxScaleDenominator
 * visibility band. Without that, raster-rendered layers like UKSO 1:500k
 * silently return zero hits even though the data is there.
 */
async function arcgisIdentify(def, lon, lat, opts = {}) {
  const baseUrl = String(def.url).replace(/\/(WMSServer|export)\/?$/i, "");
  const wmsUrl = _arcgisRestToWmsUrl(baseUrl);

  const layerNamesMap = await getArcgisLayerNames(baseUrl);
  let names = [];
  const showMatch = /show:([0-9,]+)/i.exec(String(def.layers || ""));
  if (showMatch) {
    for (const raw of showMatch[1].split(",")) {
      const idx = Number(raw.trim());
      if (!Number.isFinite(idx)) continue;
      const name = layerNamesMap.get(idx);
      if (name) names.push(name);
    }
  } else {
    // Def doesn't pin a sub-layer — query everything in the service.
    names = Array.from(layerNamesMap.values());
  }
  if (!names.length) {
    return {
      features: [],
      status: 0,
      error: "no WMS layer name resolved (REST sub-layer missing)",
    };
  }

  const z = Number.isFinite(opts.zoom) ? Math.max(2, Math.min(20, Math.round(opts.zoom))) : 14;
  const identifyDef = {
    ...def,
    url: wmsUrl,
    layer: names.join(","),
    version: def.version || "1.3.0",
  };
  const mPerPxAtZoom = 156543.03392 / 2 ** z;

  // First try the actual click scale. UKSO rasters are coarse, but a tight
  // point query is still the only way the popup can agree with the coloured
  // cell under the cursor. If the upstream hides the layer at that scale, we
  // fall back to the broad mapScale-compatible request below.
  const pointResult = await wmsGetFeatureInfo(identifyDef, lon, lat, {
    halfM: Math.max(30, Math.min(500, (mPerPxAtZoom * 101) / 2)),
  });
  if (pointResult.features.length) return pointResult;

  // Compute a query window sized to the layer's published map scale.
  // ArcGIS WMS respects MinScaleDenominator/MaxScaleDenominator; if our
  // request scale is outside the band the server returns 0 features
  // even when the data is on the ground. WMS scale is computed from
  // BBOX-width / (WIDTH * 0.00028), so for a target scale `s` and
  // image WIDTH=101 we need bbox width ≈ s * 101 * 0.00028 m.
  // Approximate ground resolution at the user's zoom (web mercator):
  // 156543 / 2^z metres per pixel at the equator. At UK lat (~52°)
  // the meridian is ~0.6× shorter; we leave that approximation in
  // since we just need an order-of-magnitude scale match.
  // For a 101-px window we want the BBOX width to span roughly what
  // the user sees in 100 px — that is, mPerPxAtZoom * 101.
  let halfM = (mPerPxAtZoom * 101) / 2;
  // …unless the layer publishes a min-scale at which it stops being
  // visible. UKSO layers are 1:500k rasters; halfM has to be large
  // enough that BBOX width / (101 * 0.00028) ≥ mapScale. We add a
  // safety factor of 2 so we sit in the middle of the visible band.
  if (Number.isFinite(def.mapScale) && def.mapScale > 0) {
    const minHalfM = (def.mapScale * 101 * 0.00028) / 2;
    if (minHalfM > halfM) halfM = minHalfM * 2;
  }
  // Don't go below 30 m or above 200 km — the former gives sub-pixel
  // click precision, the latter avoids accidentally crossing the
  // antimeridian / falling off the projection at high latitudes.
  halfM = Math.max(30, Math.min(200_000, halfM));

  const result = await wmsGetFeatureInfo(identifyDef, lon, lat, { halfM });

  if (!result.features.length && process.env.TILTH_DEBUG_IDENTIFY === "1") {
    console.warn(
      `[tilth-api] arcgis→WMS GetFeatureInfo no hits\n  url=${wmsUrl}\n  layers=${names.join(",")} z=${z} halfM=${Math.round(halfM)}m\n  upstreamStatus=${result.status} error=${result.error || "(none)"}`
    );
  }
  return result;
}

/**
 * Heuristic label picker — prefer fields we know carry human-readable text
 * across the upstreams we use. Falls back to the first non-empty string in
 * the properties bag, then "(unnamed)".
 *
 * Scoring strategy:
 *   1. Exact match against a curated allow-list (fast path).
 *   2. Anywhere a key contains "DESC" / "DESCRIPTION" we treat it as the
 *      best label (BGS raster layers like Soil-thickness expose
 *      `Raster.SOIL_DEPTH_DESC`, `Raster.SOIL_GROUP_DESC` etc).
 *   3. Lex / RCS / NAME / TITLE / TYPE / CLASS family — taxonomic labels.
 *   4. Fall back to first non-empty *non-numeric* string property.
 *   5. Finally, the first non-empty value of any kind.
 */
function pickLabel(props) {
  if (!props || typeof props !== "object") return "(unnamed)";
  const exact = [
    "LEX_RCS_D",
    "LEX_D",
    "Lex_d",
    "lex_d",
    "RCS_D",
    "RCS_X",
    "DESCRIPTION",
    "Description",
    "description",
    "TITLE",
    "Title",
    "NAME",
    "Name",
    "name",
    "label",
    "Label",
    "CROP_NAME",
    "Crop_Name",
    "crop_name",
    "FEATURE_TYPE",
    "Type",
    "type",
    "PEAT",
    "Lime_type",
    "SOIL_GROUP_DESC",
    "SOIL_DEPTH_DESC",
    "SOIL_TEXTURE_DESC",
    "PARENT_MATERIAL_DESC",
  ];
  for (const k of exact) {
    if (Object.prototype.hasOwnProperty.call(props, k)) {
      const v = props[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  // Match suffixes — covers Raster.SOIL_DEPTH_DESC and similar.
  const keys = Object.keys(props);
  const isHumanish = (key) =>
    /(DESC|DESCRIPTION|_NAME|_TYPE|_GROUP|_CLASS|LABEL|TITLE)\b/i.test(key);
  for (const k of keys) {
    if (isHumanish(k)) {
      const v = props[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  // Any non-numeric string value.
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" && v.trim() && !/^[\d.\-+,e\s]+$/i.test(v)) {
      return v.trim();
    }
  }
  for (const k of keys) {
    const v = props[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "(unnamed)";
}

async function identifyForLayer(def, lon, lat, opts = {}) {
  if (def.kind === "wms") return wmsGetFeatureInfo(def, lon, lat);
  if (def.kind === "arcgis") return arcgisIdentify(def, lon, lat, opts);
  return { features: [], status: 0, error: `kind not identifiable: ${def.kind}` };
}

function layerManifest() {
  return Object.entries(WMS_LAYERS).map(([id, def]) => ({
    id,
    kind: def.kind,
    label: def.label,
    provider: def.provider,
    blurb: def.blurb,
    group: def.group,
    attribution: def.attribution,
    swatches: def.swatches || [],
    needsTenantConfig: !!def.needsTenantConfig,
    renderMode: def.renderMode || null,
    minZoom: def.minZoom || 0,
    maxZoom: def.maxZoom || 19,
    tileVersion: [
      def.kind || "",
      def.layer || def.layers || "",
      def.mapScale || "",
      def.maxNativeZoom ?? "",
      def.url || "",
    ].join("|"),
    // `maxNativeZoom` tells the frontend to stop requesting fresh tiles past
    // this zoom — the client just stretches the coarser tile at deeper views.
    // Used for layers whose upstream source has coarse native resolution
    // (e.g. UKSO 1km rasters that otherwise render with tile-boundary artifacts).
    maxNativeZoom: def.maxNativeZoom ?? null,
  }));
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return false;
  if (CORS_ORIGINS.includes(origin)) return true;
  if (!ALLOW_LOCAL_DEV_ORIGINS) return false;
  try {
    const u = new URL(origin);
    const localHost =
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      /^10\./.test(u.hostname) ||
      /^192\.168\./.test(u.hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(u.hostname);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      localHost
    );
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // Authorization is required by the new /api/fields/.../extract routes
  // (Supabase JWT bearer). Without it, browsers fail the preflight check
  // even though the OPTIONS response itself returns 204.
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization"
  );
  res.setHeader("Access-Control-Max-Age", "600");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let len = 0;
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      buf += chunk;
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function forwardOverpass(bodyEncoded) {
  const cached = overpassCache.get(bodyEncoded);
  const now = Date.now();
  if (cached && now - cached.t < OVERPASS_CACHE_TTL_MS) return cached;

  overpassChain = overpassChain.then(async () => {
    let out = null;
    for (const endpoint of OVERPASS_URLS) {
      const n = Date.now();
      const wait = Math.max(0, lastOverpassAt + OVERPASS_MIN_GAP_MS - n);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      lastOverpassAt = Date.now();

      const res = await fetch(`${endpoint}?${bodyEncoded}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": OSM_USER_AGENT,
        },
      });
      const text = await res.text();
      const retryAfter = res.headers.get("retry-after") || res.headers.get("Retry-After") || null;
      out = { t: Date.now(), status: res.status, text, retryAfter };
      if (res.status === 200) break;
      if (!(res.status === 406 || res.status === 429 || res.status >= 500)) break;
    }
    if (!out) out = { t: Date.now(), status: 502, text: "", retryAfter: null };
    overpassCache.set(bodyEncoded, out);
    if (overpassCache.size > 500) {
      const firstKey = overpassCache.keys().next().value;
      if (firstKey) overpassCache.delete(firstKey);
    }
    return out;
  });

  return await overpassChain;
}

async function forwardNominatim(pathWithQuery) {
  let q = pathWithQuery.includes("?") ? pathWithQuery.slice(pathWithQuery.indexOf("?")) : "";
  const path = pathWithQuery.includes("?") ? pathWithQuery.slice(0, pathWithQuery.indexOf("?")) : pathWithQuery;
  if (OSM_CONTACT_EMAIL && !q.includes("email=")) {
    q += `${q ? "&" : "?"}email=${encodeURIComponent(OSM_CONTACT_EMAIL)}`;
  }
  const url = `${NOMINATIM_URL}${path}${q}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": OSM_USER_AGENT,
    },
  });
  const text = await res.text();
  return { status: res.status, text };
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let u;
  try {
    u = new URL(req.url || "/", `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  const { pathname } = u;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && pathname === "/api/market/status") {
    json(res, 200, marketStatus());
    return;
  }

  if (req.method === "GET" && pathname === "/api/market/prices") {
    try {
      const refresh = u.searchParams.get("refresh") === "1";
      const result = await getMarketPrices({ refresh });
      json(res, 200, result);
    } catch (err) {
      json(res, 502, { ok: false, error: err?.message || "could not load market prices" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/farms/current") {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) return json(res, auth.error.status, auth.error.body);
      const admin = adminClient();
      if (!admin) return json(res, 503, { error: "supabase service not configured" });

      const { data: owned, error: ownedError } = await admin
        .from("farms")
        .select("*")
        .eq("owner_user_id", auth.userId)
        .order("created_at", { ascending: true })
        .limit(1);
      if (ownedError) throw new Error(ownedError.message);
      if (owned?.[0]) return json(res, 200, { ok: true, farm: owned[0], source: "owner" });

      const { data: memberships, error: memberError } = await admin
        .from("farm_members")
        .select("role, farms(*)")
        .eq("user_id", auth.userId)
        .order("created_at", { ascending: true })
        .limit(1);
      if (memberError) throw new Error(memberError.message);
      return json(res, 200, {
        ok: true,
        farm: memberships?.[0]?.farms || null,
        source: memberships?.[0] ? "member" : "none",
      });
    } catch (err) {
      json(res, 500, { error: err?.message || "could not load farm" });
    }
    return;
  }

  const farmFieldsMatch = /^\/api\/farms\/([^/]+)\/fields$/.exec(pathname);
  if (req.method === "GET" && farmFieldsMatch) {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) return json(res, auth.error.status, auth.error.body);
      const admin = adminClient();
      if (!admin) return json(res, 503, { error: "supabase service not configured" });
      const farmId = decodeURIComponent(farmFieldsMatch[1]);
      const canRead = await userCanReadFarm(auth.userId, farmId);
      if (!canRead) return json(res, 403, { error: "farm not found or access denied" });
      const { data, error } = await admin
        .from("tilth_fields")
        .select("*")
        .eq("farm_id", farmId)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true, fields: data || [] });
    } catch (err) {
      json(res, 500, { error: err?.message || "could not load fields" });
    }
    return;
  }

  if (pathname.startsWith("/api/document-vault/")) {
    const handled = await handleDocumentVaultRoute(req, res, u, json);
    if (handled) return;
  }

  if (pathname.startsWith("/api/platform-assistant/")) {
    const handled = await handlePlatformAssistantRoute(req, res, u, json);
    if (handled) return;
  }

  if (req.method === "POST" && pathname === "/api/calendar/google/connect") {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) return json(res, auth.error.status, auth.error.body);
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALENDAR_REDIRECT_URL) {
        return json(res, 503, { error: "Google Calendar OAuth env vars are not configured" });
      }
      const body = await readJsonBody(req);
      const farmId = String(body.farmId || "");
      const can = await userCanEditFarm(auth.userId, farmId);
      if (!can) return json(res, 403, { error: "farm not found or access denied" });
      const state = randomUUID();
      const admin = adminClient();
      const { error } = await admin.from("google_calendar_connections").upsert(
        {
          farm_id: farmId,
          user_id: auth.userId,
          oauth_state: state,
          status: "pending",
          updated_at: new Date().toISOString(),
          error_message: null,
        },
        { onConflict: "farm_id,user_id" }
      );
      if (error) throw new Error(error.message);
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", GOOGLE_CALENDAR_REDIRECT_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("scope", "openid email https://www.googleapis.com/auth/calendar");
      authUrl.searchParams.set("state", state);
      json(res, 200, { authUrl: authUrl.toString() });
    } catch (err) {
      json(res, 500, { error: err?.message || "could not create google connect url" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/calendar/google/callback") {
    try {
      await handleGoogleCalendarCallback(u);
      res.writeHead(302, { Location: `${GOOGLE_CALENDAR_APP_REDIRECT_URL}?calendar=connected` });
      res.end();
    } catch (err) {
      const target = new URL(GOOGLE_CALENDAR_APP_REDIRECT_URL);
      target.searchParams.set("calendar", "error");
      target.searchParams.set("message", err?.message || "Google Calendar connection failed");
      res.writeHead(302, { Location: target.toString() });
      res.end();
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/calendar/google/status") {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) return json(res, auth.error.status, auth.error.body);
      const farmId = String(u.searchParams.get("farmId") || "");
      const can = await userCanEditFarm(auth.userId, farmId);
      if (!can) return json(res, 403, { error: "farm not found or access denied" });
      const admin = adminClient();
      const { data, error } = await admin
        .from("google_calendar_connections")
        .select("status,google_email,google_calendar_id,last_synced_at,error_message")
        .eq("farm_id", farmId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      json(res, 200, { connected: data?.status === "connected", connection: data || null });
    } catch (err) {
      json(res, 500, { error: err?.message || "could not read calendar status" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/calendar/google/sync") {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) return json(res, auth.error.status, auth.error.body);
      const body = await readJsonBody(req);
      const farmId = String(body.farmId || "");
      const can = await userCanEditFarm(auth.userId, farmId);
      if (!can) return json(res, 403, { error: "farm not found or access denied" });
      const result = await syncGoogleCalendarTasks(
        auth.userId,
        farmId,
        Array.isArray(body.tasks) ? body.tasks : null
      );
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: err?.message || "could not sync calendar" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/calendar/google/disconnect") {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) return json(res, auth.error.status, auth.error.body);
      const body = await readJsonBody(req);
      const farmId = String(body.farmId || "");
      const admin = adminClient();
      const { error } = await admin
        .from("google_calendar_connections")
        .delete()
        .eq("farm_id", farmId)
        .eq("user_id", auth.userId);
      if (error) throw new Error(error.message);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err?.message || "could not disconnect calendar" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/osm/field-at-point") {
    try {
      const body = await readJsonBody(req);
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const radiusM = Math.min(4000, Math.max(40, Number(body.radiusM) || 220));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        json(res, 400, { error: "invalid lat/lng" });
        return;
      }
      const q = landuseAroundQuery(lat, lng, radiusM);
      const bodyEncoded = `data=${encodeURIComponent(q)}`;
      const { status, text, retryAfter } = await forwardOverpass(bodyEncoded);
      if (status !== 200) {
        if (status === 429 && retryAfter) res.setHeader("Retry-After", String(retryAfter));
        json(res, status, { error: "overpass upstream", outline: null, retryAfter: retryAfter || null });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        json(res, 502, { error: "invalid JSON from overpass", outline: null });
        return;
      }
      const outline = pickSmallestLandOutlineAtPoint(parsed, lat, lng);
      json(res, 200, { outline });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e), outline: null });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/nominatim/")) {
    try {
      const sub = pathname.slice("/api/nominatim".length) || "/";
      const pathWithQuery = `${sub}${u.search || ""}`;
      const { status, text } = await forwardNominatim(pathWithQuery);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(text);
    } catch (e) {
      json(res, 502, { error: String(e?.message || e) });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/wms/layers") {
    json(res, 200, { layers: layerManifest() });
    return;
  }

  if (req.method === "GET" && /^\/api\/wms\/[^/]+\/legend$/.test(pathname)) {
    try {
      const id = decodeURIComponent(
        pathname.slice("/api/wms/".length).replace(/\/legend$/, "")
      );
      const def = WMS_LAYERS[id];
      if (!def) {
        json(res, 404, { error: "unknown layer", id });
        return;
      }
      const cached = legendGet(id);
      if (cached) {
        json(res, 200, {
          id,
          cache: "HIT",
          attribution: def.attribution || "",
          ...cached,
        });
        return;
      }
      const data = await fetchLegend(def);
      legendSet(id, data);
      json(res, 200, {
        id,
        cache: "MISS",
        attribution: def.attribution || "",
        ...data,
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  if (req.method === "GET" && /^\/api\/wms\/[^/]+\/identify$/.test(pathname)) {
    try {
      const id = decodeURIComponent(
        pathname.slice("/api/wms/".length).replace(/\/identify$/, "")
      );
      const def = WMS_LAYERS[id];
      if (!def) {
        json(res, 404, { error: "unknown layer", id });
        return;
      }
      const lon = Number(u.searchParams.get("lon"));
      const lat = Number(u.searchParams.get("lat"));
      const zParam = u.searchParams.get("z");
      const zoom = zParam == null ? null : Number(zParam);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        json(res, 400, { error: "invalid lon/lat" });
        return;
      }
      const result = await identifyForLayer(def, lon, lat, {
        zoom: Number.isFinite(zoom) ? zoom : null,
      });
      json(res, 200, {
        ok: true,
        id,
        label: def.label || id,
        kind: def.kind,
        attribution: def.attribution || "",
        features: result.features || [],
        upstreamStatus: result.status || 0,
        ...(result.info_format ? { infoFormat: result.info_format } : {}),
        ...(result.error ? { upstreamError: String(result.error).slice(0, 240) } : {}),
      });
    } catch (e) {
      console.warn("[tilth-api] /api/wms/:id/identify crashed:", e?.message || e);
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  if (req.method === "GET" && /^\/api\/wms\/[^/]+\/export$/.test(pathname)) {
    try {
      const id = decodeURIComponent(
        pathname.slice("/api/wms/".length).replace(/\/export$/, "")
      );
      const def = WMS_LAYERS[id];
      if (!def) {
        json(res, 404, { error: "unknown layer", id });
        return;
      }
      const bboxRaw = u.searchParams.get("bbox") || "";
      const sizeRaw = u.searchParams.get("size") || "";
      const bboxParts = bboxRaw.split(",").map((s) => Number(s.trim()));
      const sizeParts = sizeRaw.split(",").map((s) => Number(s.trim()));
      if (
        bboxParts.length !== 4 ||
        bboxParts.some((n) => !Number.isFinite(n)) ||
        sizeParts.length !== 2 ||
        sizeParts.some((n) => !Number.isFinite(n))
      ) {
        json(res, 400, { error: "invalid bbox or size" });
        return;
      }
      const [minx, miny, maxx, maxy] = bboxParts;
      const [wRaw, hRaw] = sizeParts;
      const w = Math.max(16, Math.min(2048, Math.round(wRaw)));
      const h = Math.max(16, Math.min(2048, Math.round(hRaw)));
      if (
        !(maxx > minx) ||
        !(maxy > miny) ||
        Math.abs(minx) > MERC_EDGE * 2 ||
        Math.abs(maxx) > MERC_EDGE * 2 ||
        Math.abs(miny) > MERC_EDGE * 2 ||
        Math.abs(maxy) > MERC_EDGE * 2
      ) {
        json(res, 400, { error: "invalid bbox bounds" });
        return;
      }
      const upstream = buildUpstreamExportUrl(def, minx, miny, maxx, maxy, w, h);
      if (!upstream) {
        json(res, 400, { error: "layer kind not exportable", kind: def.kind });
        return;
      }
      // Cache key snaps bbox to 1m and size exactly so neighbouring requests
      // during a continuous pan/zoom can still hit the LRU.
      const cacheKey = [
        "export",
        id,
        Math.round(minx),
        Math.round(miny),
        Math.round(maxx),
        Math.round(maxy),
        w,
        h,
      ].join("|");
      const hit = cacheGet(cacheKey);
      if (hit) {
        res.writeHead(200, {
          "Content-Type": hit.contentType || "image/png",
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "HIT",
        });
        res.end(hit.body);
        return;
      }
      const result = await fetchTile(upstream);
      if (result.ok && /^image\//.test(result.contentType || "")) {
        cacheSet(cacheKey, {
          t: Date.now(),
          contentType: result.contentType,
          body: result.body,
        });
        res.writeHead(200, {
          "Content-Type": result.contentType,
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "MISS",
        });
        res.end(result.body);
        return;
      }
      if (result.text) {
        console.warn(
          `[tilth-api] WMS ${id} export ${bboxRaw} ${w}x${h} upstream ${result.status}: ${result.text.slice(0, 160)}`
        );
      }
      cacheSet(cacheKey, {
        t: Date.now() - WMS_CACHE_TTL_MS + 60_000,
        contentType: "image/png",
        body: TRANSPARENT_PNG,
      });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
        "X-Tilth-Cache": "ERROR",
        "X-Tilth-Upstream-Status": String(result.status || 0),
      });
      res.end(TRANSPARENT_PNG);
    } catch (e) {
      console.warn("[tilth-api] /api/wms/:id/export crashed:", e?.message || e);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
      });
      res.end(TRANSPARENT_PNG);
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/wms/")) {
    try {
      const id = decodeURIComponent(pathname.slice("/api/wms/".length));
      const def = WMS_LAYERS[id];
      if (!def) {
        json(res, 404, { error: "unknown layer", id });
        return;
      }
      const z = Number(u.searchParams.get("z"));
      const x = Number(u.searchParams.get("x"));
      const y = Number(u.searchParams.get("y"));
      if (
        !Number.isFinite(z) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        z < 0 ||
        z > 22 ||
        x < 0 ||
        y < 0 ||
        x >= 2 ** z ||
        y >= 2 ** z
      ) {
        json(res, 400, { error: "invalid z/x/y" });
        return;
      }
      if (z < (def.minZoom || 0) || z > (def.maxZoom || 19)) {
        // Outside the layer's useful zoom range — send a transparent tile so
        // the map renders cleanly rather than a patchwork of 404s.
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(TRANSPARENT_PNG);
        return;
      }
      const cacheKey = `${id}|${z}|${x}|${y}`;
      const hit = cacheGet(cacheKey);
      if (hit) {
        res.writeHead(200, {
          "Content-Type": hit.contentType || "image/png",
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "HIT",
        });
        res.end(hit.body);
        return;
      }
      const upstream = buildUpstreamTileUrl(def, z, Math.trunc(x), Math.trunc(y));
      if (!upstream) {
        json(res, 500, { error: "unsupported layer kind", kind: def.kind });
        return;
      }
      const result = await fetchTile(upstream);
      if (result.ok && /^image\//.test(result.contentType || "")) {
        cacheSet(cacheKey, {
          t: Date.now(),
          contentType: result.contentType,
          body: result.body,
        });
        res.writeHead(200, {
          "Content-Type": result.contentType,
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "MISS",
        });
        res.end(result.body);
        return;
      }
      // Upstream failed (CORS, 4xx/5xx, XML service exception, network) —
      // paint a transparent tile so the overlay quietly drops rather than
      // breaks the client. Cache briefly so we don't hammer a failing origin.
      if (result.text) {
        console.warn(
          `[tilth-api] WMS ${id} z=${z} x=${x} y=${y} upstream ${result.status}: ${result.text.slice(0, 160)}`
        );
      }
      cacheSet(cacheKey, {
        t: Date.now() - WMS_CACHE_TTL_MS + 60_000, // only cache the failure for ~1 min
        contentType: "image/png",
        body: TRANSPARENT_PNG,
      });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
        "X-Tilth-Cache": "ERROR",
        "X-Tilth-Upstream-Status": String(result.status || 0),
      });
      res.end(TRANSPARENT_PNG);
    } catch (e) {
      console.warn("[tilth-api] /api/wms/:id crashed:", e?.message || e);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
      });
      res.end(TRANSPARENT_PNG);
    }
    return;
  }

  // --- Per-field × per-layer extraction routes ----------------------------
  // (Defined inline rather than as a separate listener because the original
  // request handler ends the response with a 404 for unmatched paths, so a
  // second `server.on('request')` would never see anything reach it.)

  if (req.method === "GET" && pathname === "/api/extract/queue") {
    const auth = await authenticatedUser(req);
    if (auth.error) {
      json(res, auth.error.status, auth.error.body);
      return;
    }
    json(res, 200, { ok: true, ...queueStatus(), supabase: supabaseConfigured });
    return;
  }

  let extractMatch = /^\/api\/fields\/([^/]+)\/extract$/.exec(pathname);
  if (req.method === "POST" && extractMatch) {
    try {
      const fieldId = decodeURIComponent(extractMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const layerIds = extractableLayerIds();
      const queued = enqueueExtractAll({
        fieldId: auth.field.id,
        field: auth.field,
        layerIds,
      });
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        totalLayers: layerIds.length,
        queued,
        skipped: layerIds.length - queued,
        queue: queueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  extractMatch = /^\/api\/fields\/([^/]+)\/layers\/([^/]+)\/extract$/.exec(pathname);
  if (req.method === "POST" && extractMatch) {
    try {
      const fieldId = decodeURIComponent(extractMatch[1]);
      const layerId = decodeURIComponent(extractMatch[2]);
      if (!Object.prototype.hasOwnProperty.call(WMS_LAYERS, layerId)) {
        json(res, 404, { error: "unknown layer", layerId });
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(EXTRACT_CONFIG, layerId)) {
        json(res, 422, { error: "layer has no extraction strategy", layerId });
        return;
      }
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const queued = enqueueExtraction({
        fieldId: auth.field.id,
        layerId,
        field: auth.field,
      });
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        layerId,
        queued,
        queue: queueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  extractMatch = /^\/api\/fields\/([^/]+)\/layers$/.exec(pathname);
  if (req.method === "GET" && extractMatch) {
    try {
      const fieldId = decodeURIComponent(extractMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const admin = adminClient();
      if (!admin) {
        json(res, 503, { error: "supabase service not configured" });
        return;
      }
      const { data, error } = await admin
        .from("tilth_field_layer_data")
        .select("layer_id, strategy, status, error_message, feature_count, updated_at, upstream_version")
        .eq("field_id", auth.field.id);
      if (error) {
        json(res, 500, { error: error.message });
        return;
      }
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        rows: data || [],
        queue: queueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  // --- Sentinel-2 NDVI routes --------------------------------------------
  // Trigger an ingest pass for one field. Returns immediately — work is
  // done in the background and surfaces via Realtime on
  // `tilth_field_ndvi`. Mirrors the per-layer extraction trigger pattern.
  let sentinelMatch = /^\/api\/fields\/([^/]+)\/ndvi\/refresh$/.exec(pathname);
  if (req.method === "POST" && sentinelMatch) {
    try {
      const fieldId = decodeURIComponent(sentinelMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        // Body is optional — defaults from .env apply if it's missing/invalid.
        body = {};
      }
      const queued = enqueueNdviIngest({
        fieldId: auth.field.id,
        field: auth.field,
        lookbackDays: Number.isFinite(Number(body?.lookbackDays))
          ? Number(body.lookbackDays)
          : undefined,
        maxCloudCover: Number.isFinite(Number(body?.maxCloudCover))
          ? Number(body.maxCloudCover)
          : undefined,
        sceneLimit: Number.isFinite(Number(body?.sceneLimit))
          ? Number(body.sceneLimit)
          : undefined,
        force: Boolean(body?.force),
      });
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        queued,
        queue: ingestQueueStatus(),
        mpc: mpcConfigSummary(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  // List cached NDVI scenes for one field. The frontend's realtime hook
  // does an initial select against this same table; this route is here
  // as a non-Supabase fallback (e.g. server-side rendering, debugging).
  sentinelMatch = /^\/api\/fields\/([^/]+)\/ndvi$/.exec(pathname);
  if (req.method === "GET" && sentinelMatch) {
    try {
      const fieldId = decodeURIComponent(sentinelMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const admin = adminClient();
      if (!admin) {
        json(res, 503, { error: "supabase service not configured" });
        return;
      }
      const { data, error } = await admin
        .from("tilth_field_ndvi")
        .select(
          "item_id, collection, scene_datetime, scene_week, scene_year, scene_cloud_pct, ndvi_mean, ndvi_min, ndvi_max, ndvi_median, ndvi_stddev, evi_mean, ndwi_mean, ndmi_mean, ndre_mean, savi_mean, nbr_mean, valid_pixel_count, total_pixel_count, field_cloud_pct, status, error_message, updated_at"
        )
        .eq("field_id", auth.field.id)
        .order("scene_datetime", { ascending: false });
      if (error) {
        json(res, 500, { error: error.message });
        return;
      }
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        rows: data || [],
        queue: ingestQueueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  // NDVI tile proxy. The frontend overlays a per-scene NDVI raster onto
  // the satellite map; tiles are 256×256 PNGs rendered by titiler on
  // MPC. We proxy through here so:
  //   - the browser sees same-origin URLs (no CORS preflight),
  //   - we can cache (MPC asset SAS tokens are short-lived; rendered
  //     PNGs are fine to cache for days),
  //   - we have one place to add monitoring / fallback.
  // Path shape: /api/sentinel/tiles/:item/:z/:x/:y.png?collection=...&kind=ndvi|truecolor
  sentinelMatch = /^\/api\/sentinel\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
  if (req.method === "GET" && sentinelMatch) {
    try {
      const itemId = decodeURIComponent(sentinelMatch[1]);
      const z = Number(sentinelMatch[2]);
      const x = Number(sentinelMatch[3]);
      const y = Number(sentinelMatch[4]);
      const collection = (u.searchParams.get("collection") || "sentinel-2-l2a").trim();
      const index = (u.searchParams.get("index") || "ndvi").trim().toLowerCase();
      const rescale = (u.searchParams.get("rescale") || "").trim();
      const colormap = (u.searchParams.get("colormap") || "").trim();
      // `mask=raw` lets callers ask for un-masked NDVI (no SCL gate).
      // Defaults to the SCL-masked expression so cloud / shadow / water
      // pixels render transparent and don't pollute the visual.
      const applySclMask = (u.searchParams.get("mask") || "scl").trim().toLowerCase() !== "raw";
      // `expression` is reserved for advanced overrides — default is NDVI.
      const expression = (u.searchParams.get("expression") || "").trim() || undefined;
      if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) || z < 0 || z > 22) {
        json(res, 400, { error: "invalid z/x/y" });
        return;
      }
      const cfg = ndviRender.spectralTileConfig?.(index) || ndviRender.spectralTileConfig?.("ndvi");
      const effectiveRescale = rescale || cfg?.rescale || ndviRender.defaultRescale;
      const effectiveColormap = colormap || cfg?.colormap || ndviRender.defaultColormap;
      const cacheKey = `sentinel|${collection}|${itemId}|${z}|${x}|${y}|${index}|${effectiveRescale}|${effectiveColormap}|${applySclMask ? "scl" : "raw"}|${expression || "default"}`;
      const hit = sentinelCacheGet(cacheKey);
      if (hit) {
        res.writeHead(200, {
          "Content-Type": hit.contentType || "image/png",
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "HIT",
        });
        res.end(hit.body);
        return;
      }
      const upstreamUrl = buildSpectralIndexTileUrl({
        collection,
        itemId,
        z,
        x,
        y,
        index,
        opts: { rescale: effectiveRescale, colormap: effectiveColormap, expression, applySclMask },
      });
      const result = await fetchTitilerTile(upstreamUrl);
      if (result.ok && /^image\//.test(result.contentType || "")) {
        sentinelCacheSet(cacheKey, {
          t: Date.now(),
          contentType: result.contentType,
          body: result.body,
        });
        res.writeHead(200, {
          "Content-Type": result.contentType,
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "MISS",
        });
        res.end(result.body);
        return;
      }
      if (result.text) {
        console.warn(
          `[tilth-api] Sentinel tile ${itemId} ${z}/${x}/${y} upstream ${result.status}: ${result.text.slice(0, 160)}`
        );
      }
      // Cache the failure briefly so we don't hammer MPC if it 404s.
      sentinelCacheSet(cacheKey, {
        t: Date.now() - SENTINEL_TILE_CACHE_TTL_MS + 60_000,
        contentType: "image/png",
        body: TRANSPARENT_PNG,
      });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
        "X-Tilth-Cache": "ERROR",
        "X-Tilth-Upstream-Status": String(result.status || 0),
      });
      res.end(TRANSPARENT_PNG);
    } catch (e) {
      console.warn("[tilth-api] /api/sentinel/tiles crashed:", e?.message || e);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
      });
      res.end(TRANSPARENT_PNG);
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/sentinel/status") {
    const auth = await authenticatedUser(req);
    if (auth.error) {
      json(res, auth.error.status, auth.error.body);
      return;
    }
    json(res, 200, {
      ok: true,
      mpc: mpcConfigSummary(),
      queue: ingestQueueStatus(),
      tileCache: { size: sentinelTileCache.size, max: SENTINEL_TILE_CACHE_MAX },
      supabase: supabaseConfigured,
    });
    return;
  }

  // --- Sentinel-1 SAR routes ---------------------------------------------
  // Trigger a SAR ingest for one field. Returns immediately — work
  // happens in the background and surfaces via Realtime on
  // `tilth_field_sar`. The frontend workspace UI is still pending; this
  // endpoint exists so we can backfill the cache and inspect data with
  // tools while the visualisation lands.
  let sarMatch = /^\/api\/fields\/([^/]+)\/sar\/refresh$/.exec(pathname);
  if (req.method === "POST" && sarMatch) {
    try {
      const fieldId = decodeURIComponent(sarMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const queued = enqueueSarIngest({
        fieldId: auth.field.id,
        field: auth.field,
        lookbackDays: Number.isFinite(Number(body?.lookbackDays))
          ? Number(body.lookbackDays)
          : undefined,
        sceneLimit: Number.isFinite(Number(body?.sceneLimit))
          ? Number(body.sceneLimit)
          : undefined,
        force: Boolean(body?.force),
      });
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        queued,
        queue: sarQueueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  // List cached SAR scenes for one field. Same shape as the NDVI list
  // route — non-Supabase fallback for SSR / debugging.
  sarMatch = /^\/api\/fields\/([^/]+)\/sar$/.exec(pathname);
  if (req.method === "GET" && sarMatch) {
    try {
      const fieldId = decodeURIComponent(sarMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const admin = adminClient();
      if (!admin) {
        json(res, 503, { error: "supabase service not configured" });
        return;
      }
      const { data, error } = await admin
        .from("tilth_field_sar")
        .select(
          "item_id, collection, scene_datetime, scene_week, scene_year, orbit_state, relative_orbit, vv_mean, vv_mean_db, vv_median, vv_stddev, vh_mean, vh_mean_db, vh_median, vh_stddev, vh_vv_ratio_mean, vh_vv_ratio_mean_db, valid_pixel_count, total_pixel_count, status, error_message, updated_at"
        )
        .eq("field_id", auth.field.id)
        .order("scene_datetime", { ascending: false });
      if (error) {
        json(res, 500, { error: error.message });
        return;
      }
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        rows: data || [],
        queue: sarQueueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  // SAR tile proxy. Same shape as /api/sentinel/tiles but for
  // Sentinel-1 RTC backscatter. `band` selects the polarisation
  // visualised; default vh.
  // Path: /api/sentinel1/tiles/:item/:z/:x/:y.png?collection=...&band=vh|vv|ratio&rescale=...&colormap=...
  let sarTileMatch = /^\/api\/sentinel1\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
  if (req.method === "GET" && sarTileMatch) {
    try {
      const itemId = decodeURIComponent(sarTileMatch[1]);
      const z = Number(sarTileMatch[2]);
      const x = Number(sarTileMatch[3]);
      const y = Number(sarTileMatch[4]);
      const collection = (
        u.searchParams.get("collection") || "sentinel-1-rtc"
      ).trim();
      const band = (u.searchParams.get("band") || "vh").trim().toLowerCase();
      const bandDefaults = sarRender.bands[band] || sarRender.bands.vh;
      const rescale = (
        u.searchParams.get("rescale") || bandDefaults.rescale
      ).trim();
      const colormap = (
        u.searchParams.get("colormap") || bandDefaults.colormap
      ).trim();
      const expression = (u.searchParams.get("expression") || "").trim() || undefined;
      if (
        !Number.isFinite(z) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        z < 0 ||
        z > 22
      ) {
        json(res, 400, { error: "invalid z/x/y" });
        return;
      }
      const cacheKey = `sar|${collection}|${itemId}|${z}|${x}|${y}|${band}|${rescale}|${colormap}|${expression || "default"}`;
      const hit = sentinelCacheGet(cacheKey);
      if (hit) {
        res.writeHead(200, {
          "Content-Type": hit.contentType || "image/png",
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "HIT",
        });
        res.end(hit.body);
        return;
      }
      const upstreamUrl = buildSarTileUrl({
        collection,
        itemId,
        band,
        z,
        x,
        y,
        opts: { rescale, colormap, expression },
      });
      const result = await fetchTitilerTile(upstreamUrl);
      if (result.ok && /^image\//.test(result.contentType || "")) {
        sentinelCacheSet(cacheKey, {
          t: Date.now(),
          contentType: result.contentType,
          body: result.body,
        });
        res.writeHead(200, {
          "Content-Type": result.contentType,
          "Cache-Control": "public, max-age=86400",
          "X-Tilth-Cache": "MISS",
        });
        res.end(result.body);
        return;
      }
      if (result.text) {
        console.warn(
          `[tilth-api] Sentinel-1 tile ${itemId} ${z}/${x}/${y} band=${band} upstream ${result.status}: ${result.text.slice(0, 160)}`
        );
      }
      sentinelCacheSet(cacheKey, {
        t: Date.now() - SENTINEL_TILE_CACHE_TTL_MS + 60_000,
        contentType: "image/png",
        body: TRANSPARENT_PNG,
      });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
        "X-Tilth-Cache": "ERROR",
        "X-Tilth-Upstream-Status": String(result.status || 0),
      });
      res.end(TRANSPARENT_PNG);
    } catch (e) {
      console.warn(
        "[tilth-api] /api/sentinel1/tiles crashed:",
        e?.message || e
      );
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
      });
      res.end(TRANSPARENT_PNG);
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/sentinel1/status") {
    const auth = await authenticatedUser(req);
    if (auth.error) {
      json(res, auth.error.status, auth.error.body);
      return;
    }
    json(res, 200, {
      ok: true,
      queue: sarQueueStatus(),
      supabase: supabaseConfigured,
    });
    return;
  }

  // --- Elevation (Copernicus DEM 30 m) -----------------------------------
  const elevRefreshMatch = /^\/api\/fields\/([^/]+)\/elevation\/refresh$/.exec(pathname);
  if (req.method === "POST" && elevRefreshMatch) {
    try {
      const fieldId = decodeURIComponent(elevRefreshMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const queued = enqueueElevationIngest({
        fieldId: auth.field.id,
        field: auth.field,
        force: Boolean(body?.force),
      });
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        queued,
        queue: elevationQueueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  const elevGetMatch = /^\/api\/fields\/([^/]+)\/elevation$/.exec(pathname);
  if (req.method === "GET" && elevGetMatch) {
    try {
      const fieldId = decodeURIComponent(elevGetMatch[1]);
      const auth = await authenticatedField(req, fieldId);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const admin = adminClient();
      if (!admin) {
        json(res, 503, { error: "supabase service not configured" });
        return;
      }
      const { data, error } = await admin
        .from("tilth_field_elevation")
        .select("*")
        .eq("field_id", auth.field.id)
        .maybeSingle();
      if (error) {
        json(res, 500, { error: error.message });
        return;
      }
      json(res, 200, {
        ok: true,
        fieldId: auth.field.id,
        elevation: data || null,
        queue: elevationQueueStatus(),
      });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/elevation/status") {
    json(res, 200, {
      ok: true,
      queue: elevationQueueStatus(),
      supabase: supabaseConfigured,
    });
    return;
  }

  // --- Auto-refresh scheduler --------------------------------------------
  if (req.method === "GET" && pathname === "/api/sentinel/scheduler/status") {
    const auth = await authenticatedUser(req);
    if (auth.error) {
      json(res, auth.error.status, auth.error.body);
      return;
    }
    json(res, 200, { ok: true, scheduler: refreshSchedulerStatus() });
    return;
  }
  // Manual trigger — useful for debugging or for an admin "run now"
  // button. Auth-gated lightly: callers must present any valid auth
  // header. The actual sweep runs with the service role.
  if (req.method === "POST" && pathname === "/api/sentinel/scheduler/run") {
    try {
      const auth = await authenticatedUser(req);
      if (auth.error) {
        json(res, auth.error.status, auth.error.body);
        return;
      }
      const result = await runRefreshSweep({ trigger: "manual" });
      json(res, 200, { ok: result.ok, result, scheduler: refreshSchedulerStatus() });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

/* ------------------------------------------------------------------------ *
 *  Per-field × per-layer extraction wiring
 * ------------------------------------------------------------------------ */

// Hand the extractor a way to read the live layer registry + cached legend
// without creating an import cycle back into server.mjs.
setLayerContextProvider(async (layerId) => {
  const def = WMS_LAYERS[layerId] || null;
  if (!def) return { def: null, legend: null };
  let legend = legendGet(layerId);
  if (!legend) {
    try {
      legend = await fetchLegend(def);
      if (legend) legendSet(layerId, legend);
    } catch {
      legend = null;
    }
  }
  return { def, legend };
});

// All layer ids the extractor knows what to do with. Driven off the layer
// manifest crossed with EXTRACT_CONFIG so we never enqueue work for layers
// that aren't actually present in the manifest at runtime.
function extractableLayerIds() {
  const ids = [];
  for (const id of Object.keys(WMS_LAYERS)) {
    const strategy = strategyFor(id);
    if (strategy === "wfs" || strategy === "arcgis_trace") {
      ids.push(id);
    }
  }
  return ids;
}

function bearerFromRequest(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

async function authenticatedUser(req) {
  if (!supabaseConfigured) {
    return { error: { status: 503, body: { error: "supabase service not configured" } } };
  }
  const jwt = bearerFromRequest(req);
  if (!jwt) {
    return { error: { status: 401, body: { error: "missing Authorization: Bearer <jwt>" } } };
  }
  const userId = await userIdFromJwt(jwt);
  if (!userId) {
    return { error: { status: 401, body: { error: "invalid or expired jwt" } } };
  }
  return { userId };
}

async function userCanReadFarm(userId, farmId) {
  if (!userId || !farmId) return false;
  const admin = adminClient();
  if (!admin) return false;
  const { data: farm } = await admin
    .from("farms")
    .select("id")
    .eq("id", farmId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (farm) return true;
  const { data: member } = await admin
    .from("farm_members")
    .select("id")
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(member);
}

async function userCanEditFarm(userId, farmId) {
  if (!userId || !farmId) return false;
  const admin = adminClient();
  if (!admin) return false;
  const { data: farm } = await admin
    .from("farms")
    .select("id")
    .eq("id", farmId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (farm) return true;
  const { data: member } = await admin
    .from("farm_members")
    .select("id")
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .in("role", ["operator", "manager", "admin"])
    .maybeSingle();
  return Boolean(member);
}

async function googleTokenRequest(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Google token request failed");
  return data;
}

async function googleFetch(pathOrUrl, accessToken, options = {}) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://www.googleapis.com/calendar/v3${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || "Google Calendar request failed");
  return data;
}

async function handleGoogleCalendarCallback(url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("Missing Google OAuth code/state");
  const admin = adminClient();
  const { data: connection, error } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("oauth_state", state)
    .maybeSingle();
  if (error || !connection) throw new Error("Unknown or expired calendar connection state");
  const token = await googleTokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_CALENDAR_REDIRECT_URL,
    grant_type: "authorization_code",
    code,
  });
  const accessToken = token.access_token;
  const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then((r) => r.json()).catch(() => ({}));
  const expiresAt = new Date(Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1000).toISOString();
  const { error: updateError } = await admin
    .from("google_calendar_connections")
    .update({
      access_token: accessToken,
      refresh_token: token.refresh_token || connection.refresh_token,
      token_expires_at: expiresAt,
      google_email: profile.email || null,
      oauth_state: null,
      status: "connected",
      updated_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", connection.id);
  if (updateError) throw new Error(updateError.message);
}

async function accessTokenForConnection(connection) {
  if (connection.access_token && connection.token_expires_at && new Date(connection.token_expires_at).getTime() > Date.now() + 60_000) {
    return connection.access_token;
  }
  if (!connection.refresh_token) throw new Error("Google refresh token missing. Reconnect Google Calendar.");
  const token = await googleTokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
  });
  const expiresAt = new Date(Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1000).toISOString();
  const admin = adminClient();
  await admin
    .from("google_calendar_connections")
    .update({
      access_token: token.access_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);
  return token.access_token;
}

async function ensureTilthCalendar(connection, accessToken) {
  if (connection.google_calendar_id) return connection.google_calendar_id;
  let calendar;
  try {
    calendar = await googleFetch("/calendars", accessToken, {
      method: "POST",
      body: JSON.stringify({
        summary: "Tilth Farm Tasks",
        description: "Farm jobs synced from Tilth.",
        timeZone: GOOGLE_CALENDAR_TIMEZONE,
      }),
    });
  } catch (err) {
    if (String(err?.message || "").toLowerCase().includes("insufficient")) {
      throw new Error("Google Calendar needs one extra permission. Disconnect and reconnect Google Calendar, then try Sync now again.");
    }
    throw err;
  }
  const admin = adminClient();
  await admin
    .from("google_calendar_connections")
    .update({ google_calendar_id: calendar.id, updated_at: new Date().toISOString() })
    .eq("id", connection.id);
  return calendar.id;
}

function taskHash(task) {
  return createHash("sha256")
    .update(JSON.stringify({
      title: task.title,
      description: task.description,
      category: task.category,
      priority: task.priority,
      status: task.status,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      notes: task.notes,
    }))
    .digest("hex");
}

function googleEventFromTask(task) {
  const title = task.title || "Tilth task";
  const pieces = [
    task.description,
    task.category ? `Category: ${task.category}` : null,
    task.priority ? `Priority: ${task.priority}` : null,
    task.notes,
    "Synced one-way from Tilth.",
  ].filter(Boolean);
  if (task.dueTime) {
    const start = `${task.dueDate}T${task.dueTime.length === 5 ? `${task.dueTime}:00` : task.dueTime}`;
    const endDate = new Date(`${start}${GOOGLE_CALENDAR_TIMEZONE === "UTC" ? "Z" : ""}`);
    if (!Number.isNaN(endDate.getTime())) endDate.setHours(endDate.getHours() + 1);
    return {
      summary: title,
      description: pieces.join("\n"),
      start: { dateTime: start, timeZone: GOOGLE_CALENDAR_TIMEZONE },
      end: { dateTime: endDate.toISOString(), timeZone: GOOGLE_CALENDAR_TIMEZONE },
      reminders: { useDefault: true },
    };
  }
  const next = new Date(`${task.dueDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    summary: title,
    description: pieces.join("\n"),
    start: { date: task.dueDate },
    end: { date: next.toISOString().slice(0, 10) },
    reminders: { useDefault: true },
  };
}

async function syncGoogleCalendarTasks(userId, farmId, taskOverride = null) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("Google Calendar OAuth env vars are not configured");
  const admin = adminClient();
  const { data: connection, error: connError } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .eq("status", "connected")
    .maybeSingle();
  if (connError) throw new Error(connError.message);
  if (!connection) throw new Error("Google Calendar is not connected");
  const accessToken = await accessTokenForConnection(connection);
  const calendarId = await ensureTilthCalendar(connection, accessToken);
  let tasks = [];
  if (Array.isArray(taskOverride)) {
    tasks = taskOverride;
    await admin.from("farm_app_data").upsert(
      {
        farm_id: farmId,
        namespace: "tasks",
        data: tasks,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "farm_id,namespace" }
    );
  } else {
    const { data: taskStore } = await admin
      .from("farm_app_data")
      .select("data")
      .eq("farm_id", farmId)
      .eq("namespace", "tasks")
      .maybeSingle();
    tasks = Array.isArray(taskStore?.data) ? taskStore.data : [];
  }
  const { data: mappings } = await admin
    .from("google_calendar_event_mappings")
    .select("*")
    .eq("connection_id", connection.id);
  const byTask = new Map((mappings || []).map((m) => [m.task_id, m]));
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  for (const task of tasks) {
    if (!task?.id || !task.dueDate) {
      skipped += 1;
      continue;
    }
    const mapping = byTask.get(task.id);
    const inactive = task.status === "done" || task.status === "cancelled";
    if (inactive) {
      if (mapping?.google_event_id) {
        await googleFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(mapping.google_event_id)}`, accessToken, { method: "DELETE" }).catch(() => null);
        await admin.from("google_calendar_event_mappings").delete().eq("id", mapping.id);
        deleted += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    const hash = taskHash(task);
    if (mapping?.last_task_hash === hash) {
      skipped += 1;
      continue;
    }
    const eventBody = googleEventFromTask(task);
    if (mapping?.google_event_id) {
      await googleFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(mapping.google_event_id)}`, accessToken, {
        method: "PATCH",
        body: JSON.stringify(eventBody),
      });
      await admin
        .from("google_calendar_event_mappings")
        .update({ last_task_hash: hash, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", mapping.id);
      updated += 1;
    } else {
      const event = await googleFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, accessToken, {
        method: "POST",
        body: JSON.stringify(eventBody),
      });
      await admin.from("google_calendar_event_mappings").insert({
        connection_id: connection.id,
        farm_id: farmId,
        task_id: task.id,
        google_event_id: event.id,
        last_task_hash: hash,
        last_synced_at: new Date().toISOString(),
      });
      created += 1;
    }
  }
  await admin
    .from("google_calendar_connections")
    .update({ last_synced_at: new Date().toISOString(), error_message: null, updated_at: new Date().toISOString() })
    .eq("id", connection.id);
  return { ok: true, created, updated, deleted, skipped, total: tasks.length };
}

async function authenticatedField(req, fieldId) {
  if (!supabaseConfigured) {
    return { error: { status: 503, body: { error: "supabase service not configured" } } };
  }
  const jwt = bearerFromRequest(req);
  if (!jwt) {
    return { error: { status: 401, body: { error: "missing Authorization: Bearer <jwt>" } } };
  }
  const userId = await userIdFromJwt(jwt);
  if (!userId) {
    return { error: { status: 401, body: { error: "invalid or expired jwt" } } };
  }
  const field = await fetchOwnedField(userId, fieldId);
  if (!field) {
    return { error: { status: 404, body: { error: "field not found or access denied" } } };
  }
  let boundary = [];
  try {
    if (Array.isArray(field.boundary)) {
      boundary = field.boundary
        .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    }
  } catch {
    boundary = [];
  }
  if (boundary.length < 3) {
    return { error: { status: 400, body: { error: "field boundary has fewer than 3 valid points" } } };
  }
  return {
    field: {
      id: field.id,
      name: field.name,
      farmId: field.farm_id,
      boundary,
    },
  };
}

server.listen(PORT, () => {
  console.log(`Tilth API listening on http://0.0.0.0:${PORT}`);
  console.log(`CORS origins: ${CORS_ORIGINS.join(", ") || "(none)"}`);
  console.log(`Platform assistant OpenAI: ${process.env.OPENAI_API_KEY ? "enabled" : "missing OPENAI_API_KEY"}`);
  console.log(`Platform assistant model: ${process.env.PLATFORM_ASSISTANT_CHAT_MODEL || process.env.DOCUMENT_VAULT_CHAT_MODEL || "gpt-4o-mini"} | timeout ${Math.round(Number(process.env.PLATFORM_ASSISTANT_OPENAI_TIMEOUT_MS || 60_000) / 1000)}s`);
  console.log(`WMS overlay layers: ${Object.keys(WMS_LAYERS).length}`);
  console.log(
    `Extraction: ${supabaseConfigured ? "enabled" : "disabled (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)"} | extractable layers: ${extractableLayerIds().length}`
  );
  const mpc = mpcConfigSummary();
  console.log(
    `Sentinel-2 NDVI: ${supabaseConfigured ? "enabled" : "disabled (needs supabase)"} | MPC subscription key: ${mpc.hasSubscriptionKey ? "set" : "anonymous"}`
  );
  console.log(
    `Google Calendar: ${GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALENDAR_REDIRECT_URL ? "enabled" : "disabled (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_CALENDAR_REDIRECT_URL)"}`
  );
  // Kick off the periodic auto-refresh sweep. Idempotent — only the
  // first call schedules anything. Disabled by REFRESH_DISABLED=1.
  if (supabaseConfigured) {
    startRefreshScheduler();
  } else {
    console.log("[refreshScheduler] skipped — supabase not configured");
  }
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[WARN unhandledRejection]", reason);
});

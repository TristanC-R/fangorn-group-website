import { getTilthApiBase } from "../lib/tilthApi.js";
import { pointInPolygon, ringAreaSqDeg } from "./geoPointInPolygon.js";

const OVERPASS_DEFAULT = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACKS = [
  OVERPASS_DEFAULT,
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const GRASS_TAG_VALUES = new Set([
  "grass",
  "grassland",
  "meadow",
  "pasture",
  "paddock",
  "grazing",
  "hayfield",
  "common",
]);

function tagValue(tags, key) {
  return String(tags?.[key] || "").trim().toLowerCase().replace(/\s+/g, "_");
}

export function classifyOsmLandUse(tags) {
  if (!tags || typeof tags !== "object") return null;
  const landuse = tagValue(tags, "landuse");
  const landcover = tagValue(tags, "landcover");
  const natural = tagValue(tags, "natural");
  const meadow = tagValue(tags, "meadow");
  const produce = tagValue(tags, "produce");
  const crop = tagValue(tags, "crop");
  const usage = tagValue(tags, "usage");
  const leisure = tagValue(tags, "leisure");
  const livestock = tagValue(tags, "livestock");
  const grazing = tagValue(tags, "grazing");
  const grassland = tagValue(tags, "grassland");

  if (
    GRASS_TAG_VALUES.has(landuse) ||
    GRASS_TAG_VALUES.has(landcover) ||
    GRASS_TAG_VALUES.has(natural) ||
    GRASS_TAG_VALUES.has(meadow) ||
    GRASS_TAG_VALUES.has(produce) ||
    GRASS_TAG_VALUES.has(crop) ||
    GRASS_TAG_VALUES.has(usage) ||
    GRASS_TAG_VALUES.has(leisure) ||
    grassland ||
    livestock ||
    grazing ||
    tags.pasture === "yes"
  ) {
    return "grass";
  }
  if (landuse === "forest" || natural === "wood" || natural === "tree_row") return "woodland";
  if (landuse === "reservoir" || natural === "water" || natural === "wetland" || landcover === "water") return "water";
  if (landuse === "farmland" || landuse === "orchard" || landuse === "vineyard") return "arable";
  if (landuse === "farmyard") return "other";
  return null;
}

function labelFromTags(tags) {
  if (!tags || typeof tags !== "object") return "Land outline";
  if (tags.name) return String(tags.name);
  if (tags.ref) return `${tags.landuse || "land"} (${tags.ref})`;
  if (tags.landuse) return String(tags.landuse).replace(/_/g, " ");
  if (tags.landcover) return String(tags.landcover).replace(/_/g, " ");
  if (tags.natural) return String(tags.natural).replace(/_/g, " ");
  return "Land outline";
}

function closeRing(ring) {
  if (!ring?.length) return null;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a.lat === b.lat && a.lng === b.lng) return ring;
  return [...ring, { lat: a.lat, lng: a.lng }];
}

/** Overpass QL: landuse ways near a point (used client + tilth-api). */
export function landuseAroundQuery(lat, lng, radiusM) {
  const r = Math.round(radiusM);
  return `[out:json][timeout:25];
(
  way["landuse"~"^(farmland|grass|grassland|meadow|pasture|paddock|orchard|farmyard|vineyard)$"](around:${r},${lat},${lng});
  way["landcover"~"^(grass|grassland)$"](around:${r},${lat},${lng});
  way["natural"="grassland"](around:${r},${lat},${lng});
  way["meadow"](around:${r},${lat},${lng});
  way["grazing"](around:${r},${lat},${lng});
  way["pasture"="yes"](around:${r},${lat},${lng});
  way["crop"="grass"](around:${r},${lat},${lng});
  way["usage"="grazing"](around:${r},${lat},${lng});
  way["grassland"](around:${r},${lat},${lng});
  way["leisure"="common"](around:${r},${lat},${lng});
);
out meta tags geom;`;
}

function ringsFromElement(el) {
  if (el.type === "way" && Array.isArray(el.geometry)) {
    const ring = closeRing(el.geometry.map((n) => ({ lat: n.lat, lng: n.lon })));
    return ring ? [ring] : [];
  }
  if (el.type === "relation" && Array.isArray(el.members)) {
    return el.members
      .filter((member) => (!member.role || member.role === "outer") && Array.isArray(member.geometry))
      .map((member) => closeRing(member.geometry.map((n) => ({ lat: n.lat, lng: n.lon }))))
      .filter(Boolean);
  }
  return [];
}

/**
 * From Overpass JSON, pick the smallest closed landuse way whose ring contains (lat, lng).
 * @returns {{ id: string, label: string, tags: object, ring: { lat: number, lng: number }[] } | null}
 */
export function pickSmallestLandOutlineAtPoint(overpassJson, lat, lng) {
  const elements = overpassJson?.elements;
  if (!Array.isArray(elements)) return null;
  const hits = [];
  for (const el of elements) {
    const rings = ringsFromElement(el);
    for (const ring of rings) {
      if (!ring || ring.length < 4) continue;
      if (!pointInPolygon(lat, lng, ring)) continue;
      hits.push({
        id: `${el.type}/${el.id}`,
        label: labelFromTags(el.tags),
        tags: el.tags || {},
        landUse: classifyOsmLandUse(el.tags),
        ring,
        element: el,
        area: ringAreaSqDeg(ring),
      });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.area - b.area);
  const best = hits[0];
  return { id: best.id, label: best.label, tags: best.tags, landUse: best.landUse, ring: best.ring, element: best.element };
}

async function fetchOutlineFromOverpass(lat, lng, radiusM, opts = {}) {
  const q = landuseAroundQuery(lat, lng, radiusM);
  const body = `data=${encodeURIComponent(q)}`;
  const endpoints = opts.endpoint
    ? [opts.endpoint]
    : OVERPASS_FALLBACKS;
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${endpoint}?${body}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: opts.signal,
      });
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after") || res.headers.get("Retry-After") || null;
        const err = new Error(
          res.status === 429
            ? `Overpass rate-limited (HTTP 429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`
            : `Overpass HTTP ${res.status}`
        );
        err.status = res.status;
        err.retryAfter = retryAfter;
        lastError = err;
        if (res.status === 429 || res.status >= 500 || res.status === 406) continue;
        throw err;
      }
      const json = await res.json();
      const outline = pickSmallestLandOutlineAtPoint(json, lat, lng);
      if (outline || endpoint === endpoints[endpoints.length - 1]) return outline;
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
    }
  }

  throw lastError || new Error("Overpass lookup failed");
}

/**
 * One-shot: land polygons near the click, return at most one outline that contains the point.
 * @param {{ signal?: AbortSignal, radiusM?: number, endpoint?: string }} [opts]
 */
export async function fetchOsmFieldAtPoint(lat, lng, opts = {}) {
  const radiusM = Math.min(5000, Math.max(80, opts.radiusM ?? 1200));
  const signal = opts.signal;
  const api = getTilthApiBase();
  if (api) {
    const res = await fetch(`${api}/api/osm/field-at-point`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ lat, lng, radiusM }),
      signal,
    });
    if (!res.ok) {
      let retryAfter = null;
      try {
        const j = await res.json();
        retryAfter = j?.retryAfter ?? null;
      } catch {
        /* ignore */
      }
      const err = new Error(
        res.status === 429
          ? `Overpass rate-limited (HTTP 429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`
          : `Tilth API field-at-point ${res.status}`
      );
      err.status = res.status;
      err.retryAfter = retryAfter;
      throw err;
    }
    const data = await res.json();
    if (data.outline) return data.outline;
    return fetchOutlineFromOverpass(lat, lng, radiusM, opts);
  }

  return fetchOutlineFromOverpass(lat, lng, radiusM, { ...opts, signal });
}

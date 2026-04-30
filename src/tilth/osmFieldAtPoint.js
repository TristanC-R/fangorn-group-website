import { getTilthApiBase } from "../lib/tilthApi.js";
import { pointInPolygon, ringAreaSqDeg } from "./geoPointInPolygon.js";

const OVERPASS_DEFAULT = "https://overpass-api.de/api/interpreter";

function labelFromTags(tags) {
  if (!tags || typeof tags !== "object") return "Land outline";
  if (tags.name) return String(tags.name);
  if (tags.ref) return `${tags.landuse || "land"} (${tags.ref})`;
  if (tags.landuse) return String(tags.landuse).replace(/_/g, " ");
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
  return `[out:json][timeout:55];
(
  way["landuse"="farmland"](around:${r},${lat},${lng});
  way["landuse"="meadow"](around:${r},${lat},${lng});
  way["landuse"="orchard"](around:${r},${lat},${lng});
  way["landuse"="farmyard"](around:${r},${lat},${lng});
  way["landuse"="vineyard"](around:${r},${lat},${lng});
);
out meta tags geom;`;
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
    if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 3) continue;
    const raw = el.geometry.map((n) => ({ lat: n.lat, lng: n.lon }));
    const ring = closeRing(raw);
    if (!ring || ring.length < 4) continue;
    if (!pointInPolygon(lat, lng, ring)) continue;
    hits.push({
      id: `way/${el.id}`,
      label: labelFromTags(el.tags),
      tags: el.tags || {},
      ring,
      element: el,
      area: ringAreaSqDeg(ring),
    });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.area - b.area);
  const best = hits[0];
  return { id: best.id, label: best.label, tags: best.tags, ring: best.ring, element: best.element };
}

/**
 * One-shot: land polygons near the click, return at most one outline that contains the point.
 * @param {{ signal?: AbortSignal, radiusM?: number, endpoint?: string }} [opts]
 */
export async function fetchOsmFieldAtPoint(lat, lng, opts = {}) {
  const radiusM = Math.min(4000, Math.max(40, opts.radiusM ?? 220));
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
    return data.outline ?? null;
  }

  const q = landuseAroundQuery(lat, lng, radiusM);
  const body = `data=${encodeURIComponent(q)}`;
  const res = await fetch(opts.endpoint || OVERPASS_DEFAULT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json",
    },
    body,
    signal,
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
    throw err;
  }
  const json = await res.json();
  return pickSmallestLandOutlineAtPoint(json, lat, lng);
}

/**
 * Coordinate-system helpers for the extractor.
 *
 * Convention used throughout:
 *   - "merc" / "3857" = EPSG:3857 (Web Mercator) metres.
 *   - "wgs" / "4326" = EPSG:4326 longitude / latitude in degrees.
 *
 * Functions are tiny on purpose — picking up @turf/projection or proj4 just
 * to convert a few thousand points per extraction is more cost than benefit.
 */

const MERC_EDGE = 20037508.342789244;
const RAD = Math.PI / 180;
const D = 1 / RAD;

export function lonLatToMeters(lon, lat) {
  const x = (lon * RAD) * 6378137;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) * 6378137;
  return { x, y };
}

export function metersToLonLat(x, y) {
  const lon = (x / 6378137) * D;
  const lat = (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * D;
  return { lng: lon, lat };
}

export function clampMerc(x) {
  if (x > MERC_EDGE) return MERC_EDGE;
  if (x < -MERC_EDGE) return -MERC_EDGE;
  return x;
}

/**
 * Compute the EPSG:3857 bounding box for an array of { lat, lng } points,
 * with a small padding (3% of the longer axis, min 40 m) so we don't sample
 * exactly at the polygon edge.
 */
export function bboxFromBoundary(boundary) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of boundary || []) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const m = lonLatToMeters(p.lng, p.lat);
    if (m.x < minx) minx = m.x;
    if (m.y < miny) miny = m.y;
    if (m.x > maxx) maxx = m.x;
    if (m.y > maxy) maxy = m.y;
  }
  if (!Number.isFinite(minx)) return null;
  const span = Math.max(maxx - minx, maxy - miny);
  const pad = Math.max(40, span * 0.03);
  return {
    minx: clampMerc(minx - pad),
    miny: clampMerc(miny - pad),
    maxx: clampMerc(maxx + pad),
    maxy: clampMerc(maxy + pad),
  };
}

/**
 * Convert our boundary [{ lat, lng }, …] to a GeoJSON Polygon feature in
 * EPSG:4326. Closes the ring if not already closed. Returns null if the ring
 * has fewer than 3 valid points.
 */
export function boundaryToGeoJsonPolygon(boundary, properties = {}) {
  const ring = [];
  for (const p of boundary || []) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    ring.push([p.lng, p.lat]);
  }
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/**
 * Convert a GeoJSON Feature(Collection) coordinate array (EPSG:3857 metres)
 * to EPSG:4326 in-place. Useful after marching-squares contouring runs in
 * mercator-aligned pixel space.
 */
export function projectGeometry3857To4326(geometry) {
  if (!geometry) return geometry;
  const project = (coords) => {
    if (typeof coords[0] === "number") {
      const ll = metersToLonLat(coords[0], coords[1]);
      return [ll.lng, ll.lat];
    }
    return coords.map(project);
  };
  return { ...geometry, coordinates: project(geometry.coordinates) };
}

/**
 * Ray-cast point-in-polygon (WGS84; fine for paddock-scale rings).
 * @param {number} lat
 * @param {number} lng
 * @param {{ lat: number, lng: number }[]} ring Closed or open ring (last may duplicate first).
 */
export function pointInPolygon(lat, lng, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const x = lng;
  const y = lat;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Signed area in (deg²) for sorting; not geodesic area. */
export function ringAreaSqDeg(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    s += ring[i].lng * ring[i + 1].lat - ring[i + 1].lng * ring[i].lat;
  }
  return Math.abs(s / 2);
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function ringCentroid(ring) {
  if (!ring?.length) return { lat: 0, lng: 0 };
  const last = ring[ring.length - 1];
  const first = ring[0];
  const dup =
    ring.length > 1 &&
    last.lat === first.lat &&
    last.lng === first.lng;
  const slice = dup ? ring.slice(0, -1) : ring;
  let slat = 0;
  let slng = 0;
  const n = slice.length;
  if (!n) return { lat: first.lat, lng: first.lng };
  for (let i = 0; i < n; i++) {
    slat += slice[i].lat;
    slng += slice[i].lng;
  }
  return { lat: slat / n, lng: slng / n };
}

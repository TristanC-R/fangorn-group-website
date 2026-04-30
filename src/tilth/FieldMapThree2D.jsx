import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const R = 6378137;
const TWO_PI_R = 2 * Math.PI * R;

const BASEMAPS = {
  satellite: {
    label: "Satellite",
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: "Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS Community",
    fallback: 0x2a3a2e,
    ui: "dark",
  },
  osm: {
    label: "Streets",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: "© OpenStreetMap contributors",
    fallback: 0xdce9de,
    ui: "light",
  },
  light: {
    label: "Light",
    url: (z, x, y) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
    attribution: "© OpenStreetMap contributors, © CartoDB",
    fallback: 0xeef1ec,
    ui: "light",
  },
};

function lonLatToMeters(lon, lat) {
  const λ = (lon * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const x = R * λ;
  const y = R * Math.log(Math.tan(Math.PI / 4 + φ / 2));
  return { x, y };
}

function metersToLonLat(x, y) {
  const lon = ((x / R) * 180) / Math.PI;
  const lat = ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI;
  return { lon, lat };
}

function tileIndexToLonLat(ix, iy, z) {
  const n = 2 ** z;
  const lon = (ix / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * iy) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lon, lat };
}

function lonLatToIntTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const yf =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  const y = Math.min(n - 1, Math.max(0, Math.floor(yf * n)));
  return { x, y };
}

function isWgsRing(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return false;
  const p = ring[0];
  return (
    p &&
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng)
  );
}

function disposeObject(obj) {
  obj.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const m = o.material;
      if (m.map) m.map.dispose();
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else m.dispose?.();
    }
  });
}

function disposeGroupContents(group) {
  const toRemove = [...group.children];
  for (const ch of toRemove) {
    group.remove(ch);
    disposeObject(ch);
  }
}

/**
 * Sutherland–Hodgman polygon clipping against an axis-aligned rectangle.
 *
 * `subject` is an array of `{x, y}` ring vertices (no need to repeat the
 * first vertex at the end). The rectangle is given in the same coordinate
 * system as the subject, with `minX < maxX` and `minY < maxY`.
 *
 * Returns the clipped polygon as a fresh `{x, y}[]` array. May be empty
 * when the subject lies entirely outside the rectangle, or when a degenerate
 * subject collapses through clipping. Convex output is guaranteed when the
 * input is simple (no self-intersection); for concave inputs the result is
 * one polygon that approximates the intersection (Sutherland–Hodgman is
 * robust against rectangular clip regions).
 */
function clipPolygonToRect(subject, minX, minY, maxX, maxY) {
  if (!subject || subject.length < 3) return [];

  // Each clip edge is described by an axis-aligned half-plane:
  //   inside(p) = (p.x >= minX) for the LEFT edge, etc.
  //   intersect(a, b) = (the point where segment a→b meets the edge line)
  const edges = [
    {
      inside: (p) => p.x >= minX,
      intersect: (a, b) => {
        const t = (minX - a.x) / (b.x - a.x);
        return { x: minX, y: a.y + t * (b.y - a.y) };
      },
    },
    {
      inside: (p) => p.x <= maxX,
      intersect: (a, b) => {
        const t = (maxX - a.x) / (b.x - a.x);
        return { x: maxX, y: a.y + t * (b.y - a.y) };
      },
    },
    {
      inside: (p) => p.y >= minY,
      intersect: (a, b) => {
        const t = (minY - a.y) / (b.y - a.y);
        return { x: a.x + t * (b.x - a.x), y: minY };
      },
    },
    {
      inside: (p) => p.y <= maxY,
      intersect: (a, b) => {
        const t = (maxY - a.y) / (b.y - a.y);
        return { x: a.x + t * (b.x - a.x), y: maxY };
      },
    },
  ];

  let output = subject.slice();
  for (const edge of edges) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    let prev = input[input.length - 1];
    let prevIn = edge.inside(prev);
    for (const curr of input) {
      const currIn = edge.inside(curr);
      if (currIn) {
        if (!prevIn) output.push(edge.intersect(prev, curr));
        output.push(curr);
      } else if (prevIn) {
        output.push(edge.intersect(prev, curr));
      }
      prev = curr;
      prevIn = currIn;
    }
  }
  return output;
}

/**
 * Cheap stable hash of a saved-fields list — used to invalidate clipped
 * overlay-tile caches when the field geometry changes. We only care about
 * changes that move tile/field intersections, so we hash the field id, the
 * vertex count, and the first vertex of each ring. Selection / hover /
 * choropleth changes don't perturb this signature.
 */
function fieldsClipSignature(fields) {
  if (!Array.isArray(fields) || !fields.length) return "0";
  const parts = [];
  for (const f of fields) {
    if (!f) continue;
    const id = f.id || f.name || "?";
    const ring = f.boundary;
    if (!Array.isArray(ring) || ring.length === 0) {
      parts.push(`${id}|0`);
      continue;
    }
    const a = ring[0];
    const b = ring[ring.length - 1];
    const lon0 = (a?.lng ?? a?.lon ?? 0).toFixed(6);
    const lat0 = (a?.lat ?? 0).toFixed(6);
    const lon1 = (b?.lng ?? b?.lon ?? 0).toFixed(6);
    const lat1 = (b?.lat ?? 0).toFixed(6);
    parts.push(`${id}|${ring.length}|${lon0},${lat0}|${lon1},${lat1}`);
  }
  return parts.join(";");
}

/**
 * Three.js orthographic 2D map: raster basemap tiles in Web Mercator,
 * saved-field outlines, optional draft ring, hover/selection, and (when
 * `editRing` is provided) interactive vertex editing handles.
 *
 * Exposes imperative methods via the `onReady` callback so parents can
 * call `fitRing`, `setCenterZoom`, or `zoomBy` without remounting.
 */
export function FieldMapThree2D({
  center,
  zoom,
  savedFields,
  draftRing,
  mapMode = "pan",
  basemap = "satellite",
  selectedFieldId = null,
  hoverEnabled = true,
  choropleth = null,
  pointMarkers = [],
  overlays = null,
  controls = true,
  uiInsets = {},
  height = "100%",
  editRing = null,
  editingFieldId = null,
  onAddVertex,
  onFindFieldClick,
  onSelectField,
  onViewChange,
  onEditRingChange,
  onOverlayClick,
  onReady,
}) {
  const containerRef = useRef(null);
  const ctxRef = useRef(null);
  const [view, setView] = useState(() => ({
    lat: center?.[0] ?? 54,
    lng: center?.[1] ?? -2,
    zoom: zoom ?? 6,
  }));
  const [activeBasemap, setActiveBasemap] = useState(basemap);
  const [hoverId, setHoverId] = useState(null);
  const lastCenterZoomRef = useRef(null);

  const mapModeRef = useRef(mapMode);
  const onAddVertexRef = useRef(onAddVertex);
  const onFindFieldClickRef = useRef(onFindFieldClick);
  const onSelectFieldRef = useRef(onSelectField);
  const onEditRingChangeRef = useRef(onEditRingChange);
  const onOverlayClickRef = useRef(onOverlayClick);
  const onReadyRef = useRef(onReady);
  const savedRef = useRef(savedFields);
  const draftRef = useRef(draftRing);
  const selectedIdRef = useRef(selectedFieldId);
  const choroplethRef = useRef(choropleth);
  const pointMarkersRef = useRef(pointMarkers);
  const overlaysRef = useRef(overlays);
  const hoverEnabledRef = useRef(hoverEnabled);
  const hoverIdRef = useRef(hoverId);
  const editRingRef = useRef(editRing);
  const editingFieldIdRef = useRef(editingFieldId);
  mapModeRef.current = mapMode;
  onAddVertexRef.current = onAddVertex;
  onFindFieldClickRef.current = onFindFieldClick;
  onSelectFieldRef.current = onSelectField;
  onEditRingChangeRef.current = onEditRingChange;
  onOverlayClickRef.current = onOverlayClick;
  onReadyRef.current = onReady;
  savedRef.current = savedFields;
  draftRef.current = draftRing;
  selectedIdRef.current = selectedFieldId;
  choroplethRef.current = choropleth;
  pointMarkersRef.current = pointMarkers;
  overlaysRef.current = overlays;
  hoverEnabledRef.current = hoverEnabled;
  hoverIdRef.current = hoverId;
  editRingRef.current = editRing;
  editingFieldIdRef.current = editingFieldId;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const w = Math.max(el.clientWidth, 320);
    const h = Math.max(el.clientHeight, 320);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BASEMAPS[activeBasemap]?.fallback ?? 0xdce9de);

    const centerM = lonLatToMeters(view.lng, view.lat);
    let viewCx = centerM.x;
    let viewCy = centerM.y;
    let viewZoom = Math.min(19, Math.max(2, Math.round(view.zoom)));
    let currentBasemap = activeBasemap;

    let halfH = (TWO_PI_R / 2 ** viewZoom) * 0.55;
    let halfW = halfH * (w / h);

    // The camera sits at y=8000 looking down at the y=0 plane. Every
    // scene object lives in y ∈ [0, 0.2] (basemap, overlays, fills,
    // outlines), so the *useful* view-space depth range is essentially
    // [7799.8, 8000]. The previous near/far of (0.1, 1e7) gave a 24-bit
    // depth-buffer resolution of 1e7 / 2²⁴ ≈ 0.6 m per step — coarser
    // than every zLift gap in the scene, which collapsed every layer
    // into the same depth bucket. The basemap is the only object that
    // writes depth (everything else uses depthWrite: false), but its
    // depth still gets tested against, so all overlays randomly z-fought
    // it and the pattern shifted as the projection scaled with zoom —
    // i.e. "patchy data at different zoom levels". Tightening near/far
    // bumps precision to ≈ 0.85 mm per step, two orders of magnitude
    // smaller than the smallest zLift gap (the 0.02 m basemap→overlay
    // step), which permanently kills the z-fight.
    const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 1000, 15000);
    camera.position.set(0, 8000, 0);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.userSelect = "none";
    renderer.domElement.style.webkitUserSelect = "none";
    el.appendChild(renderer.domElement);

    const mapWorld = new THREE.Group();
    scene.add(mapWorld);

    const tilesGroup = new THREE.Group();
    const overlaysGroup = new THREE.Group();
    const fillsGroup = new THREE.Group();
    const linesGroup = new THREE.Group();
    const markersGroup = new THREE.Group();
    const draftGroup = new THREE.Group();
    const editGroup = new THREE.Group();
    mapWorld.add(tilesGroup);
    mapWorld.add(overlaysGroup);
    mapWorld.add(fillsGroup);
    mapWorld.add(linesGroup);
    mapWorld.add(markersGroup);
    mapWorld.add(draftGroup);
    mapWorld.add(editGroup);

    const tileCache = new Map();
    const activeTiles = new Set();

    // Per-overlay state: { def, group, tileCache, activeTiles, zLift, opacity }
    // Reconciled by `reconcileOverlays` when the `overlays` prop changes,
    // refreshed (new tiles in/out of view) by `refreshOverlayTiles` on every
    // pan/zoom/resize.
    const overlayState = new Map();

    function syncMapWorldPosition() {
      mapWorld.position.set(-viewCx, 0, viewCy);
      mapWorld.updateMatrixWorld(true);
    }
    syncMapWorldPosition();

    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();

    const textureLoader = new THREE.TextureLoader();
    textureLoader.crossOrigin = "anonymous";

    function buildTileQuad(tx, ty, z, basemapId) {
      const cornersM = [
        [tx, ty],
        [tx + 1, ty],
        [tx + 1, ty + 1],
        [tx, ty + 1],
      ].map(([ix, iy]) => {
        const ll = tileIndexToLonLat(ix, iy, z);
        return lonLatToMeters(ll.lon, ll.lat);
      });
      const positions = new Float32Array(18);
      const uvs = new Float32Array(12);
      const triA = [0, 1, 2];
      const triB = [0, 2, 3];
      let o = 0;
      for (const tri of [triA, triB]) {
        for (const i of tri) {
          const c = cornersM[i];
          positions[o] = c.x;
          positions[o + 1] = 0.02;
          positions[o + 2] = -c.y;
          o += 3;
        }
      }
      uvs.set([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

      const fallback = BASEMAPS[basemapId]?.fallback ?? 0x889988;
      const mat = new THREE.MeshBasicMaterial({
        color: fallback,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = -10;

      const provider = BASEMAPS[basemapId] || BASEMAPS.osm;
      const url = provider.url(z, tx, ty);
      const texRef = { tex: null };
      textureLoader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          mat.map = tex;
          mat.color.setHex(0xffffff);
          mat.needsUpdate = true;
          texRef.tex = tex;
        },
        undefined,
        () => {
          /* keep fallback colour */
        }
      );
      return { mesh, mat, texRef };
    }

    function tileKey(basemapId, z, x, y) {
      return `${basemapId}|${z}|${x}|${y}`;
    }

    function refreshTiles() {
      const z = viewZoom;
      const { lon, lat } = metersToLonLat(viewCx, viewCy);
      const { x: cx, y: cy } = lonLatToIntTile(lon, lat, z);
      const span = Math.max(halfW, halfH);
      const tileM = TWO_PI_R / 2 ** z;
      const tileRadius = Math.ceil(span / tileM) + 2;
      const n = 2 ** z;

      const nextKeys = new Set();
      for (let dx = -tileRadius; dx <= tileRadius; dx++) {
        for (let dy = -tileRadius; dy <= tileRadius; dy++) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          const key = tileKey(currentBasemap, z, tx, ty);
          nextKeys.add(key);
          if (!tileCache.has(key)) {
            const entry = buildTileQuad(tx, ty, z, currentBasemap);
            tilesGroup.add(entry.mesh);
            tileCache.set(key, entry);
          } else {
            const entry = tileCache.get(key);
            if (entry.mesh.parent !== tilesGroup) tilesGroup.add(entry.mesh);
          }
        }
      }

      for (const key of activeTiles) {
        if (!nextKeys.has(key)) {
          const entry = tileCache.get(key);
          if (entry && entry.mesh.parent === tilesGroup) tilesGroup.remove(entry.mesh);
        }
      }
      activeTiles.clear();
      for (const k of nextKeys) activeTiles.add(k);
    }

    function changeBasemap(nextId) {
      if (!BASEMAPS[nextId] || nextId === currentBasemap) return;
      currentBasemap = nextId;
      scene.background = new THREE.Color(BASEMAPS[nextId]?.fallback ?? 0xdce9de);
      disposeGroupContents(tilesGroup);
      for (const entry of tileCache.values()) {
        if (entry.mat) entry.mat.dispose?.();
        if (entry.texRef?.tex) entry.texRef.tex.dispose?.();
        if (entry.mesh?.geometry) entry.mesh.geometry.dispose();
      }
      tileCache.clear();
      activeTiles.clear();
      refreshTiles();
    }

    // --- Fields-clipped overlay rendering ----------------------------------
    // For each enabled overlay we render one filled polygon mesh per saved
    // field, all sharing a single MeshBasicMaterial whose texture is a
    // single bbox-fit image fetched from the proxy `/export` endpoint.
    // UVs are computed from each vertex's mercator position relative to
    // the overlay's combined-fields bbox, so the texture sits in true
    // geographic position and the overlay only ever shows inside fields.
    // The texture only refetches when the fields list or tileVersion
    // changes — pan/zoom never triggers a fetch.

    function ringsKeyForState(rings) {
      if (!Array.isArray(rings) || rings.length === 0) return "";
      const parts = [];
      for (const r of rings) {
        if (!r || !Array.isArray(r.boundary)) continue;
        // Hash: id + vertex count + first/last vertex (cheap change-detector
        // for vertex moves) — sufficient to refetch on edits while staying
        // O(fields) on each render.
        const b = r.boundary;
        const f0 = b[0] || {};
        const fL = b[b.length - 1] || {};
        parts.push(
          `${r.id || r.name || "?"}|${b.length}|${(f0.lat ?? 0).toFixed(6)},${(f0.lng ?? 0).toFixed(6)}|${(fL.lat ?? 0).toFixed(6)},${(fL.lng ?? 0).toFixed(6)}`
        );
      }
      return parts.join("~");
    }

    function bboxFromRings(rings) {
      let minx = +Infinity;
      let miny = +Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (const r of rings || []) {
        if (!Array.isArray(r?.boundary)) continue;
        for (const p of r.boundary) {
          if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
          const m = lonLatToMeters(p.lng, p.lat);
          if (m.x < minx) minx = m.x;
          if (m.y < miny) miny = m.y;
          if (m.x > maxx) maxx = m.x;
          if (m.y > maxy) maxy = m.y;
        }
      }
      if (!Number.isFinite(minx)) return null;
      // Pad ~3% of the longer axis so we don't sample exactly at the polygon
      // edge (avoids crisp upstream-edge artefacts at the field boundary).
      const span = Math.max(maxx - minx, maxy - miny);
      const pad = Math.max(40, span * 0.03);
      return {
        minx: minx - pad,
        miny: miny - pad,
        maxx: maxx + pad,
        maxy: maxy + pad,
      };
    }

    function buildFieldMesh(ring, bbox, zLift, mat) {
      const merc = [];
      for (const p of ring) {
        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        const m = lonLatToMeters(p.lng, p.lat);
        merc.push({ x: m.x, y: m.y });
      }
      if (merc.length < 3) return null;
      const last = merc[merc.length - 1];
      const first = merc[0];
      if (Math.abs(last.x - first.x) < 1e-6 && Math.abs(last.y - first.y) < 1e-6) {
        merc.pop();
      }
      if (merc.length < 3) return null;

      // Triangulate in LOCAL bbox-relative coordinates so earcut works with
      // small magnitudes (fields are typically <1 km across; mercator coords
      // for the UK are ~6.5 M m, which loses too much precision in 32-bit
      // float earcut paths and silently produces empty triangle lists for
      // some polygon shapes). Indices map back to the original `merc` array.
      const contour = merc.map((p) => new THREE.Vector2(p.x - bbox.minx, p.y - bbox.miny));
      let tris = null;
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        tris = null;
      }
      if (!tris || !tris.length) {
        // Last-resort fan triangulation. Correct for convex polygons; for
        // non-convex shapes it can still produce overlapping triangles, but
        // the user always sees *something* clipped to the bbox interior
        // rather than a missing field.
        tris = [];
        for (let k = 1; k < merc.length - 1; k++) {
          tris.push([0, k, k + 1]);
        }
      }
      if (!tris.length) return null;

      // Place vertices directly into scene coords (x=mx, y=zLift, z=-my) —
      // identical to the field-outline convention so this mesh sits in the
      // same plane as the rest of the map without any rotation guesswork.
      const positions = new Float32Array(merc.length * 3);
      const uvs = new Float32Array(merc.length * 2);
      const bboxW = bbox.maxx - bbox.minx;
      const bboxH = bbox.maxy - bbox.miny;
      for (let i = 0; i < merc.length; i++) {
        positions[i * 3] = merc[i].x;
        positions[i * 3 + 1] = zLift;
        positions[i * 3 + 2] = -merc[i].y;
        uvs[i * 2] = (merc[i].x - bbox.minx) / bboxW;
        // V=0 at south (miny), V=1 at north (maxy) — matches the /export
        // image where (minx,maxy) is the top-left pixel.
        uvs[i * 2 + 1] = (merc[i].y - bbox.miny) / bboxH;
      }
      const indices = [];
      for (const t of tris) indices.push(t[0], t[1], t[2]);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geom.setIndex(indices);
      geom.computeBoundingSphere();

      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      return { mesh, geom };
    }

    function ensureFieldsOverlay(state) {
      if (state.fields) return state.fields;
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      state.fields = {
        mat,
        tex: null,
        meshes: [], // Array<{ mesh, geom }>
        bbox: null,
        ringsKey: "",
        versionKey: "",
        pendingTimer: null,
        seq: 0,
        disposed: false,
      };
      return state.fields;
    }

    function clearFieldsMeshes(state) {
      const f = state.fields;
      if (!f) return;
      for (const entry of f.meshes) {
        if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
        entry.geom?.dispose?.();
      }
      f.meshes = [];
    }

    function disposeFieldsOverlay(state) {
      const f = state.fields;
      if (!f) return;
      if (f.pendingTimer) {
        clearTimeout(f.pendingTimer);
        f.pendingTimer = null;
      }
      f.seq += 1;
      f.disposed = true;
      clearFieldsMeshes(state);
      f.mat?.dispose?.();
      f.tex?.dispose?.();
      state.fields = null;
    }

    function refreshOverlayFields(state) {
      const f = ensureFieldsOverlay(state);
      const rings = Array.isArray(state.def.rings) ? state.def.rings : [];
      const ringsKey = ringsKeyForState(rings);
      const versionKey = String(state.def.tileVersion || "");

      // Rebuild meshes whenever the rings change. UVs depend on the combined
      // bbox so we recompute that too.
      if (ringsKey !== f.ringsKey) {
        clearFieldsMeshes(state);
        f.bbox = bboxFromRings(rings);
        if (f.bbox) {
          for (const r of rings) {
            if (!Array.isArray(r?.boundary) || r.boundary.length < 3) continue;
            const built = buildFieldMesh(r.boundary, f.bbox, state.zLift, f.mat);
            if (!built) continue;
            state.group.add(built.mesh);
            f.meshes.push(built);
          }
        }
        f.ringsKey = ringsKey;
      } else if (state.zLift && f.meshes.length) {
        // zLift can change in reconcile (overlay reorder). Update y component.
        for (const entry of f.meshes) {
          const pos = entry.geom.getAttribute("position");
          if (!pos) continue;
          let dirty = false;
          for (let k = 1; k < pos.array.length; k += 3) {
            if (pos.array[k] !== state.zLift) {
              pos.array[k] = state.zLift;
              dirty = true;
            }
          }
          if (dirty) pos.needsUpdate = true;
        }
      }

      // Refetch the texture only when bbox or tileVersion changes — pan/zoom
      // does not affect either, so panning/zooming never triggers network.
      const fetchKey = f.bbox
        ? `${Math.round(f.bbox.minx)}|${Math.round(f.bbox.miny)}|${Math.round(f.bbox.maxx)}|${Math.round(f.bbox.maxy)}|${versionKey}`
        : "";
      if (!fetchKey || fetchKey === f.lastFetchKey) return;

      const exportUrl = state.def.exportUrl;
      if (typeof exportUrl !== "function") return;

      // Choose pixel resolution from bbox span — target ~3 m/pixel which
      // exceeds the source resolution of UKSO (1 km) and most WMS rasters,
      // so the upstream is the limiting factor not us. Capped 256–1536 px.
      const dpr = Math.min(2, renderer.getPixelRatio?.() || 1);
      const spanX = f.bbox.maxx - f.bbox.minx;
      const spanY = f.bbox.maxy - f.bbox.miny;
      const targetMperPx = 3;
      const pxIdeal = Math.round((spanX / targetMperPx) * dpr);
      const pyIdeal = Math.round((spanY / targetMperPx) * dpr);
      const px = Math.max(256, Math.min(1536, pxIdeal));
      const py = Math.max(256, Math.min(1536, pyIdeal));

      if (f.pendingTimer) clearTimeout(f.pendingTimer);
      f.pendingTimer = setTimeout(() => {
        f.pendingTimer = null;
        const url = exportUrl(f.bbox.minx, f.bbox.miny, f.bbox.maxx, f.bbox.maxy, px, py);
        const seq = ++f.seq;
        textureLoader.load(
          url,
          (tex) => {
            if (f.disposed || seq !== f.seq) {
              tex.dispose?.();
              return;
            }
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
            const oldTex = f.tex;
            f.tex = tex;
            f.mat.map = tex;
            f.mat.opacity = state.def.opacity ?? 0.7;
            f.mat.needsUpdate = true;
            f.lastFetchKey = fetchKey;
            if (oldTex && oldTex !== tex) oldTex.dispose?.();
          },
          undefined,
          () => {
            // Transient error — keep the previous texture in place.
          }
        );
      }, 60);
    }

    // --- Vector-feature overlay rendering ----------------------------------
    // For overlays that arrive as pre-extracted GeoJSON (the
    // `tilth_field_layer_data` Realtime path), build one Three.js mesh per
    // feature, coloured by `properties.color`. No textures, no per-pixel
    // raster — just polygon fills sitting in the same plane as the field
    // outlines. Honours holes via THREE.Shape's `.holes` array.

    function lonLatRingToMercatorPoints(ring) {
      // Returns mercator { x, y } array. Strips the duplicate closing
      // vertex (GeoJSON convention) since our triangulator wants an open
      // ring. Returns null on degenerate input.
      const pts = [];
      for (const lonLat of ring) {
        if (!Array.isArray(lonLat) || lonLat.length < 2) continue;
        const lon = Number(lonLat[0]);
        const lat = Number(lonLat[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const m = lonLatToMeters(lon, lat);
        pts.push({ x: m.x, y: m.y });
      }
      if (pts.length >= 2) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
          pts.pop();
        }
      }
      return pts.length >= 3 ? pts : null;
    }

    function buildPolygonMesh(coords, zLift, color, opacity) {
      // coords = [outerRing, hole1, hole2, …] (GeoJSON Polygon convention).
      //
      // PRECISION NOTE: feeding raw mercator coords (~10⁶ m for the UK)
      // straight into THREE.Shape / ShapeGeometry triggers an Earcut
      // precision failure: 32-bit float ops inside ear-clipping silently
      // produce degenerate / missing triangles for some polygons, which
      // shows up as "patchy data at different zoom levels" because
      // the camera frustum exposes the broken triangles at varying
      // angles. We triangulate in bbox-local coords (small magnitudes)
      // and write scene-space positions directly into the buffer
      // attribute — same pattern as buildFieldMesh for the field fills.
      const outer = lonLatRingToMercatorPoints(coords[0] || []);
      if (!outer) return null;
      const holes = [];
      for (let i = 1; i < coords.length; i++) {
        const hole = lonLatRingToMercatorPoints(coords[i] || []);
        if (hole) holes.push(hole);
      }
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      const allRings = [outer, ...holes];
      for (const ring of allRings) {
        for (const p of ring) {
          if (p.x < minx) minx = p.x;
          if (p.x > maxx) maxx = p.x;
          if (p.y < miny) miny = p.y;
          if (p.y > maxy) maxy = p.y;
        }
      }
      if (!Number.isFinite(minx)) return null;

      // Build local Vector2 arrays for triangulation. THREE.ShapeUtils
      // returns triangle indices into a flat list [contour, hole1, …],
      // so we keep the same flat order when populating the position buffer.
      const localContour = outer.map((p) => new THREE.Vector2(p.x - minx, p.y - miny));
      const localHoles = holes.map((h) =>
        h.map((p) => new THREE.Vector2(p.x - minx, p.y - miny))
      );
      let tris = null;
      try {
        tris = THREE.ShapeUtils.triangulateShape(localContour, localHoles);
      } catch {
        tris = null;
      }
      if (!tris || !tris.length) {
        // Fan triangulation fallback. Holes are dropped here, but at
        // least the user sees the overall shape rather than nothing.
        tris = [];
        for (let k = 1; k < outer.length - 1; k++) {
          tris.push([0, k, k + 1]);
        }
        if (!tris.length) return null;
      }

      const flatRings = [outer, ...holes];
      let totalVerts = 0;
      for (const r of flatRings) totalVerts += r.length;
      const positions = new Float32Array(totalVerts * 3);
      let o = 0;
      for (const ring of flatRings) {
        for (const p of ring) {
          positions[o] = p.x;
          positions[o + 1] = zLift;
          positions[o + 2] = -p.y;
          o += 3;
        }
      }
      const indices = [];
      for (const t of tris) indices.push(t[0], t[1], t[2]);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setIndex(indices);
      geom.computeBoundingSphere();

      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color || "#5a8550"),
        transparent: true,
        opacity: opacity ?? 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      return { mesh, geom, mat };
    }

    function ensureVectorOverlay(state) {
      if (state.vectors) return state.vectors;
      state.vectors = {
        meshes: [], // Array<{ mesh, geom, mat }>
        sigKey: "",
      };
      return state.vectors;
    }

    function clearVectorMeshes(state) {
      const v = state.vectors;
      if (!v) return;
      for (const entry of v.meshes) {
        if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
        entry.geom?.dispose?.();
        entry.mat?.dispose?.();
      }
      v.meshes = [];
    }

    function disposeVectorOverlay(state) {
      clearVectorMeshes(state);
      state.vectors = null;
    }

    function refreshOverlayVectors(state) {
      const v = ensureVectorOverlay(state);
      const fc = state.def.featureCollection;
      const opacity = state.def.opacity ?? 0.7;
      const sig = String(state.def.featuresSignature || "");
      if (sig === v.sigKey && v.meshes.length) {
        // Same data, same opacity; only z-lift might have shifted.
        // Each mesh stores its sub-mm stagger in `entry.zEpsilon`; we add
        // it to the new state.zLift so the depth ordering is preserved.
        if (state.zLift) {
          for (const entry of v.meshes) {
            const pos = entry.geom.getAttribute("position");
            if (!pos) continue;
            const wantY = state.zLift + (entry.zEpsilon || 0);
            let dirty = false;
            for (let k = 1; k < pos.array.length; k += 3) {
              if (pos.array[k] !== wantY) {
                pos.array[k] = wantY;
                dirty = true;
              }
            }
            if (dirty) pos.needsUpdate = true;
          }
        }
        for (const entry of v.meshes) {
          if (entry.mat && entry.mat.opacity !== opacity) entry.mat.opacity = opacity;
        }
        return;
      }
      clearVectorMeshes(state);
      v.sigKey = sig;
      if (!fc || !Array.isArray(fc.features) || !fc.features.length) return;
      // Each polygon gets an explicit renderOrder so transparent-object
      // alpha-blend ordering is deterministic, plus a tiny zLift stagger
      // so they sit in distinct depth-buffer buckets. With the tightened
      // camera frustum (near=1000, far=15000) the depth-buffer resolution
      // is ≈ 0.85 mm/step, so a 1-µm stagger isn't enough — bump to
      // 1 mm/poly which gives a comfortable ~1.2 depth steps per poly.
      // Per layer there's a 0.006 m zLift gap to the next overlay
      // (`0.04 + i*0.006`), so we stay safely under that ceiling for up
      // to ~5 stacked polygons before bleeding into the next layer.
      // (5 is plenty — features within a single layer are mutually
      // exclusive geological / cropland classes; they don't overlap.)
      let polyIdx = 0;
      for (const feat of fc.features) {
        const geom = feat?.geometry;
        if (!geom) continue;
        const props = feat?.properties || {};
        const color = props.color || "#5a8550";
        const polys =
          geom.type === "Polygon"
            ? [geom.coordinates]
            : geom.type === "MultiPolygon"
              ? geom.coordinates
              : null;
        if (!polys) continue; // Lines / points: skip for now.
        for (const poly of polys) {
          const zEpsilon = (polyIdx % 5) * 1e-3;
          const built = buildPolygonMesh(poly, state.zLift + zEpsilon, color, opacity);
          if (!built) {
            polyIdx++;
            continue;
          }
          built.zEpsilon = zEpsilon;
          built.mesh.renderOrder = polyIdx;
          state.group.add(built.mesh);
          v.meshes.push(built);
          polyIdx++;
        }
      }
    }

    /**
     * Build a WMS overlay tile mesh, geometrically clipped to the saved
     * fields it overlaps. Each saved field whose polygon intersects the
     * tile rectangle contributes a sub-shape to the resulting
     * `THREE.ShapeGeometry`; UVs are derived from the world (mercator)
     * position so the WMS texture maps onto the clipped pieces exactly the
     * way it would onto the full square tile.
     *
     * Returns `null` when no field intersects this tile — refresh skips
     * the URL fetch and the mesh allocation entirely so we don't pay for
     * tiles that wouldn't be visible after clipping anyway.
     */
    function buildOverlayTileQuad(state, tx, ty, z) {
      const llTL = tileIndexToLonLat(tx, ty, z);
      const llBR = tileIndexToLonLat(tx + 1, ty + 1, z);
      const mTL = lonLatToMeters(llTL.lon, llTL.lat);
      const mBR = lonLatToMeters(llBR.lon, llBR.lat);
      const tMinX = Math.min(mTL.x, mBR.x);
      const tMaxX = Math.max(mTL.x, mBR.x);
      const tMinY = Math.min(mTL.y, mBR.y);
      const tMaxY = Math.max(mTL.y, mBR.y);
      const tileW = tMaxX - tMinX;
      const tileH = tMaxY - tMinY;
      if (tileW <= 0 || tileH <= 0) return null;

      // Triangulate in tile-local coordinates so float32 has plenty of
      // precision (mercator x/y are in the 1e7 range; subtracting the tile
      // centre keeps shape coords within a few-thousand-metre window).
      const cx = (tMinX + tMaxX) / 2;
      const cy = (tMinY + tMaxY) / 2;

      const sf = savedRef.current || [];
      const shapes = [];
      for (const f of sf) {
        if (!f || !Array.isArray(f.boundary) || f.boundary.length < 3) continue;
        const ringMerc = [];
        let ok = true;
        for (const p of f.boundary) {
          const lon = p?.lng ?? p?.lon;
          const lat = p?.lat;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            ok = false;
            break;
          }
          const m = lonLatToMeters(lon, lat);
          ringMerc.push({ x: m.x, y: m.y });
        }
        if (!ok || ringMerc.length < 3) continue;

        const clipped = clipPolygonToRect(ringMerc, tMinX, tMinY, tMaxX, tMaxY);
        if (clipped.length < 3) continue;

        const shape = new THREE.Shape();
        clipped.forEach((p, i) => {
          const lx = p.x - cx;
          const ly = p.y - cy;
          if (i === 0) shape.moveTo(lx, ly);
          else shape.lineTo(lx, ly);
        });
        shapes.push(shape);
      }

      if (shapes.length === 0) return null;

      // ShapeGeometry triangulates in 2D (XY plane) and emits positions as
      // (x, y, 0). We then *manually* lift them into the scene's
      // (mercX, zLift, -mercY) coordinate convention used by the rest of
      // the renderer (basemap tiles, field outlines, etc.). Doing this by
      // hand instead of with `geom.rotateX(-PI/2)` is critical: the
      // rotation produces (mercX, 0, +mercY) which sits on the *opposite*
      // side of the equator from everything else and lands well outside
      // the camera's near/far frustum, so the mesh disappears entirely.
      const geom = new THREE.ShapeGeometry(shapes);
      const pos = geom.attributes.position.array;
      const vCount = pos.length / 3;
      const uvs = new Float32Array(vCount * 2);
      for (let i = 0; i < vCount; i++) {
        const lx = pos[i * 3];
        const ly = pos[i * 3 + 1];
        const mercX = lx + cx;
        const mercY = ly + cy;
        const u = (mercX - tMinX) / tileW;
        const v = (mercY - tMinY) / tileH;
        uvs[i * 2] = u;
        uvs[i * 2 + 1] = v;
        pos[i * 3] = mercX;
        pos[i * 3 + 1] = state.zLift;
        pos[i * 3 + 2] = -mercY;
      }
      geom.attributes.position.needsUpdate = true;
      geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geom.computeBoundingSphere();

      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0, // fades in after the texture loads
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 0;

      const url = state.def.url(z, tx, ty);
      const targetOpacity = state.def.opacity ?? 0.7;
      const texRef = { tex: null, loaded: false };
      textureLoader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          mat.map = tex;
          mat.opacity = targetOpacity;
          mat.needsUpdate = true;
          texRef.tex = tex;
          texRef.loaded = true;
          // A new tile just finished loading — let the deferred-removal
          // sweep know it can dispose any stale-zoom siblings whose
          // replacement is now on screen.
          state.onTileLoaded?.();
        },
        undefined,
        () => {
          /* leave mesh invisible on error */
          texRef.loaded = true; // avoid blocking sweeps forever on a single 404
          state.onTileLoaded?.();
        }
      );
      return { mesh, mat, texRef, removeTimer: null };
    }

    /**
     * Called by `buildOverlayTileQuad` whenever a fresh tile finishes its
     * texture load. If every currently-active tile is loaded we know the
     * new zoom is fully painted and any deferred-removal stale tiles can
     * go now rather than waiting out their timer (which would otherwise
     * leave the previous zoom visibly bleeding through under the new
     * one for up to ~1.2s).
     */
    function sweepStaleTiles(state) {
      if (!state || !state.tileCache.size) return;
      let allLoaded = true;
      for (const key of state.activeTiles) {
        const e = state.tileCache.get(key);
        if (!e || !e.texRef?.loaded) {
          allLoaded = false;
          break;
        }
      }
      if (!allLoaded) return;
      for (const [key, entry] of state.tileCache) {
        if (state.activeTiles.has(key)) continue;
        if (!entry || !entry.removeTimer) continue;
        clearTimeout(entry.removeTimer);
        entry.removeTimer = null;
        if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
      }
    }

    function refreshOverlayTiles() {
      if (!overlayState.size) return;
      const z = viewZoom;
      const { lon, lat } = metersToLonLat(viewCx, viewCy);
      const span = Math.max(halfW, halfH);

      // Field clipping is baked into each tile mesh — when fields change
      // we have to rebuild the cache or the previously-clipped tiles will
      // ignore the edit. A single signature comparison per refresh cycle
      // keeps this cheap.
      const clipSig = fieldsClipSignature(savedRef.current);

      for (const state of overlayState.values()) {
        if (state.def.mode !== "fields" && state.def.mode !== "vectors") {
          if (state.fieldsClipSig !== clipSig) {
            for (const entry of state.tileCache.values()) {
              if (!entry) continue;
              if (entry.removeTimer) {
                clearTimeout(entry.removeTimer);
                entry.removeTimer = null;
              }
              if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
              entry.mat?.dispose?.();
              entry.texRef?.tex?.dispose?.();
              entry.mesh?.geometry?.dispose?.();
            }
            state.tileCache.clear();
            state.activeTiles.clear();
            state.fieldsClipSig = clipSig;
          }
        }
      }

      for (const state of overlayState.values()) {
        const minZ = state.def.minZoom ?? 0;
        const maxZ = state.def.maxZoom ?? 19;
        if (z < minZ || z > maxZ) {
          for (const entry of state.tileCache.values()) {
            if (!entry) continue;
            if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
          }
          state.activeTiles.clear();
          if (state.fields) {
            for (const entry of state.fields.meshes) {
              if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
            }
          }
          if (state.vectors) {
            for (const entry of state.vectors.meshes) {
              if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
            }
          }
          continue;
        }

        // `vectors` overlays render pre-extracted GeoJSON features stored
        // in `tilth_field_layer_data`. No upstream fetch happens here —
        // the SoilWorkspace pipes the FeatureCollection through the
        // overlay def and we just (re)build polygon meshes whenever the
        // signature changes (i.e. extractor finished).
        if (state.def.mode === "vectors") {
          if (state.vectors) {
            for (const entry of state.vectors.meshes) {
              if (entry.mesh.parent !== state.group) state.group.add(entry.mesh);
            }
          }
          refreshOverlayVectors(state);
          continue;
        }

        // `fields` overlays render one polygon mesh per saved field, all
        // sharing a single bbox-fit texture from the proxy `/export`
        // endpoint. The overlay is geographically anchored — pan/zoom
        // never triggers a fetch. Used for ArcGIS / WMS sources so the
        // overlay only shows inside fields, not over the whole map.
        if (state.def.mode === "fields") {
          if (state.fields) {
            for (const entry of state.fields.meshes) {
              if (entry.mesh.parent !== state.group) state.group.add(entry.mesh);
            }
          }
          refreshOverlayFields(state);
          continue;
        }

        // Honour `maxNativeZoom` — for coarse layers (e.g. UKSO 1km rasters)
        // we request tiles at that zoom and let three.js stretch them. This
        // avoids per-tile resampling mismatch that otherwise shows up as a
        // mosaic pattern along tile boundaries at deep zooms.
        const effZ = Math.min(z, state.def.maxNativeZoom ?? z);
        const tileM = TWO_PI_R / 2 ** effZ;
        const tileRadius = Math.ceil(span / tileM) + 2;
        const n = 2 ** effZ;
        const { x: cx, y: cy } = lonLatToIntTile(lon, lat, effZ);

        // Whether this refresh changed effZ — drives the "keep stale tiles
        // visible while new ones load" behaviour (see comments below).
        const zoomChanged = state.lastEffZ != null && state.lastEffZ !== effZ;
        state.lastEffZ = effZ;

        const nextKeys = new Set();
        for (let dx = -tileRadius; dx <= tileRadius; dx++) {
          for (let dy = -tileRadius; dy <= tileRadius; dy++) {
            const tx = cx + dx;
            const ty = cy + dy;
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
            const key = `${effZ}|${tx}|${ty}`;
            let entry = state.tileCache.get(key);
            if (entry === undefined) {
              entry = buildOverlayTileQuad(state, tx, ty, effZ);
              // Cache the null result so we don't recompute the (often
              // very large) "tile doesn't intersect any field" decision
              // every refresh — those negative entries are cheap and
              // dominate when the user is zoomed far out.
              state.tileCache.set(key, entry);
            }
            if (entry === null) continue;
            nextKeys.add(key);
            if (entry.mesh.parent !== state.group) state.group.add(entry.mesh);
            // A re-activated tile may have a pending removal timer from
            // a previous pan that briefly took it off-screen; cancel it
            // so it isn't ripped out from under us.
            if (entry.removeTimer) {
              clearTimeout(entry.removeTimer);
              entry.removeTimer = null;
            }
          }
        }

        // Tiles leaving the active set: remove them, but on a delay so that
        // zoom-level transitions don't show a "blank period" while the new
        // zoom's tiles fetch from upstream. During pan (zoom unchanged) the
        // delay can be short — we just want to avoid tearing on rapid back
        // -and-forth movement. During zoom changes we hold longer because
        // every visible tile is freshly invalid and the new ones haven't
        // started loading yet.
        const holdMs = zoomChanged ? 1200 : 250;
        for (const key of state.activeTiles) {
          if (nextKeys.has(key)) continue;
          const entry = state.tileCache.get(key);
          if (!entry) continue;
          if (entry.removeTimer) continue;
          const e = entry;
          e.removeTimer = setTimeout(() => {
            e.removeTimer = null;
            // Only hide if we still don't want it. The user may have
            // panned back here in the meantime.
            if (state.activeTiles.has(key)) return;
            if (e.mesh.parent === state.group) state.group.remove(e.mesh);
          }, holdMs);
        }
        state.activeTiles.clear();
        for (const k of nextKeys) state.activeTiles.add(k);

        // Light LRU trim so memory doesn't grow unbounded across zoom levels.
        // We allow more entries than before because the cache is dominated
        // by cheap `null` placeholders for tiles that don't intersect any
        // field — those carry no GPU resources and aren't worth evicting.
        if (state.tileCache.size > 1024) {
          const over = state.tileCache.size - 1024;
          let removed = 0;
          for (const key of [...state.tileCache.keys()]) {
            if (removed >= over) break;
            if (state.activeTiles.has(key)) continue;
            const entry = state.tileCache.get(key);
            if (entry === null) {
              // Drop negative-cache entries first; they're free to re-derive.
              state.tileCache.delete(key);
              removed += 1;
              continue;
            }
            if (entry.removeTimer) {
              clearTimeout(entry.removeTimer);
              entry.removeTimer = null;
            }
            if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
            entry.mat?.dispose?.();
            entry.texRef?.tex?.dispose?.();
            entry.mesh?.geometry?.dispose?.();
            state.tileCache.delete(key);
            removed += 1;
          }
        }
      }
    }

    function disposeOverlayState(state) {
      for (const entry of state.tileCache.values()) {
        if (!entry) continue;
        if (entry.removeTimer) {
          clearTimeout(entry.removeTimer);
          entry.removeTimer = null;
        }
        if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
        entry.mat?.dispose?.();
        entry.texRef?.tex?.dispose?.();
        entry.mesh?.geometry?.dispose?.();
      }
      state.tileCache.clear();
      state.activeTiles.clear();
      disposeFieldsOverlay(state);
      disposeVectorOverlay(state);
      if (state.group.parent === overlaysGroup) overlaysGroup.remove(state.group);
    }

    function isValidOverlay(ovr) {
      if (!ovr) return false;
      if (ovr.mode === "vectors") return Boolean(ovr.featureCollection);
      if (ovr.mode === "fields") return typeof ovr.exportUrl === "function";
      return typeof ovr.url === "function";
    }

    function reconcileOverlays(nextOverlays) {
      const list = Array.isArray(nextOverlays) ? nextOverlays : [];
      const nextIds = new Set();
      list.forEach((ovr, i) => {
        if (!isValidOverlay(ovr)) return;
        const id = ovr.id ?? `_overlay_${i}`;
        nextIds.add(id);
      });

      for (const [id, state] of [...overlayState]) {
        if (!nextIds.has(id)) {
          disposeOverlayState(state);
          overlayState.delete(id);
        }
      }

      list.forEach((ovr, i) => {
        if (!isValidOverlay(ovr)) return;
        const id = ovr.id ?? `_overlay_${i}`;
        const zLift = 0.04 + i * 0.006; // above basemap (0.02), below fills (≥0.08)
        const opacity = Number.isFinite(ovr.opacity) ? ovr.opacity : 0.7;
        const mode =
          ovr.mode === "fields"
            ? "fields"
            : ovr.mode === "vectors"
              ? "vectors"
              : "tile";
        let state = overlayState.get(id);
        if (!state) {
          const group = new THREE.Group();
          overlaysGroup.add(group);
          state = {
            def: {
              ...ovr,
              mode,
              opacity,
              minZoom: ovr.minZoom ?? 0,
              maxZoom: ovr.maxZoom ?? 19,
            },
            group,
            tileCache: new Map(),
            activeTiles: new Set(),
            fields: null,
            vectors: null,
            zLift,
            // Tracks the previous effective zoom this overlay rendered
            // at; refreshOverlayTiles uses it to decide whether the
            // current refresh is a pan (cleanup fast) or a zoom change
            // (cleanup slow so previous tiles stay visible while new
            // ones load).
            lastEffZ: null,
            // Bumped by buildOverlayTileQuad's onLoad — gives stale
            // tiles a hook to dispose themselves once their replacement
            // has finished loading.
            onTileLoaded: null,
          };
          state.onTileLoaded = () => sweepStaleTiles(state);
          overlayState.set(id, state);
        } else {
          const prevMode = state.def.mode;
          const urlChanged =
            (mode === "tile" && state.def.url !== ovr.url) ||
            (mode === "fields" && state.def.exportUrl !== ovr.exportUrl);
          state.def = {
            ...ovr,
            mode,
            opacity,
            minZoom: ovr.minZoom ?? 0,
            maxZoom: ovr.maxZoom ?? 19,
          };
          if (prevMode !== mode) {
            // Mode flipped — drop tile/fields/vectors state so the next
            // refresh starts clean.
            for (const entry of state.tileCache.values()) {
              if (!entry) continue;
              if (entry.removeTimer) {
                clearTimeout(entry.removeTimer);
                entry.removeTimer = null;
              }
              if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
              entry.mat?.dispose?.();
              entry.texRef?.tex?.dispose?.();
              entry.mesh?.geometry?.dispose?.();
            }
            state.tileCache.clear();
            state.activeTiles.clear();
            state.lastEffZ = null;
            disposeFieldsOverlay(state);
            disposeVectorOverlay(state);
          }
          if (state.zLift !== zLift) {
            state.zLift = zLift;
            // Tile-mode meshes are now built directly in scene-space with
            // the zLift baked into the position buffer, but rebuilds are
            // cheap — drop the cache so the next refresh re-clips at the
            // new zLift instead of trying to patch positions in place
            // (which would fight the (mercX, zLift, -mercY) layout).
            for (const entry of state.tileCache.values()) {
              if (!entry) continue;
              if (entry.removeTimer) {
                clearTimeout(entry.removeTimer);
                entry.removeTimer = null;
              }
              if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
              entry.mat?.dispose?.();
              entry.texRef?.tex?.dispose?.();
              entry.mesh?.geometry?.dispose?.();
            }
            state.tileCache.clear();
            state.activeTiles.clear();
          }
          for (const entry of state.tileCache.values()) {
            if (!entry) continue;
            if (entry.mat) {
              if (entry.mat.opacity > 0 || entry.mat.map) entry.mat.opacity = opacity;
            }
          }
          if (state.fields?.mat) {
            if (state.fields.mat.opacity > 0 || state.fields.mat.map) {
              state.fields.mat.opacity = opacity;
            }
          }
          if (state.vectors?.meshes?.length) {
            for (const entry of state.vectors.meshes) {
              if (entry.mat) entry.mat.opacity = opacity;
            }
          }
          if (urlChanged) {
            for (const entry of state.tileCache.values()) {
              if (!entry) continue;
              if (entry.mesh.parent === state.group) state.group.remove(entry.mesh);
              entry.mat?.dispose?.();
              entry.texRef?.tex?.dispose?.();
              entry.mesh?.geometry?.dispose?.();
            }
            state.tileCache.clear();
            state.activeTiles.clear();
            if (state.fields) {
              state.fields.lastFetchKey = "";
              state.fields.seq += 1;
            }
          }
        }
      });

      const ordered = list
        .map((ovr, i) => {
          if (!isValidOverlay(ovr)) return null;
          const id = ovr.id ?? `_overlay_${i}`;
          return overlayState.get(id)?.group || null;
        })
        .filter(Boolean);
      overlaysGroup.children = ordered;

      refreshOverlayTiles();
    }

    function ringToMercatorPts(ring, zLift) {
      return ring.map((p) => {
        const m = lonLatToMeters(p.lng, p.lat);
        return new THREE.Vector3(m.x, zLift, -m.y);
      });
    }

    /**
     * Build a flat XZ-plane mesh from a closed lat/lng ring at the given
     * elevation `zLift`. The result lives in the same coordinate space as
     * the field outlines (mercX, zLift, -mercY) so it stays inside the
     * camera frustum at all latitudes.
     *
     * Earlier versions used `ShapeGeometry + rotateX(-PI/2) + translate`
     * which mirrors the geometry across the equator (3D Z becomes
     * `+mercY` instead of `-mercY`); for a UK field at 52° N that pushes
     * scene Z out to ~14 000 km — well past the orthographic camera's
     * far plane — and the mesh disappears entirely. Triangulating in
     * bbox-local coords here also keeps the float32 path Earcut runs on
     * away from the precision cliff that raw 1e7-scale mercator coords
     * fall off.
     */
    function buildRingFillMesh(ring, zLift, color, opacity) {
      if (!Array.isArray(ring) || ring.length < 3) return null;
      const pts = [];
      let minx = Infinity;
      let miny = Infinity;
      for (const p of ring) {
        const m = lonLatToMeters(p.lng, p.lat);
        pts.push({ x: m.x, y: m.y });
        if (m.x < minx) minx = m.x;
        if (m.y < miny) miny = m.y;
      }
      const localContour = pts.map((p) => new THREE.Vector2(p.x - minx, p.y - miny));
      let tris = null;
      try {
        tris = THREE.ShapeUtils.triangulateShape(localContour, []);
      } catch {
        tris = null;
      }
      if (!tris || !tris.length) {
        // Fan fallback — covers the (rare) case where Earcut chokes on a
        // self-touching ring that's still mostly drawable.
        tris = [];
        for (let k = 1; k < pts.length - 1; k++) tris.push([0, k, k + 1]);
        if (!tris.length) return null;
      }
      const positions = new Float32Array(pts.length * 3);
      let o = 0;
      for (const p of pts) {
        positions[o] = p.x;
        positions[o + 1] = zLift;
        positions[o + 2] = -p.y;
        o += 3;
      }
      const indices = [];
      for (const t of tris) indices.push(t[0], t[1], t[2]);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setIndex(indices);
      geom.computeBoundingSphere();
      const mat = new THREE.MeshBasicMaterial({
        color: color instanceof THREE.Color ? color : new THREE.Color(color || 0x104e3f),
        transparent: true,
        opacity: opacity ?? 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      return { mesh, geom, mat };
    }

    function updateOverlays() {
      disposeGroupContents(fillsGroup);
      disposeGroupContents(linesGroup);
      disposeGroupContents(markersGroup);
      disposeGroupContents(draftGroup);
      disposeGroupContents(editGroup);

      const sf = savedRef.current || [];
      const selectedId = selectedIdRef.current;
      const hoverIdLocal = hoverIdRef.current;
      const choro = choroplethRef.current || {};
      const markers = Array.isArray(pointMarkersRef.current) ? pointMarkersRef.current : [];
      const editing = editingFieldIdRef.current;
      const editRingLocal = editRingRef.current;

      for (const f of sf) {
        if (!isWgsRing(f.boundary) || f.boundary.length < 3) continue;
        const fid = f.id || f.name;
        // If this field is being edited, skip its static rendering; the
        // editable draft (editRing) renders below instead.
        if (editing && fid === editing) continue;
        const isSelected = selectedId && fid === selectedId;
        const isHover = hoverIdLocal && fid === hoverIdLocal;
        const override = choro[fid];

        const fillColor = override?.color
          ? new THREE.Color(override.color)
          : isSelected
            ? new THREE.Color(0xec9a29)
            : isHover
              ? new THREE.Color(0x649a5c)
              : new THREE.Color(0x104e3f);
        const fillOpacity = override
          ? 0.55
          : isSelected
            ? 0.28
            : isHover
              ? 0.2
              : 0.06;

        const built = buildRingFillMesh(f.boundary, 0.08, fillColor, fillOpacity);
        if (built) {
          built.mesh.userData.fieldId = fid;
          built.mesh.renderOrder = -5;
          fillsGroup.add(built.mesh);
        }

        const strokeColor = isSelected
          ? 0xec9a29
          : isHover
            ? 0x649a5c
            : 0x104e3f;
        const lineMat = new THREE.LineBasicMaterial({
          color: strokeColor,
          transparent: true,
          opacity: 0.95,
          depthTest: true,
        });
        const zLift = isSelected ? 0.2 : isHover ? 0.16 : 0.12;
        const pts = ringToMercatorPts(f.boundary, zLift);
        const lineGeom = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
        const line = new THREE.Line(lineGeom, lineMat);
        line.userData.fieldId = fid;
        linesGroup.add(line);
      }

      if (markers.length) {
        const mpp = (TWO_PI_R * Math.cos((view.lat * Math.PI) / 180)) / (256 * 2 ** viewZoom);
        const dotRadiusM = Math.max(mpp * 9, 1.4);
        const ringRadiusM = dotRadiusM * 1.6;
        const dotGeom = new THREE.CircleGeometry(dotRadiusM, 32);
        dotGeom.rotateX(-Math.PI / 2);
        const ringGeom = new THREE.RingGeometry(ringRadiusM * 0.72, ringRadiusM, 32);
        ringGeom.rotateX(-Math.PI / 2);

        for (const marker of markers) {
          if (!Number.isFinite(marker?.lat) || !Number.isFinite(marker?.lng)) continue;
          const mm = lonLatToMeters(marker.lng, marker.lat);
          const color = new THREE.Color(marker.color || "#104e3f");
          const halo = new THREE.Mesh(
            ringGeom.clone(),
            new THREE.MeshBasicMaterial({
              color: 0xffffff,
              transparent: true,
              opacity: 0.94,
              side: THREE.DoubleSide,
              depthWrite: false,
            })
          );
          halo.position.set(mm.x, 0.82, -mm.y);
          halo.renderOrder = 20;
          markersGroup.add(halo);

          const dot = new THREE.Mesh(
            dotGeom.clone(),
            new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.98,
              side: THREE.DoubleSide,
              depthWrite: false,
            })
          );
          dot.position.set(mm.x, 0.84, -mm.y);
          dot.renderOrder = 21;
          dot.userData.pointMarkerId = marker.id;
          markersGroup.add(dot);
        }
      }

      const dr = draftRef.current;
      if (Array.isArray(dr) && dr.length >= 2 && isWgsRing(dr)) {
        const pts = ringToMercatorPts(dr, 0.18);
        const closed = pts.length >= 3 ? [...pts, pts[0]] : pts;
        const draftLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(closed),
          new THREE.LineBasicMaterial({
            color: 0xec9a29,
            transparent: true,
            opacity: 0.95,
          })
        );
        draftGroup.add(draftLine);

        if (pts.length >= 3) {
          const built = buildRingFillMesh(dr, 0.16, 0xec9a29, 0.14);
          if (built) draftGroup.add(built.mesh);
        }
      }

      // Edit-mode ring + vertex/midpoint handles
      if (
        editing &&
        Array.isArray(editRingLocal) &&
        editRingLocal.length >= 2 &&
        isWgsRing(editRingLocal)
      ) {
        const pts = ringToMercatorPts(editRingLocal, 0.3);
        const closed = pts.length >= 3 ? [...pts, pts[0]] : pts;
        const editLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(closed),
          new THREE.LineBasicMaterial({
            color: 0xec9a29,
            transparent: true,
            opacity: 1.0,
          })
        );
        editGroup.add(editLine);

        if (pts.length >= 3) {
          const built = buildRingFillMesh(editRingLocal, 0.28, 0xec9a29, 0.18);
          if (built) {
            built.mesh.renderOrder = -5;
            editGroup.add(built.mesh);
          }
        }

        const mpp = (TWO_PI_R * Math.cos((view.lat * Math.PI) / 180)) / (256 * 2 ** viewZoom);
        const handleRadiusM = Math.max(mpp * 9, 1);

        const vGeom = new THREE.CircleGeometry(handleRadiusM, 20);
        vGeom.rotateX(-Math.PI / 2);
        const vRingGeom = new THREE.RingGeometry(handleRadiusM * 0.86, handleRadiusM, 24);
        vRingGeom.rotateX(-Math.PI / 2);

        for (let i = 0; i < editRingLocal.length; i++) {
          const p = editRingLocal[i];
          const mm = lonLatToMeters(p.lng, p.lat);
          const inner = new THREE.Mesh(
            vGeom.clone(),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, depthWrite: false })
          );
          inner.position.set(mm.x, 0.5, -mm.y);
          inner.userData.editHandle = "vertex";
          inner.userData.vertexIndex = i;
          editGroup.add(inner);

          const outline = new THREE.Mesh(
            vRingGeom.clone(),
            new THREE.MeshBasicMaterial({
              color: 0xec9a29,
              transparent: true,
              opacity: 1,
              side: THREE.DoubleSide,
              depthWrite: false,
            })
          );
          outline.position.set(mm.x, 0.51, -mm.y);
          editGroup.add(outline);
        }

        if (editRingLocal.length >= 2) {
          const midGeom = new THREE.CircleGeometry(handleRadiusM * 0.58, 16);
          midGeom.rotateX(-Math.PI / 2);
          for (let i = 0; i < editRingLocal.length; i++) {
            const a = editRingLocal[i];
            const b = editRingLocal[(i + 1) % editRingLocal.length];
            const ma = lonLatToMeters(a.lng, a.lat);
            const mb = lonLatToMeters(b.lng, b.lat);
            const mx = (ma.x + mb.x) / 2;
            const my = (ma.y + mb.y) / 2;
            const disc = new THREE.Mesh(
              midGeom.clone(),
              new THREE.MeshBasicMaterial({
                color: 0x104e3f,
                transparent: true,
                opacity: 0.82,
                depthWrite: false,
              })
            );
            disc.position.set(mx, 0.48, -my);
            disc.userData.editHandle = "midpoint";
            disc.userData.insertAfter = i;
            editGroup.add(disc);
          }
        }
      }
    }

    function updateOrtho() {
      const aspect2 = el.clientWidth / Math.max(el.clientHeight, 1);
      const span = TWO_PI_R / 2 ** viewZoom;
      halfH = span * 0.55;
      halfW = halfH * aspect2;
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
    }

    function emitView() {
      const { lon, lat } = metersToLonLat(viewCx, viewCy);
      const next = { lat, lng: lon, zoom: viewZoom };
      setView(next);
      onViewChange?.(next);
    }

    function setCenterZoom(lat, lng, z) {
      const m = lonLatToMeters(lng, lat);
      viewCx = m.x;
      viewCy = m.y;
      viewZoom = Math.min(19, Math.max(2, Math.round(z)));
      updateOrtho();
      syncMapWorldPosition();
      refreshTiles();
      refreshOverlayTiles();
      updateOverlays();
      emitView();
    }

    function zoomBy(delta) {
      const nz = Math.min(19, Math.max(2, viewZoom + delta));
      if (nz === viewZoom) return;
      viewZoom = nz;
      updateOrtho();
      syncMapWorldPosition();
      refreshTiles();
      refreshOverlayTiles();
      updateOverlays();
      emitView();
    }

    /**
     * Frame a WGS84 ring in view with optional padding. Computes the smallest
     * Mercator-meters bounding box and picks the max zoom that fits it inside
     * the current viewport (×(1+padding)).
     */
    function fitRing(ring, opts = {}) {
      if (!Array.isArray(ring) || ring.length < 1) return;
      const padding = Number.isFinite(opts.padding) ? opts.padding : 0.25;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLng = Infinity;
      let maxLng = -Infinity;
      for (const p of ring) {
        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }
      if (!Number.isFinite(minLat)) return;
      const cLat = (minLat + maxLat) / 2;
      const cLng = (minLng + maxLng) / 2;
      const yMin = lonLatToMeters(cLng, minLat).y;
      const yMax = lonLatToMeters(cLng, maxLat).y;
      const xMin = lonLatToMeters(minLng, cLat).x;
      const xMax = lonLatToMeters(maxLng, cLat).x;
      const extY = Math.max(Math.abs(yMax - yMin), 4);
      const extX = Math.max(Math.abs(xMax - xMin), 4);
      const elW = Math.max(el.clientWidth, 320);
      const elH = Math.max(el.clientHeight, 320);
      const aspect = elW / elH;
      const needHalfH = Math.max(extY / 2, (extX / aspect) / 2) * (1 + padding);
      const spanNeeded = Math.max(needHalfH / 0.55, 1);
      const zf = Math.log2(TWO_PI_R / spanNeeded);
      const z = Math.min(19, Math.max(2, Math.floor(zf)));
      setCenterZoom(cLat, cLng, z);
    }

    refreshTiles();
    reconcileOverlays(overlaysRef.current);
    updateOverlays();
    emitView();

    const rafRef = { id: 0 };
    const tick = () => {
      renderer.render(scene, camera);
      rafRef.id = requestAnimationFrame(tick);
    };
    tick();

    const DRAG_PX = 6;
    let dragging = false;
    let ptrDown = false;
    let ptrOnCanvas = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    let vertexDrag = null; // { index, pointerId }
    const activePointers = new Map();
    let pinchDistance = 0;
    let pinching = false;

    function currentPinchDistance() {
      const pts = [...activePointers.values()];
      if (pts.length < 2) return 0;
      const dx = pts[0].clientX - pts[1].clientX;
      const dy = pts[0].clientY - pts[1].clientY;
      return Math.hypot(dx, dy);
    }

    function screenToLatLng(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
      const mx = hit.x + viewCx;
      const my = viewCy - hit.z;
      return metersToLonLat(mx, my);
    }

    function hitEditHandle(clientX, clientY) {
      if (!editingFieldIdRef.current) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(editGroup.children, false);
      for (const h of hits) {
        const d = h.object?.userData || {};
        if (d.editHandle === "vertex") return { kind: "vertex", index: d.vertexIndex };
        if (d.editHandle === "midpoint") return { kind: "midpoint", insertAfter: d.insertAfter };
      }
      return null;
    }

    const onWheel = (ev) => {
      ev.preventDefault();
      const dir = ev.deltaY > 0 ? -1 : 1;
      zoomBy(dir);
    };

    const onContextMenu = (ev) => {
      if (!editingFieldIdRef.current) return;
      ev.preventDefault();
      const handle = hitEditHandle(ev.clientX, ev.clientY);
      if (handle?.kind === "vertex") {
        const ring = editRingRef.current || [];
        if (ring.length <= 3) return; // keep at least a triangle
        const next = ring.filter((_, i) => i !== handle.index);
        onEditRingChangeRef.current?.(next);
      }
    };

    const onPointerDown = (ev) => {
      ev.preventDefault();
      activePointers.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });
      if (activePointers.size === 2 && mapModeRef.current === "pan" && !editingFieldIdRef.current) {
        pinchDistance = currentPinchDistance();
        pinching = true;
        ptrDown = false;
        dragging = true;
        return;
      }

      ptrOnCanvas = true;
      ptrDown = true;
      dragging = false;
      downX = lastX = ev.clientX;
      downY = lastY = ev.clientY;

      // In edit mode, intercept vertex drags before pan / selection kick in.
      if (editingFieldIdRef.current) {
        const handle = hitEditHandle(ev.clientX, ev.clientY);
        if (handle?.kind === "vertex") {
          if (ev.shiftKey) {
            const ring = editRingRef.current || [];
            if (ring.length > 3) {
              onEditRingChangeRef.current?.(ring.filter((_, i) => i !== handle.index));
            }
            ptrDown = false;
            return;
          }
          vertexDrag = { index: handle.index, pointerId: ev.pointerId };
          try {
            ev.target.setPointerCapture(ev.pointerId);
          } catch {
            /* ignore */
          }
          return;
        }
        if (handle?.kind === "midpoint") {
          const ll = screenToLatLng(ev.clientX, ev.clientY);
          const ring = editRingRef.current || [];
          if (ll && ring.length) {
            const insertAt = handle.insertAfter + 1;
            const next = [
              ...ring.slice(0, insertAt),
              { lat: ll.lat, lng: ll.lon },
              ...ring.slice(insertAt),
            ];
            onEditRingChangeRef.current?.(next);
          }
          ptrDown = false;
          return;
        }
      }

      if (mapModeRef.current === "pan") {
        try {
          ev.target.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    let pendingHover = null;
    const requestHover = (clientX, clientY) => {
      if (!hoverEnabledRef.current) return;
      if (pendingHover) return;
      pendingHover = requestAnimationFrame(() => {
        pendingHover = null;
        const rect = renderer.domElement.getBoundingClientRect();
        if (
          clientX < rect.left ||
          clientX > rect.right ||
          clientY < rect.top ||
          clientY > rect.bottom
        ) {
          if (hoverIdRef.current !== null) {
            hoverIdRef.current = null;
            setHoverId(null);
            updateOverlays();
          }
          return;
        }
        ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(fillsGroup.children, false);
        const fid = hits[0]?.object?.userData?.fieldId ?? null;
        if (fid !== hoverIdRef.current) {
          hoverIdRef.current = fid;
          setHoverId(fid);
          updateOverlays();
        }
      });
    };

    const onPointerMove = (ev) => {
      if (activePointers.has(ev.pointerId)) {
        activePointers.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });
      }

      if (pinching && activePointers.size >= 2 && mapModeRef.current === "pan") {
        ev.preventDefault();
        const nextDistance = currentPinchDistance();
        if (pinchDistance > 0 && nextDistance > 0) {
          if (nextDistance > pinchDistance * 1.18) {
            zoomBy(1);
            pinchDistance = nextDistance;
          } else if (nextDistance < pinchDistance / 1.18) {
            zoomBy(-1);
            pinchDistance = nextDistance;
          }
        }
        return;
      }

      if (vertexDrag && ev.buttons === 1) {
        ev.preventDefault();
        const ll = screenToLatLng(ev.clientX, ev.clientY);
        const ring = editRingRef.current || [];
        if (ll && vertexDrag.index < ring.length) {
          const next = [...ring];
          next[vertexDrag.index] = { lat: ll.lat, lng: ll.lon };
          onEditRingChangeRef.current?.(next);
        }
        return;
      }

      const primaryDrag = ev.buttons === 1 || ev.pointerType === "touch" || ev.pointerType === "pen";
      if (ptrDown && primaryDrag && mapModeRef.current === "pan") {
        ev.preventDefault();
        const acc = Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY);
        if (!dragging && acc < DRAG_PX) return;
        dragging = true;

        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;

        const worldPerPxX =
          (camera.right - camera.left) / renderer.domElement.clientWidth;
        const worldPerPxY =
          (camera.top - camera.bottom) / renderer.domElement.clientHeight;
        viewCx -= dx * worldPerPxX;
        viewCy += dy * worldPerPxY;
        syncMapWorldPosition();
        return;
      }
      if (mapModeRef.current === "pan" && !ptrDown) {
        requestHover(ev.clientX, ev.clientY);
      }
    };

    const onPointerUp = (ev) => {
      activePointers.delete(ev.pointerId);
      if (activePointers.size < 2) {
        pinchDistance = 0;
        if (pinching) {
          pinching = false;
          ptrDown = false;
          ptrOnCanvas = false;
          dragging = false;
          return;
        }
      }

      if (vertexDrag) {
        try {
          renderer.domElement.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        vertexDrag = null;
        ptrDown = false;
        dragging = false;
        ptrOnCanvas = false;
        return;
      }
      if (!ptrDown) return;
      ptrDown = false;
      try {
        renderer.domElement.releasePointerCapture(ev.pointerId);
      } catch {
        /* no capture */
      }
      if (ptrOnCanvas && !dragging) {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);

        if (mapModeRef.current === "pan") {
          // Pan-mode click does two things in parallel:
          //   1. Fire `onOverlayClick` with the world (lat/lng) coordinate so
          //      the workspace can run identify / GetFeatureInfo against any
          //      active overlay layers. The renderer doesn't know which
          //      layers are interrogatable — it just hands off the click.
          //   2. Run field selection. Both happen on the same click; if
          //      there are no active overlays the identify call is a no-op.
          if (onOverlayClickRef.current && raycaster.ray.intersectPlane(groundPlane, hit)) {
            const mx = hit.x + viewCx;
            const my = viewCy - hit.z;
            const { lon, lat } = metersToLonLat(mx, my);
            try {
              onOverlayClickRef.current({
                lat,
                lng: lon,
                zoom: viewZoom,
                clientX: ev.clientX,
                clientY: ev.clientY,
              });
            } catch (e) {
              console.warn("[FieldMapThree2D] onOverlayClick handler threw:", e?.message || e);
            }
          }
          const hits = raycaster.intersectObjects(fillsGroup.children, false);
          const fid = hits[0]?.object?.userData?.fieldId ?? null;
          if (fid && onSelectFieldRef.current) onSelectFieldRef.current(fid);
        } else if (raycaster.ray.intersectPlane(groundPlane, hit)) {
          const mx = hit.x + viewCx;
          const my = viewCy - hit.z;
          const { lon, lat } = metersToLonLat(mx, my);
          if (mapModeRef.current === "find") {
            onFindFieldClickRef.current?.(lat, lon);
          } else if (mapModeRef.current === "draw") {
            onAddVertexRef.current?.(lat, lon);
          }
        }
      }
      if (dragging) {
        refreshTiles();
        refreshOverlayTiles();
        emitView();
      }
      ptrOnCanvas = false;
      dragging = false;
    };

    const onPointerLeave = () => {
      if (hoverIdRef.current !== null) {
        hoverIdRef.current = null;
        setHoverId(null);
        updateOverlays();
      }
    };

    const onPointerCancel = (ev) => {
      activePointers.delete(ev.pointerId);
      ptrDown = false;
      ptrOnCanvas = false;
      dragging = false;
      pinching = false;
      pinchDistance = 0;
      vertexDrag = null;
    };

    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("pointerdown", onPointerDown, { passive: false });
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);

    const ro = new ResizeObserver(() => {
      const ww = Math.max(el.clientWidth, 320);
      const hh = Math.max(el.clientHeight, 320);
      renderer.setSize(ww, hh);
      updateOrtho();
      syncMapWorldPosition();
      refreshTiles();
      refreshOverlayTiles();
      updateOverlays();
    });
    ro.observe(el);

    ctxRef.current = {
      setCenterZoom,
      zoomBy,
      changeBasemap,
      fitRing,
      refreshOverlays: updateOverlays,
      reconcileOverlays,
      refreshOverlayTiles,
      getView: () => ({
        lat: metersToLonLat(viewCx, viewCy).lat,
        lng: metersToLonLat(viewCx, viewCy).lon,
        zoom: viewZoom,
      }),
    };
    onReadyRef.current?.(ctxRef.current);

    return () => {
      cancelAnimationFrame(rafRef.id);
      if (pendingHover) cancelAnimationFrame(pendingHover);
      ro.disconnect();
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      disposeGroupContents(tilesGroup);
      for (const state of overlayState.values()) disposeOverlayState(state);
      overlayState.clear();
      disposeGroupContents(overlaysGroup);
      disposeGroupContents(fillsGroup);
      disposeGroupContents(linesGroup);
      disposeGroupContents(markersGroup);
      disposeGroupContents(draftGroup);
      disposeGroupContents(editGroup);
      for (const entry of tileCache.values()) {
        if (entry.mat) entry.mat.dispose?.();
        if (entry.texRef?.tex) entry.texRef.tex.dispose?.();
        if (entry.mesh?.geometry) entry.mesh.geometry.dispose();
      }
      tileCache.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync center/zoom into the live scene when props change.
  useEffect(() => {
    const lat = center?.[0];
    const lng = center?.[1];
    const z = zoom;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(z)) return;
    const prev = lastCenterZoomRef.current;
    if (prev && prev[0] === lat && prev[1] === lng && prev[2] === z) return;
    lastCenterZoomRef.current = [lat, lng, z];
    ctxRef.current?.setCenterZoom?.(lat, lng, z);
  }, [center, zoom]);

  useEffect(() => {
    ctxRef.current?.refreshOverlays?.();
    // Saved-field geometry edits change the polygon-clip footprint of every
    // overlay tile, so we have to ask the tile layer to re-evaluate too.
    // Cosmetic-only changes (selection / hover / choropleth) don't perturb
    // `fieldsClipSignature` so this is a cheap no-op in that case.
    ctxRef.current?.refreshOverlayTiles?.();
  }, [savedFields, draftRing, selectedFieldId, choropleth, pointMarkers, editRing, editingFieldId]);

  useEffect(() => {
    ctxRef.current?.reconcileOverlays?.(overlays);
  }, [overlays]);

  useEffect(() => {
    setActiveBasemap(basemap);
  }, [basemap]);

  useEffect(() => {
    ctxRef.current?.changeBasemap?.(activeBasemap);
  }, [activeBasemap]);

  const provider = BASEMAPS[activeBasemap] || BASEMAPS.osm;
  const controlTone = provider.ui === "dark" ? "dark" : "light";
  const bottomInset = Number(uiInsets.bottom) || 0;
  const mapCursor = useMemo(() => {
    if (editingFieldId) return "crosshair";
    if (mapMode === "find") return "crosshair";
    if (mapMode === "draw") return "crosshair";
    return "grab";
  }, [mapMode, editingFieldId]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: height || "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        ref={containerRef}
        style={{
          flex: "1 1 auto",
          width: "100%",
          minHeight: 0,
          borderRadius: 2,
          overflow: "hidden",
          border: "1px solid #dce9de",
          background: "#dce9de",
          cursor: mapCursor,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      />

      {controls ? (
        <MapControls
          tone={controlTone}
          basemap={activeBasemap}
          onBasemap={setActiveBasemap}
          onZoom={(d) => ctxRef.current?.zoomBy?.(d)}
          onRecenter={
            center
              ? () => ctxRef.current?.setCenterZoom?.(center[0], center[1], zoom)
              : null
          }
          top={uiInsets.top}
          right={uiInsets.right}
          left={uiInsets.left}
        />
      ) : null}

      <CoordReadout tone={controlTone} view={view} bottom={bottomInset + 8} />
      <ScaleBar tone={controlTone} view={view} bottom={bottomInset + 38} />

      <a
        href={
          activeBasemap === "satellite"
            ? "https://www.esri.com/en-us/legal/overview"
            : "https://www.openstreetmap.org/copyright"
        }
        target="_blank"
        rel="noreferrer"
        style={{
          position: "absolute",
          right: 8,
          bottom: bottomInset + 6,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 9.5,
          letterSpacing: "0.04em",
          color: controlTone === "dark" ? "rgba(255,255,255,0.85)" : "#54695f",
          background: controlTone === "dark" ? "rgba(14,42,36,0.65)" : "rgba(255,255,255,0.88)",
          padding: "3px 7px",
          borderRadius: 2,
          textDecoration: "none",
          zIndex: 2,
          maxWidth: "40%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {provider.attribution}
      </a>
    </div>
  );
}

function MapControls({ tone, basemap, onBasemap, onZoom, onRecenter, top = 8, right = 8, left = 8 }) {
  const dark = tone === "dark";
  const bg = dark ? "rgba(14,42,36,0.72)" : "rgba(255,255,255,0.92)";
  const fg = dark ? "#F4F9F4" : "#104E3F";
  const border = dark ? "rgba(255,255,255,0.18)" : "rgba(16,78,63,0.15)";

  const btnStyle = {
    width: 30,
    height: 30,
    border: `1px solid ${border}`,
    background: bg,
    color: fg,
    borderRadius: 2,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: 14,
    fontWeight: 500,
  };

  return (
    <>
      <div
        style={{
          position: "absolute",
          top,
          right,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          zIndex: 3,
        }}
      >
        <button type="button" style={btnStyle} onClick={() => onZoom(1)} aria-label="Zoom in">
          +
        </button>
        <button type="button" style={btnStyle} onClick={() => onZoom(-1)} aria-label="Zoom out">
          −
        </button>
        {onRecenter ? (
          <button
            type="button"
            style={btnStyle}
            onClick={onRecenter}
            aria-label="Recenter map"
            title="Recenter"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          </button>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          top,
          left,
          display: "inline-flex",
          gap: 0,
          zIndex: 3,
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        {Object.entries(BASEMAPS).map(([id, info]) => {
          const active = id === basemap;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onBasemap(id)}
              style={{
                fontFamily: "'DM Sans', system-ui, sans-serif",
                fontSize: 10.5,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                padding: "6px 10px",
                border: "none",
                background: active ? (dark ? "rgba(255,255,255,0.18)" : "#104E3F") : "transparent",
                color: active ? (dark ? "#fff" : "#fff") : fg,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {info.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

function CoordReadout({ tone, view, bottom = 8 }) {
  const dark = tone === "dark";
  return (
    <div
      style={{
        position: "absolute",
        left: 8,
        bottom,
        zIndex: 2,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 9.5,
        letterSpacing: "0.06em",
        padding: "4px 7px",
        borderRadius: 2,
        background: dark ? "rgba(14,42,36,0.72)" : "rgba(255,255,255,0.9)",
        color: dark ? "#F4F9F4" : "#104E3F",
        border: `1px solid ${dark ? "rgba(255,255,255,0.18)" : "rgba(16,78,63,0.12)"}`,
        display: "inline-flex",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      <span>
        lat{" "}
        <strong style={{ fontWeight: 500 }}>
          {Number.isFinite(view.lat) ? view.lat.toFixed(5) : "—"}
        </strong>
      </span>
      <span>
        lng{" "}
        <strong style={{ fontWeight: 500 }}>
          {Number.isFinite(view.lng) ? view.lng.toFixed(5) : "—"}
        </strong>
      </span>
      <span>
        z <strong style={{ fontWeight: 500 }}>{view.zoom}</strong>
      </span>
    </div>
  );
}

function ScaleBar({ tone, view, bottom = 38 }) {
  const dark = tone === "dark";
  const { meters, label, px } = useMemo(() => computeScaleBar(view), [view]);
  if (!px) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom,
        zIndex: 2,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 9.5,
        color: dark ? "rgba(244,249,244,0.92)" : "#104E3F",
        background: "transparent",
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <div
        style={{
          width: px,
          height: 3,
          background: dark ? "rgba(244,249,244,0.85)" : "#104E3F",
          marginBottom: 2,
          boxShadow: dark ? "0 0 0 1px rgba(0,0,0,0.35)" : "0 0 0 1px rgba(255,255,255,0.7)",
        }}
      />
      <div style={{ letterSpacing: "0.08em" }} title={`${meters} m`}>
        {label}
      </div>
    </div>
  );
}

function computeScaleBar(view) {
  const z = view.zoom;
  const lat = view.lat;
  if (!Number.isFinite(z) || !Number.isFinite(lat)) return { meters: 0, label: "", px: 0 };
  const mpp = (TWO_PI_R * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);
  const targetPx = 110;
  const targetM = mpp * targetPx;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(targetM, 1))));
  const steps = [1, 2, 5, 10].map((k) => k * pow);
  const chosen = steps.reduce((acc, v) => (Math.abs(v - targetM) < Math.abs(acc - targetM) ? v : acc), steps[0]);
  const px = Math.max(24, Math.round(chosen / mpp));
  const label = chosen >= 1000 ? `${(chosen / 1000).toFixed(chosen >= 10000 ? 0 : 1)} km` : `${Math.round(chosen)} m`;
  return { meters: chosen, label, px };
}

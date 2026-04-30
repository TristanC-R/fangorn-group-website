# Tilth API (small Node backend)

Runs on your own PC or server so **Nominatim** and **Overpass** see a proper **`User-Agent`** and contact **`email`**, instead of relying on browser-only `fetch` to public OSM endpoints.

## Requirements

- **Node.js 18+** (uses global `fetch`)

## Setup

1. Copy `tilth-api/.env.example` to `tilth-api/.env` and set at least **`OSM_CONTACT_EMAIL`** and **`CORS_ORIGINS`** (your real site origin(s), plus `http://localhost:5173` for local dev).

2. From the **repository root**:

   ```bash
   npm run tilth-api
   ```

   Default listen: **`http://0.0.0.0:3847`**.

## Frontend

In the website `.env` set:

```bash
VITE_TILTH_API_URL=http://YOUR_PC_IP:3847
```

Rebuild or restart Vite (`npm run dev`). When this variable is set, geocoding and OSM field lookup go through your backend; tiles still load directly from `tile.openstreetmap.org` in the browser.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| POST | `/api/osm/field-at-point` | JSON `{ "lat", "lng", "radiusM?" }` (default ~220 m) → Overpass → **one** outline containing the point, or `null` |
| GET | `/api/nominatim/search?...` | Forwards to Nominatim `/search` with server `User-Agent` + `email` |
| GET | `/api/wms/layers` | Manifest of overlay layers (id, label, provider, attribution, group). Frontend uses this to populate the Soil & Land workspace. |
| GET | `/api/wms/:id?z=&x=&y=` | Proxies a single 256×256 tile for overlay `:id` at slippy-map `z/x/y`. Handles WMS 1.1.1 / 1.3.0, ArcGIS `MapServer/export`, and plain XYZ upstreams. On failure a 1×1 transparent PNG is returned so the map stays clean. |

## WMS overlays (Soil & Land workspace)

The Tilth frontend never talks to WMS providers directly — it always asks this API for a tile (`/api/wms/:id?z=..&x=..&y=..`) keyed by a short layer id. This keeps:

- **CORS clean** — providers like BGS, Environment Agency, and Cranfield don't need to whitelist the site.
- **Attribution consistent** — the canonical provider string lives server-side in the registry.
- **Caching cheap** — tiles are LRU-cached in memory (bounded by `WMS_CACHE_MAX`, TTL `WMS_CACHE_TTL_MS`) and served with `Cache-Control: public, max-age=86400`.

### Built-in layer registry

The default registry (`WMS_DEFAULT_LAYERS` inside `server.mjs`) covers:

- **Soil** — Soilscapes (Cranfield / NSRI), soil pH, soil organic carbon.
- **Geology** — BGS 1:50k bedrock, G-BASE stream-sediment geochemistry.
- **Land** — Agricultural Land Classification, MAGIC designations.
- **Hazards** — Coal Authority reported mining, EA flood risk zones, OpenTopoMap relief (always-works sanity overlay).

Some of these endpoints (noted in-code with `needsTenantConfig: true`) may require per-tenant URLs, an API key, or access agreements with the provider — Soilscapes and MAGIC especially. For those, the proxy will serve transparent tiles (and log the upstream 4xx to stdout) until you point the registry at a URL you're authorised to use.

### Overriding layer definitions

Create **`tilth-api/layers.json`** (or point `TILTH_WMS_LAYERS_FILE` at a file anywhere) containing a map keyed by layer id:

```json
{
  "soilscapes": {
    "url": "https://map.landis.org.uk/wms/your-tenant-slug",
    "layer": "Soilscapes_2024"
  },
  "my-custom-layer": {
    "kind": "wms",
    "group": "Soil",
    "label": "Farm trial plots",
    "provider": "Fangorn R&D",
    "blurb": "Internal plot boundaries and trial codes.",
    "url": "https://gis.example.com/geoserver/wms",
    "layer": "tilth:trial_plots",
    "version": "1.3.0",
    "format": "image/png",
    "attribution": "© Fangorn R&D 2026",
    "swatches": ["#104e3f", "#d98119", "#649a5c", "#2f6077"]
  },
  "flood-risk": null
}
```

Entries are **deep-merged** into the built-in registry on startup:

- An object extends / overrides fields for that id.
- `null` removes a built-in layer.

### Layer definition shape

| Field | Purpose |
|-------|---------|
| `kind` | `"wms"`, `"arcgis"` (MapServer `/export`) or `"xyz"` (slippy template). |
| `url` | Upstream service URL. For `xyz`, include `{z}/{x}/{y}` placeholders. |
| `layer` | WMS `LAYERS` parameter (or ArcGIS `layers`). Ignored for `xyz`. |
| `version` | WMS version, default `1.3.0`. |
| `format` | Tile format, default `image/png`. |
| `crs` | CRS override, default `EPSG:3857`. |
| `styles` | WMS `STYLES` parameter (default empty). |
| `minZoom` / `maxZoom` | Optional zoom clamp; outside this range a transparent tile is served. |
| `mapScale` | **ArcGIS only.** Forces the server to render the layer at the given fake scale (e.g. `2000000`). Use this to bypass `maxScale` visibility rules on coarse raster layers (common on UKSO Parent-Material 1km rasters). |
| `dpi` | **ArcGIS only.** Override DPI used for scale calculation. Rarely needed. |
| `layers` | **ArcGIS only.** `show:N` / `hide:N` / `include:N` / `exclude:N`. |
| `label`, `provider`, `blurb`, `group`, `attribution`, `swatches` | UI metadata — exposed via `/api/wms/layers`. |
| `needsTenantConfig` | If `true`, the UI marks the layer with an amber "Check config" badge to warn the operator that URL/layer likely needs tuning. |

### Tunable env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `TILTH_WMS_LAYERS_FILE` | `tilth-api/layers.json` | Path to the JSON overrides file (if present). |
| `WMS_USER_AGENT` | `FangornTilth/1.0 (+tilth overlay proxy; $OSM_CONTACT_EMAIL)` | Sent upstream. Many providers refuse requests without a descriptive UA. |
| `WMS_CACHE_MAX` | `2048` | Max tiles in memory. |
| `WMS_CACHE_TTL_MS` | `86400000` (24 h) | Tile cache lifetime. |
| `WMS_UPSTREAM_TIMEOUT_MS` | `15000` | Per-tile upstream fetch timeout. |

### Frontend wiring

With `VITE_TILTH_API_URL` set, the Soil & Land workspace:

1. Calls `GET /api/wms/layers` on mount to populate the layer list.
2. When a layer is toggled on, the map overlay tile layer requests `GET /api/wms/:id?z=..&x=..&y=..` for each visible tile.
3. Per-layer opacity slider updates the tile material opacity live (no refetch).

If `VITE_TILTH_API_URL` is unset or the manifest fetch fails, the workspace falls back to the bundled catalogue and clearly labels overlays as "Proxy offline" — toggles still work as a UX preview but no tiles render.

## Sentinel-2 NDVI (Microsoft Planetary Computer)

The Satellite workspace shows per-field Sentinel-2 NDVI time-series and an optional NDVI raster overlay on the map. All scenes are fetched from [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/) (MPC) — fully free for any use, no auth required, and global Sentinel-2 L2A coverage.

### How it works

1. Frontend POSTs `/api/fields/:id/ndvi/refresh` (with the user's Supabase JWT).
2. Tilth API enqueues a background job: STAC search for S2 L2A scenes intersecting the field's bbox, filtered by date + cloud cover.
3. For each scene, titiler `/item/statistics` is called with the field polygon to compute per-field NDVI mean / min / max / median / stddev / valid-pixel count.
4. Each scene is upserted into `public.tilth_field_ndvi` (RLS-scoped to the farm owner). The frontend's Realtime subscription on that table updates the workspace as rows arrive.
5. The map overlay renders directly from MPC titiler tiles, proxied through `/api/sentinel/tiles/:item/:z/:x/:y.png` so the browser sees same-origin URLs and the API can cache the rendered PNGs.

### Cloud handling

NDVI is sensitive to clouds: cloud and shadow pixels have NDVI close to zero, so even a partly-cloudy scene can drag a field's mean NDVI down by 0.1+ if you don't mask them out. We apply three layers of filtering:

| Layer | Where | What it does |
|-------|-------|--------------|
| **Scene-level** | STAC search filter | Drops items where `eo:cloud_cover` > `SENTINEL_MAX_CLOUD_COVER` (default 60%) before titiler ever runs. Coarse — based on the whole 100×100 km tile, not your field. |
| **Pixel-level (SCL mask)** | Inside the titiler expression | Wraps NDVI in `where((SCL==4)\|(SCL==5), (B08-B04)/(B08+B04), -9999)`. Only Sentinel-2 SCL classes 4 (vegetation) and 5 (not-vegetated / bare soil) feed into the per-field mean. Cloud (8, 9), thin-cirrus (10), shadow (3), water (6), snow (11), defective (0, 1, 2) **and unclassified (7)** are returned as `nodata` and excluded. (Class 7 is dropped because Sen2Cor uses it as a dumping ground for ambiguous pixels, including thin cloud and cloud-edge pixels — letting them through caused 49%-cloud scenes to come back with `field_masked = 0%` and NDVI ≈ 0.02.) The same expression drives the rendered tile, so masked pixels are transparent in the overlay too. |
| **Multi-signal temporal outlier** | Frontend (`SatelliteWorkspace`) | For each field, four complementary checks flag a scene as `cloud-suspect` and exclude it from the cohort median, the below-cohort flag list, the choropleth default and the "latest scene" selector. ANY of these triggers a flag: (1) **hard floor** — NDVI ≤ 0.15 while neighbour median ≥ 0.40 (a vigorous field can't physically drop to bare-soil NDVI in 5 days, so this is almost always thick cloud the SCL labelled as vegetation); (2) **Hampel filter** — `\|x − median\| > 3·1.4826·MAD` against the 6 nearest temporal neighbours, so the threshold adapts to local variance (small deviations flagged during stable canopy, larger ones tolerated during emergence/senescence); (3) **cloud-aware downward shift** — `scene_cloud_pct ≥ 30%` AND NDVI ≥ 0.10 below neighbour median (catches partial cloud cover that drags NDVI down a bit but doesn't trip the absolute threshold — exactly the 28-Mar failure mode); (4) **absolute fallback** — `\|deviation\| > 0.30`. Suspect scenes are still scrubbable (rendered muted-grey in the curve and scrubber) so the user can compare them to clean neighbours. |

Each cached row records both:

- `scene_cloud_pct` — the scene-wide value from STAC (what triggered the scene-level filter or didn't).
- `field_cloud_pct` — `100 − valid_pct`, i.e. the percentage of pixels *inside your specific field polygon* that were masked out. This is the more useful number for assessing a single scene's reliability for a single field.

The Satellite workspace surfaces both as pills next to each scene, plus a `⚠ Likely cloud-contaminated` pill when the active scene is in the temporal-outlier set, and a `N cloud-suspect` count in the workspace header. A scene with `field_cloud_pct > 50%` should generally be ignored even if `scene_cloud_pct` looks low — your field happened to sit under one of the clouds. A scene with `field_cloud_pct = 0%` but flagged as cloud-suspect almost certainly indicates cloud the SCL didn't recognise.

To opt out (e.g. for a collection without an SCL band, or for diagnostics), pass `mask=raw` on the tile URL — the workspace doesn't expose this in the UI but the route accepts it.

### Setup

No credentials are required for public read. For production it is **strongly recommended** to register a free MPC subscription key (much higher rate limits, no anonymous-quota throttling):

1. Go to [planetarycomputer.developer.azure-api.net](https://planetarycomputer.developer.azure-api.net/) and create an account.
2. Subscribe to the *Planetary Computer* product. Copy your primary key.
3. In `tilth-api/.env` set:

   ```bash
   MPC_SUBSCRIPTION_KEY=your-primary-key-here
   ```

4. Restart `npm run tilth-api`. The startup log shows `Sentinel-2 NDVI: enabled | MPC subscription key: set`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/fields/:id/ndvi/refresh` | Auth required. Optional JSON body `{ lookbackDays, maxCloudCover, sceneLimit, force }`. Enqueues an ingest pass for one field. With `force: true` the cached rows for the field are wiped first — useful after a methodology change (e.g. enabling SCL masking). |
| GET | `/api/fields/:id/ndvi` | Auth required. Returns cached scene rows for one field (the same rows the frontend gets via Realtime). |
| GET | `/api/sentinel/tiles/:item/:z/:x/:y.png?collection=...&rescale=...&colormap=...` | Open. Proxies one titiler-rendered NDVI tile, LRU-cached server-side. |
| GET | `/api/sentinel/status` | Open. MPC config summary + ingest queue counters + tile-cache size. Useful for the workspace's "needs feed" badge. |

### Tunable env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `MPC_SUBSCRIPTION_KEY` | empty | Forwarded as `Ocp-Apim-Subscription-Key`. Anonymous works for dev. |
| `MPC_STAC_API_URL` | `https://planetarycomputer.microsoft.com/api/stac/v1` | STAC override (rarely needed). |
| `MPC_DATA_API_URL` | `https://planetarycomputer.microsoft.com/api/data/v1` | titiler override. |
| `MPC_TIMEOUT_MS` | `25000` | STAC + tile fetch timeout. |
| `MPC_STATISTICS_TIMEOUT_MS` | `45000` | Per-polygon statistics timeout (heavier — titiler reads multiple COGs). |
| `SENTINEL_LOOKBACK_DAYS` | `365` | How far back each refresh searches. |
| `SENTINEL_MAX_CLOUD_COVER` | `60` | Drop scenes above this `eo:cloud_cover` percentage before computing stats. |
| `SENTINEL_SCENE_LIMIT` | `80` | Hard cap per STAC search response. |
| `SENTINEL_INGEST_CONCURRENCY` | `2` | Parallel field jobs (each runs scenes serially). |
| `SENTINEL_INGEST_TIMEOUT_MS` | `180000` | Per-field hard timeout. |
| `SENTINEL_PER_SCENE_DELAY_MS` | `150` | Polite pacing between titiler calls. |
| `SENTINEL_TILE_CACHE_MAX` | `4096` | Rendered-PNG LRU size. |
| `SENTINEL_TILE_CACHE_TTL_MS` | `604800000` (7d) | Rendered-PNG cache lifetime. |

### Phenology metrics

The Satellite workspace also computes a per-field season summary on the fly from the suspect-filtered NDVI series (no extra storage):

- **Peak NDVI** — max in the past 365 days plus its date.
- **Days to peak** — emergence → peak, where emergence is the first 3-scene run with NDVI ≥ 0.30 prior to the peak.
- **Days since peak** — peak → today.
- **Senescence** — the first 3-scene run after peak where NDVI < 75% of peak; if found, used as the closing edge for AUC.
- **Season AUC** — trapezoidal integral of NDVI over time from emergence to senescence-or-today, in NDVI · days. Strong proxy for cumulative biomass / yield.
- **Mean NDVI** — simple average across in-window scenes.

A short interpretation line ("at or near peak", "holding canopy", "senescing", "below emergence threshold") is rendered alongside the metric tiles to give the operator an at-a-glance phase reading.

### Year-over-year overlay

The NDVI curve renders any cached scenes older than 365 days as a **dashed slate line shifted forward by 365 days** so this year's data and last year's data align by week-of-year. When the active scene has a non-suspect equivalent within ±14 days of "same week last year", a `vs last year ±0.0X` pill appears on the active-scene row.

A **Backfill 2 years** button (next to *Force re-ingest*) re-runs the ingest with `lookbackDays: 730`. Existing rows are kept; only previously-uncached older scenes are added, so it's safe to press repeatedly.

## Sentinel-1 SAR (Microsoft Planetary Computer)

Sentinel-1 RTC is a synthetic-aperture radar product that **sees through cloud**. For UK agriculture this complements Sentinel-2 NDVI: when SCL masking and the temporal outlier filter wipe out a bad week, SAR backscatter usually has a clean reading from the same week.

The pipeline mirrors NDVI exactly:

- `tilth-api/sentinel/sarClient.mjs` — STAC search + titiler `/statistics` for VV / VH per field.
- `tilth-api/sentinel/sarIngest.mjs` — bounded worker pool, idempotent enqueue, persists to `public.tilth_field_sar`.
- Schema: same shape as `tilth_field_ndvi` but with VV / VH / VH·VV ratio fields (in linear power and dB).

**The Satellite workspace UI for SAR is intentionally deferred** — the scaffolding is in place so we can backfill the cache and inspect data via the API while we design the visualisation (likely a VH backscatter raster overlay + a per-field VH·VV ratio time series alongside the existing NDVI curve).

### Endpoints (SAR)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/fields/:id/sar/refresh` | Auth required. Optional JSON body `{ lookbackDays, sceneLimit, force }`. Enqueues a SAR ingest pass for one field. |
| GET | `/api/fields/:id/sar` | Auth required. Returns cached SAR scene rows (one row per Sentinel-1 RTC item: VV, VH, VH·VV ratio in linear and dB; orbit state and relative orbit). |
| GET | `/api/sentinel1/status` | Open. SAR ingest queue counters. |

### Tunable env vars (SAR)

| Var | Default | Purpose |
|-----|---------|---------|
| `SAR_LOOKBACK_DAYS` | `365` | How far back each refresh searches. |
| `SAR_SCENE_LIMIT` | `80` | Hard cap per STAC search response. |
| `SAR_INGEST_CONCURRENCY` | `2` | Parallel SAR field jobs. |
| `SAR_INGEST_TIMEOUT_MS` | `180000` | Per-field hard timeout. |
| `SAR_PER_SCENE_DELAY_MS` | `150` | Polite pacing between titiler calls. |

Note: SAR scenes carry **no cloud filter** — every scene contains usable backscatter. Orbit direction (`ascending` / `descending`) and relative orbit are persisted alongside each row because comparisons within a single orbit track are more robust than across tracks (different incidence geometries).

## Production notes

- Put the API behind HTTPS (reverse proxy) and lock **`CORS_ORIGINS`** to your real domain only.
- Respect [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) and [Overpass](https://operations.osmfoundation.org/policies/overpass/) usage policies; this service is a thin proxy, not a cache CDN.
- Respect WMS provider terms: BGS, Environment Agency, Natural England and Coal Authority data are OGL or bespoke licenses — keep the attribution visible to end users (the Soil & Land workspace does this automatically via the map's attribution strip and the "Attribution" card on the right panel).
- For persistent cross-session caching, front the proxy with an HTTP cache (nginx, Varnish, Cloudflare) — tile responses already advertise `Cache-Control: public, max-age=86400`.

/**
 * Sentinel-2 NDVI ingest queue.
 *
 * Mirrors the shape of `tilth-api/extract/index.mjs` (one in-memory work
 * queue + bounded worker pool) but with a different "job" shape: each
 * job ingests Sentinel-2 NDVI scenes for ONE field over a time window.
 *
 * Pipeline per job:
 *   1. STAC search for Sentinel-2 L2A items intersecting the field's
 *      bbox between `startDate..endDate`, filtered by max cloud cover.
 *   2. For each item, check `tilth_field_ndvi` for an existing row; skip
 *      when the cached row is `ok` and the item has been seen before.
 *   3. POST the field polygon to titiler `/item/statistics` to compute
 *      per-field NDVI mean/min/max/median/stddev/valid_count.
 *   4. Upsert the result into `tilth_field_ndvi` with status=ok|no-data|error.
 *
 * The frontend subscribes to Realtime on `tilth_field_ndvi`, so it sees
 * scenes appear in the workspace as the queue drains.
 */

import { adminClient } from "../supabaseAdmin.mjs";

import {
  bboxOfRing,
  multiIndexStatisticsForItem,
  ndviStatisticsForItem,
  ringToGeoJsonFeature,
  searchSentinel2Scenes,
  sentinel2,
} from "./mpcClient.mjs";

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SENTINEL_INGEST_CONCURRENCY || 2)));
const PER_FIELD_TIMEOUT_MS = Math.max(30_000, Number(process.env.SENTINEL_INGEST_TIMEOUT_MS || 180_000));
const PER_SCENE_DELAY_MS = Math.max(0, Number(process.env.SENTINEL_PER_SCENE_DELAY_MS || 150));

const DEFAULT_LOOKBACK_DAYS = Math.max(30, Number(process.env.SENTINEL_LOOKBACK_DAYS || 365));
const DEFAULT_MAX_CLOUD = Math.max(
  10,
  Math.min(100, Number(process.env.SENTINEL_MAX_CLOUD_COVER || 60))
);
const DEFAULT_LIMIT = Math.max(10, Math.min(200, Number(process.env.SENTINEL_SCENE_LIMIT || 80)));

const queue = new Map(); // fieldId -> job
const inflight = new Set(); // fieldId
const recentlyCompleted = new Map(); // fieldId -> completedAtMs
const RECENT_COOLDOWN_MS = 10 * 60_000; // skip re-enqueue within 10 min of completion
let activeWorkers = 0;

/**
 * Compute the ISO week-of-year (1..53) for a Date in UTC. Standard
 * Monday-start, ISO-8601 (the algorithm used by date-fns and others).
 */
function isoWeekOfYear(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday in current week decides the year.
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86_400_000 -
        3 +
        ((week1.getUTCDay() + 6) % 7)) /
        7
    );
  return { week, year: d.getUTCFullYear() };
}

async function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function fetchExistingItemIds(fieldId) {
  const admin = adminClient();
  if (!admin) return new Set();
  const { data, error } = await admin
    .from("tilth_field_ndvi")
    .select("item_id, status")
    .eq("field_id", fieldId);
  if (error) {
    console.warn(
      `[sentinel-ingest] could not list existing rows for field ${fieldId}: ${error.message}`
    );
    return new Set();
  }
  // Skip items we've successfully cached. We DO retry failures and
  // 'no-data' rows because cloud cover may have improved by re-running
  // titiler — and 'pending' rows are hangovers from a crashed worker
  // that we should re-process.
  const out = new Set();
  for (const row of data || []) {
    if (row.status === "ok") out.add(row.item_id);
  }
  return out;
}

async function upsertScenePending({ fieldId, itemId, sceneDatetime, sceneCloudPct }) {
  const admin = adminClient();
  if (!admin) return;
  const { week, year } = isoWeekOfYear(new Date(sceneDatetime));
  await admin.from("tilth_field_ndvi").upsert(
    {
      field_id: fieldId,
      item_id: itemId,
      collection: sentinel2.collection,
      scene_datetime: new Date(sceneDatetime).toISOString(),
      scene_week: week,
      scene_year: year,
      scene_cloud_pct: sceneCloudPct ?? null,
      status: "pending",
      error_message: null,
    },
    { onConflict: "field_id,item_id" }
  );
}

async function upsertSceneResult({
  fieldId,
  itemId,
  sceneDatetime,
  sceneCloudPct,
  status,
  stats,
  extraIndices,
  errorMessage,
}) {
  const admin = adminClient();
  if (!admin) return;
  const { week, year } = isoWeekOfYear(new Date(sceneDatetime));
  const payload = {
    field_id: fieldId,
    item_id: itemId,
    collection: sentinel2.collection,
    scene_datetime: new Date(sceneDatetime).toISOString(),
    scene_week: week,
    scene_year: year,
    scene_cloud_pct: sceneCloudPct ?? null,
    status,
    error_message: errorMessage || null,
    ndvi_mean: stats?.mean ?? null,
    ndvi_min: stats?.min ?? null,
    ndvi_max: stats?.max ?? null,
    ndvi_median: stats?.median ?? null,
    ndvi_stddev: stats?.stddev ?? null,
    valid_pixel_count: stats?.valid_count ?? null,
    total_pixel_count: stats?.total_count ?? null,
    field_cloud_pct:
      stats?.valid_pct != null ? Math.max(0, Math.min(100, 100 - stats.valid_pct)) : null,
    ...(extraIndices || {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin
    .from("tilth_field_ndvi")
    .upsert(payload, { onConflict: "field_id,item_id" });
  if (error) {
    console.warn(
      `[sentinel-ingest] supabase upsert failed for ${fieldId}:${itemId}: ${error.message}`
    );
  }
}

/**
 * Run one ingest job: list scenes, compute stats per scene, upsert rows.
 * Awaits all scene work serially within the job so we don't burst MPC
 * with N parallel `/statistics` calls per field — workers across fields
 * provide enough parallelism via CONCURRENCY.
 */
async function runJob(job) {
  const { fieldId, field, lookbackDays, maxCloudCover, sceneLimit, force } = job;
  const bbox = bboxOfRing(field.boundary);
  if (!bbox) {
    console.warn(`[sentinel-ingest] field ${fieldId} has no valid bbox; skipping`);
    return { searched: 0, ingested: 0, skipped: 0, errors: 0 };
  }
  const feature = ringToGeoJsonFeature(field.boundary, {
    field_id: fieldId,
    field_name: field.name || "",
  });
  if (!feature) {
    console.warn(`[sentinel-ingest] field ${fieldId} could not be converted to GeoJSON`);
    return { searched: 0, ingested: 0, skipped: 0, errors: 0 };
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - Math.round(lookbackDays * 86_400_000));

  let scenes = [];
  try {
    scenes = await searchSentinel2Scenes({
      bbox,
      startDate,
      endDate,
      maxCloudCover,
      limit: sceneLimit,
    });
  } catch (e) {
    console.warn(`[sentinel-ingest] STAC search failed for field ${fieldId}: ${e?.message || e}`);
    return { searched: 0, ingested: 0, skipped: 0, errors: 1 };
  }

  const existing = force ? new Set() : await fetchExistingItemIds(fieldId);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  for (const item of scenes) {
    const itemId = item?.id || item?.properties?.id;
    if (!itemId) continue;
    const sceneDatetime = item?.properties?.datetime || item?.properties?.["datetime"];
    if (!sceneDatetime) continue;
    if (existing.has(itemId)) {
      skipped += 1;
      continue;
    }
    const sceneCloudPct = Number.isFinite(item?.properties?.["eo:cloud_cover"])
      ? item.properties["eo:cloud_cover"]
      : null;

    await upsertScenePending({
      fieldId,
      itemId,
      sceneDatetime,
      sceneCloudPct,
    });

    try {
      const multi = await multiIndexStatisticsForItem({
        collection: sentinel2.collection,
        itemId,
        feature,
      });
      const stats = multi?.ndvi ?? null;
      const extraIndices = multi
        ? {
            evi_mean: multi.evi?.mean ?? null,
            ndwi_mean: multi.ndwi?.mean ?? null,
            ndmi_mean: multi.ndmi?.mean ?? null,
            ndre_mean: multi.ndre?.mean ?? null,
            savi_mean: multi.savi?.mean ?? null,
            nbr_mean: multi.nbr?.mean ?? null,
          }
        : null;
      if (!stats || !Number.isFinite(stats.mean) || (stats.valid_count ?? 0) === 0) {
        await upsertSceneResult({
          fieldId,
          itemId,
          sceneDatetime,
          sceneCloudPct,
          status: "no-data",
          stats: stats || null,
          extraIndices,
          errorMessage: "no valid pixels (cloud / outside swath)",
        });
        skipped += 1;
      } else {
        await upsertSceneResult({
          fieldId,
          itemId,
          sceneDatetime,
          sceneCloudPct,
          status: "ok",
          stats,
          extraIndices,
        });
        ingested += 1;
      }
    } catch (e) {
      errors += 1;
      console.warn(
        `[sentinel-ingest] field ${fieldId} item ${itemId} stats failed: ${e?.message || e}`
      );
      await upsertSceneResult({
        fieldId,
        itemId,
        sceneDatetime,
        sceneCloudPct,
        status: "error",
        stats: null,
        errorMessage: String(e?.message || e).slice(0, 240),
      });
    }

    if (PER_SCENE_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PER_SCENE_DELAY_MS));
    }
  }

  return { searched: scenes.length, ingested, skipped, errors };
}

async function pump() {
  while (activeWorkers < CONCURRENCY && queue.size > 0) {
    let nextKey = null;
    for (const k of queue.keys()) {
      if (!inflight.has(k)) {
        nextKey = k;
        break;
      }
    }
    if (!nextKey) return;
    const job = queue.get(nextKey);
    queue.delete(nextKey);
    inflight.add(nextKey);
    activeWorkers += 1;
    withTimeout(runJob(job), PER_FIELD_TIMEOUT_MS, `sentinel ingest field ${nextKey}`)
      .then((summary) => {
        console.log(
          `[sentinel-ingest] field ${nextKey} done: searched=${summary.searched} ingested=${summary.ingested} skipped=${summary.skipped} errors=${summary.errors}`
        );
      })
      .catch((e) => {
        console.warn(`[sentinel-ingest] field ${nextKey} job crashed:`, e?.message || e);
      })
      .finally(() => {
        activeWorkers -= 1;
        inflight.delete(nextKey);
        recentlyCompleted.set(nextKey, Date.now());
        if (recentlyCompleted.size > 500) {
          const oldest = recentlyCompleted.keys().next().value;
          if (oldest) recentlyCompleted.delete(oldest);
        }
        setImmediate(pump);
      });
  }
}

/**
 * Enqueue an NDVI ingest for one field. Idempotent — duplicate enqueues
 * for the same field id collapse onto the existing job (most-recent
 * options win because they're more likely to reflect the user's intent).
 *
 * `field` must include `id`, `name`, `boundary` ([{lat,lng}, ...]).
 */
export function enqueueNdviIngest({
  fieldId,
  field,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  maxCloudCover = DEFAULT_MAX_CLOUD,
  sceneLimit = DEFAULT_LIMIT,
  force = false,
} = {}) {
  if (!fieldId || !field) return false;
  if (!force && !inflight.has(fieldId)) {
    const doneAt = recentlyCompleted.get(fieldId);
    if (doneAt && Date.now() - doneAt < RECENT_COOLDOWN_MS) return false;
  }
  const existing = queue.get(fieldId);
  const job = {
    fieldId,
    field,
    lookbackDays: Math.max(7, Math.min(1825, Math.round(lookbackDays))),
    maxCloudCover: Math.max(0, Math.min(100, Math.round(maxCloudCover))),
    sceneLimit: Math.max(1, Math.min(500, Math.round(sceneLimit))),
    force: Boolean(force) || Boolean(existing?.force),
  };
  queue.set(fieldId, job);
  setImmediate(pump);
  return !inflight.has(fieldId);
}

export function ingestQueueStatus() {
  return {
    queued: queue.size,
    inflight: inflight.size,
    workers: activeWorkers,
    concurrency: CONCURRENCY,
    defaults: {
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      maxCloudCover: DEFAULT_MAX_CLOUD,
      sceneLimit: DEFAULT_LIMIT,
    },
  };
}

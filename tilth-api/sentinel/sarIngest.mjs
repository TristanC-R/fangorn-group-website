/**
 * Sentinel-1 RTC SAR ingest queue.
 *
 * Direct sibling of `ingest.mjs` (Sentinel-2 NDVI) but rewritten for
 * SAR's two-band (VV + VH) radar product. Same shape — bounded
 * worker pool, idempotent enqueue, per-field timeout — so the two
 * pipelines can run side-by-side without contending for state.
 *
 * Pipeline per job:
 *   1. STAC search for sentinel-1-rtc items intersecting the field
 *      bbox between start..end (no cloud filter — SAR sees through
 *      cloud, that's the point).
 *   2. Skip items already cached `ok` in `tilth_field_sar`.
 *   3. POST the field polygon to titiler `/item/statistics` with
 *      assets=vv,vh and read VV + VH backscatter stats.
 *   4. Upsert into `tilth_field_sar` with status=ok|no-data|error.
 *
 * The frontend will subscribe to Realtime on `tilth_field_sar` once
 * the workspace UI lands. For now this scaffolding lets us start
 * building the scene cache via the API.
 */

import { adminClient } from "../supabaseAdmin.mjs";

import {
  bboxOfRing,
  ringToGeoJsonFeature,
  searchSentinel1Scenes,
  sarStatisticsForItem,
  sentinel1,
} from "./sarClient.mjs";

const CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.SAR_INGEST_CONCURRENCY || 2))
);
const PER_FIELD_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.SAR_INGEST_TIMEOUT_MS || 180_000)
);
const PER_SCENE_DELAY_MS = Math.max(
  0,
  Number(process.env.SAR_PER_SCENE_DELAY_MS || 150)
);

const DEFAULT_LOOKBACK_DAYS = Math.max(
  30,
  Number(process.env.SAR_LOOKBACK_DAYS || 365)
);
const DEFAULT_LIMIT = Math.max(
  10,
  Math.min(200, Number(process.env.SAR_SCENE_LIMIT || 80))
);

const queue = new Map();
const inflight = new Set();
const recentlyCompleted = new Map();
const RECENT_COOLDOWN_MS = 10 * 60_000;
let activeWorkers = 0;

function isoWeekOfYear(date) {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
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
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
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
    .from("tilth_field_sar")
    .select("item_id, status")
    .eq("field_id", fieldId);
  if (error) {
    console.warn(
      `[sar-ingest] could not list existing rows for field ${fieldId}: ${error.message}`
    );
    return new Set();
  }
  const out = new Set();
  for (const row of data || []) {
    if (row.status === "ok") out.add(row.item_id);
  }
  return out;
}

async function clearFieldRows(fieldId) {
  const admin = adminClient();
  if (!admin) return;
  const { error } = await admin
    .from("tilth_field_sar")
    .delete()
    .eq("field_id", fieldId);
  if (error) {
    console.warn(
      `[sar-ingest] could not clear existing rows for field ${fieldId}: ${error.message}`
    );
  }
}

async function upsertScenePending({
  fieldId,
  itemId,
  sceneDatetime,
  orbitState,
  relativeOrbit,
}) {
  const admin = adminClient();
  if (!admin) return;
  const { week, year } = isoWeekOfYear(new Date(sceneDatetime));
  await admin.from("tilth_field_sar").upsert(
    {
      field_id: fieldId,
      item_id: itemId,
      collection: sentinel1.collection,
      scene_datetime: new Date(sceneDatetime).toISOString(),
      scene_week: week,
      scene_year: year,
      orbit_state: orbitState ?? null,
      relative_orbit: relativeOrbit ?? null,
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
  orbitState,
  relativeOrbit,
  status,
  stats,
  errorMessage,
}) {
  const admin = adminClient();
  if (!admin) return;
  const { week, year } = isoWeekOfYear(new Date(sceneDatetime));
  const payload = {
    field_id: fieldId,
    item_id: itemId,
    collection: sentinel1.collection,
    scene_datetime: new Date(sceneDatetime).toISOString(),
    scene_week: week,
    scene_year: year,
    orbit_state: orbitState ?? null,
    relative_orbit: relativeOrbit ?? null,
    status,
    error_message: errorMessage || null,
    vv_mean: stats?.vv?.mean ?? null,
    vv_mean_db: stats?.vv?.mean_db ?? null,
    vv_median: stats?.vv?.median ?? null,
    vv_stddev: stats?.vv?.stddev ?? null,
    vh_mean: stats?.vh?.mean ?? null,
    vh_mean_db: stats?.vh?.mean_db ?? null,
    vh_median: stats?.vh?.median ?? null,
    vh_stddev: stats?.vh?.stddev ?? null,
    vh_vv_ratio_mean: stats?.vh_vv_ratio_mean ?? null,
    vh_vv_ratio_mean_db: stats?.vh_vv_ratio_mean_db ?? null,
    valid_pixel_count: stats?.vh?.valid_count ?? stats?.vv?.valid_count ?? null,
    total_pixel_count: stats?.vh?.total_count ?? stats?.vv?.total_count ?? null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin
    .from("tilth_field_sar")
    .upsert(payload, { onConflict: "field_id,item_id" });
  if (error) {
    console.warn(
      `[sar-ingest] supabase upsert failed for ${fieldId}:${itemId}: ${error.message}`
    );
  }
}

async function runJob(job) {
  const { fieldId, field, lookbackDays, sceneLimit, force } = job;
  const bbox = bboxOfRing(field.boundary);
  if (!bbox) {
    console.warn(`[sar-ingest] field ${fieldId} has no valid bbox; skipping`);
    return { searched: 0, ingested: 0, skipped: 0, errors: 0 };
  }
  const feature = ringToGeoJsonFeature(field.boundary, {
    field_id: fieldId,
    field_name: field.name || "",
  });
  if (!feature) {
    console.warn(
      `[sar-ingest] field ${fieldId} could not be converted to GeoJSON`
    );
    return { searched: 0, ingested: 0, skipped: 0, errors: 0 };
  }

  if (force) {
    await clearFieldRows(fieldId);
  }

  const endDate = new Date();
  const startDate = new Date(
    endDate.getTime() - Math.round(lookbackDays * 86_400_000)
  );

  let scenes = [];
  try {
    scenes = await searchSentinel1Scenes({
      bbox,
      startDate,
      endDate,
      limit: sceneLimit,
    });
  } catch (e) {
    console.warn(
      `[sar-ingest] STAC search failed for field ${fieldId}: ${e?.message || e}`
    );
    return { searched: 0, ingested: 0, skipped: 0, errors: 1 };
  }

  const existing = force ? new Set() : await fetchExistingItemIds(fieldId);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  for (const item of scenes) {
    const itemId = item?.id || item?.properties?.id;
    if (!itemId) continue;
    const sceneDatetime =
      item?.properties?.datetime || item?.properties?.["datetime"];
    if (!sceneDatetime) continue;
    if (existing.has(itemId)) {
      skipped += 1;
      continue;
    }
    const orbitState = item?.properties?.["sat:orbit_state"] || null;
    const relativeOrbit = Number.isFinite(
      item?.properties?.["sat:relative_orbit"]
    )
      ? item.properties["sat:relative_orbit"]
      : null;

    await upsertScenePending({
      fieldId,
      itemId,
      sceneDatetime,
      orbitState,
      relativeOrbit,
    });

    try {
      const stats = await sarStatisticsForItem({
        collection: sentinel1.collection,
        itemId,
        feature,
      });
      const validCount =
        stats?.vh?.valid_count ?? stats?.vv?.valid_count ?? 0;
      if (!stats || validCount === 0) {
        await upsertSceneResult({
          fieldId,
          itemId,
          sceneDatetime,
          orbitState,
          relativeOrbit,
          status: "no-data",
          stats: stats || null,
          errorMessage: "no valid pixels (outside swath)",
        });
        skipped += 1;
      } else {
        await upsertSceneResult({
          fieldId,
          itemId,
          sceneDatetime,
          orbitState,
          relativeOrbit,
          status: "ok",
          stats,
        });
        ingested += 1;
      }
    } catch (e) {
      errors += 1;
      console.warn(
        `[sar-ingest] field ${fieldId} item ${itemId} stats failed: ${e?.message || e}`
      );
      await upsertSceneResult({
        fieldId,
        itemId,
        sceneDatetime,
        orbitState,
        relativeOrbit,
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
    withTimeout(
      runJob(job),
      PER_FIELD_TIMEOUT_MS,
      `sar ingest field ${nextKey}`
    )
      .then((summary) => {
        console.log(
          `[sar-ingest] field ${nextKey} done: searched=${summary.searched} ingested=${summary.ingested} skipped=${summary.skipped} errors=${summary.errors}`
        );
      })
      .catch((e) => {
        console.warn(
          `[sar-ingest] field ${nextKey} job crashed:`,
          e?.message || e
        );
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
 * Enqueue a SAR ingest for one field. Idempotent — duplicate enqueues
 * for the same field id collapse onto the existing job (force always
 * wins between a queued non-force and a new force=true).
 *
 * `field` must include `id`, `name`, `boundary` ([{lat,lng}, ...]).
 */
export function enqueueSarIngest({
  fieldId,
  field,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
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
    sceneLimit: Math.max(1, Math.min(500, Math.round(sceneLimit))),
    force: Boolean(force) || Boolean(existing?.force),
  };
  queue.set(fieldId, job);
  setImmediate(pump);
  return !inflight.has(fieldId);
}

export function sarQueueStatus() {
  return {
    queued: queue.size,
    inflight: inflight.size,
    workers: activeWorkers,
    concurrency: CONCURRENCY,
    defaults: {
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      sceneLimit: DEFAULT_LIMIT,
    },
  };
}

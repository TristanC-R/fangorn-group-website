/**
 * Elevation ingest — Copernicus DEM 30 m.
 *
 * Unlike NDVI/SAR, elevation is static (one result per field, not a
 * time series). The queue processes one field at a time: search DEM
 * tiles, crop, compute stats + slope/aspect/TWI, upsert into
 * `tilth_field_elevation`.
 *
 * Idempotent — if a field already has a row with `status='ok'` and
 * `force` is false, the job is skipped.
 */

import { adminClient } from "../supabaseAdmin.mjs";
import { elevationForField } from "./elevationClient.mjs";

const CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.ELEV_INGEST_CONCURRENCY || 2))
);
const PER_FIELD_TIMEOUT_MS = Math.max(
  15_000,
  Number(process.env.ELEV_INGEST_TIMEOUT_MS || 90_000)
);

const queue = new Map();
const inflight = new Set();
let activeWorkers = 0;

async function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function fieldAlreadyOk(fieldId) {
  const admin = adminClient();
  if (!admin) return false;
  const { data, error } = await admin
    .from("tilth_field_elevation")
    .select("status")
    .eq("field_id", fieldId)
    .maybeSingle();
  if (error) return false;
  return data?.status === "ok";
}

async function upsertElevation(fieldId, payload) {
  const admin = adminClient();
  if (!admin) return;
  const { error } = await admin
    .from("tilth_field_elevation")
    .upsert(
      { field_id: fieldId, ...payload, updated_at: new Date().toISOString() },
      { onConflict: "field_id" }
    );
  if (error) {
    console.warn(
      `[elev-ingest] supabase upsert failed for ${fieldId}: ${error.message}`
    );
  }
}

async function runJob(job) {
  const { fieldId, field, force } = job;

  if (!force) {
    const ok = await fieldAlreadyOk(fieldId);
    if (ok) {
      console.log(`[elev-ingest] field ${fieldId} already has elevation data; skipping`);
      return { status: "skipped" };
    }
  }

  await upsertElevation(fieldId, { status: "pending", error_message: null });

  try {
    const result = await elevationForField({
      ring: field.boundary,
      fieldId,
      fieldName: field.name || "",
    });

    await upsertElevation(fieldId, {
      item_id: result.itemId || "",
      collection: result.collection || "cop-dem-glo-30",
      elevation_mean: result.elevation?.mean ?? null,
      elevation_min: result.elevation?.min ?? null,
      elevation_max: result.elevation?.max ?? null,
      elevation_range: result.elevation?.range ?? null,
      elevation_stddev: result.elevation?.stddev ?? null,
      elevation_median: result.elevation?.median ?? null,
      slope_mean_deg: result.slope?.mean_deg ?? null,
      slope_max_deg: result.slope?.max_deg ?? null,
      slope_stddev_deg: result.slope?.stddev_deg ?? null,
      aspect_mean_deg: result.aspect?.mean_deg ?? null,
      aspect_dominant: result.aspect?.dominant ?? null,
      twi_mean: result.twi?.mean ?? null,
      twi_min: result.twi?.min ?? null,
      twi_max: result.twi?.max ?? null,
      valid_pixel_count: result.valid_pixel_count ?? null,
      total_pixel_count: result.total_pixel_count ?? null,
      resolution_m: 30,
      status: "ok",
      error_message: null,
    });

    return { status: "ok", itemId: result.itemId };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 240);
    console.warn(`[elev-ingest] field ${fieldId} failed: ${msg}`);
    await upsertElevation(fieldId, { status: "error", error_message: msg });
    return { status: "error", error: msg };
  }
}

async function pump() {
  while (activeWorkers < CONCURRENCY && queue.size > 0) {
    let nextKey = null;
    for (const k of queue.keys()) {
      if (!inflight.has(k)) { nextKey = k; break; }
    }
    if (!nextKey) return;
    const job = queue.get(nextKey);
    queue.delete(nextKey);
    inflight.add(nextKey);
    activeWorkers += 1;
    withTimeout(
      runJob(job),
      PER_FIELD_TIMEOUT_MS,
      `elevation ingest field ${nextKey}`
    )
      .then((result) => {
        console.log(
          `[elev-ingest] field ${nextKey} done: ${result.status}${result.itemId ? ` (${result.itemId})` : ""}`
        );
      })
      .catch((e) => {
        console.warn(
          `[elev-ingest] field ${nextKey} job crashed:`,
          e?.message || e
        );
      })
      .finally(() => {
        activeWorkers -= 1;
        inflight.delete(nextKey);
        setImmediate(pump);
      });
  }
}

/**
 * Enqueue an elevation extraction for one field.
 * `field` must include `boundary` ([{lat,lng}, ...]).
 */
export function enqueueElevationIngest({ fieldId, field, force = false } = {}) {
  if (!fieldId || !field) return false;
  if (
    !Array.isArray(field.boundary) ||
    field.boundary.length < 3
  )
    return false;

  const existing = queue.get(fieldId);
  const job = {
    fieldId,
    field,
    force: Boolean(force) || Boolean(existing?.force),
  };
  queue.set(fieldId, job);
  setImmediate(pump);
  return !inflight.has(fieldId);
}

export function elevationQueueStatus() {
  return {
    queued: queue.size,
    inflight: inflight.size,
    workers: activeWorkers,
    concurrency: CONCURRENCY,
  };
}

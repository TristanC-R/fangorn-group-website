/**
 * Periodic refresh sweep for Sentinel-2 NDVI and Sentinel-1 SAR.
 *
 * Why: farmers shouldn't have to click anything. Without this, ingestion
 * only happens when a field is created/edited or someone hits "Refresh"
 * in the workspace. Most farmers will never touch those buttons; they'll
 * open the app at 6am once a week and expect the data to already be
 * waiting.
 *
 * Behaviour
 * ---------
 * - On boot, after a small warmup delay, runs one immediate sweep so
 *   the very first time the server comes up after a deploy, all fields
 *   get checked.
 * - Then runs again every `REFRESH_SWEEP_HOURS` (default 24 hours).
 * - Each sweep walks every field with a polygon, asks the database
 *   for the most recent cached scene per source (NDVI, SAR), and
 *   enqueues a refresh when that scene is older than the source's
 *   freshness threshold:
 *     - NDVI: 4 days (Sentinel-2 revisit ≈ 5 days at the equator,
 *       2-3 days in the UK with combined A+B).
 *     - SAR:  7 days (Sentinel-1 revisit was ~6 days with A+B,
 *       now ~12 days post-1B failure; 7 days strikes a good balance).
 * - Existing per-source ingest queues already de-dupe by field id and
 *   apply concurrency limits, so this just enqueues fire-and-forget.
 * - Sweep is bounded by `MAX_FIELDS_PER_SWEEP` so a 5,000-field farm
 *   can't pin the queue. Remaining fields get picked up next sweep.
 *
 * Tunables (env)
 * --------------
 *   REFRESH_SWEEP_HOURS         — interval between sweeps (default 24)
 *   REFRESH_BOOT_DELAY_MS       — wait before first sweep (default 30s)
 *   REFRESH_NDVI_STALE_DAYS     — NDVI freshness window (default 7)
 *   REFRESH_SAR_STALE_DAYS      — SAR freshness window (default 7)
 *   REFRESH_MAX_FIELDS_PER_SWEEP — hard cap per sweep (default 200)
 *   REFRESH_DISABLED            — set "1" to disable scheduler entirely
 */

import { adminClient, isConfigured as supabaseConfigured } from "../supabaseAdmin.mjs";
import { enqueueNdviIngest } from "./ingest.mjs";
import { enqueueSarIngest } from "./sarIngest.mjs";

const HOURS = Math.max(1, Number(process.env.REFRESH_SWEEP_HOURS || 24));
const BOOT_DELAY_MS = Math.max(0, Number(process.env.REFRESH_BOOT_DELAY_MS || 30_000));
const NDVI_STALE_MS =
  Math.max(1, Number(process.env.REFRESH_NDVI_STALE_DAYS || 7)) * 86_400_000;
const SAR_STALE_MS =
  Math.max(1, Number(process.env.REFRESH_SAR_STALE_DAYS || 7)) * 86_400_000;
const MAX_FIELDS_PER_SWEEP = Math.max(
  1,
  Number(process.env.REFRESH_MAX_FIELDS_PER_SWEEP || 200)
);
const DISABLED = process.env.REFRESH_DISABLED === "1";

// Stats for the /api/sentinel/scheduler/status endpoint. Keep it cheap
// so it can be polled without hitting the database.
const stats = {
  enabled: !DISABLED,
  intervalHours: HOURS,
  ndviStaleDays: NDVI_STALE_MS / 86_400_000,
  sarStaleDays: SAR_STALE_MS / 86_400_000,
  lastRunAt: null,
  lastRunMs: 0,
  lastResult: null, // { fieldsChecked, ndviEnqueued, sarEnqueued, errors }
  inflight: false,
  nextRunAt: null,
  totalSweeps: 0,
};

let timer = null;

/**
 * Run one sweep. Idempotent if called manually — the inflight flag
 * makes overlapping sweeps no-op.
 */
export async function runRefreshSweep({ trigger = "scheduled" } = {}) {
  if (DISABLED) return { ok: false, reason: "disabled" };
  if (stats.inflight) return { ok: false, reason: "already-running" };
  if (!supabaseConfigured) return { ok: false, reason: "no-supabase" };
  const admin = adminClient();
  if (!admin) return { ok: false, reason: "no-admin-client" };

  stats.inflight = true;
  const t0 = Date.now();
  let fieldsChecked = 0;
  let ndviEnqueued = 0;
  let sarEnqueued = 0;
  const errors = [];

  try {
    // List every mapped field. RLS is bypassed by the service role
    // client, which is correct here — this is a system process, not
    // a user-authenticated read.
    const { data: fields, error } = await admin
      .from("tilth_fields")
      .select("id, name, boundary, farm_id")
      .not("boundary", "is", null)
      .order("updated_at", { ascending: false })
      .limit(MAX_FIELDS_PER_SWEEP);

    if (error) {
      errors.push(`list fields: ${error.message}`);
      return { ok: false, reason: error.message };
    }

    const now = Date.now();
    for (const f of fields || []) {
      if (!f?.id) continue;
      if (!Array.isArray(f.boundary) || f.boundary.length < 3) continue;
      fieldsChecked += 1;

      // Latest NDVI scene_datetime per field. We deliberately don't
      // filter by status='ok' — a field with only pending/error rows
      // should still be retried so the user isn't stuck.
      try {
        const { data: ndviRows } = await admin
          .from("tilth_field_ndvi")
          .select("scene_datetime")
          .eq("field_id", f.id)
          .order("scene_datetime", { ascending: false })
          .limit(1);
        const lastNdvi = ndviRows?.[0]?.scene_datetime
          ? new Date(ndviRows[0].scene_datetime).getTime()
          : 0;
        if (!Number.isFinite(lastNdvi) || now - lastNdvi > NDVI_STALE_MS) {
          if (enqueueNdviIngest({ fieldId: f.id, field: f })) ndviEnqueued += 1;
        }
      } catch (e) {
        errors.push(`ndvi ${f.id}: ${e?.message || e}`);
      }

      // Latest SAR scene_datetime per field.
      try {
        const { data: sarRows } = await admin
          .from("tilth_field_sar")
          .select("scene_datetime")
          .eq("field_id", f.id)
          .order("scene_datetime", { ascending: false })
          .limit(1);
        const lastSar = sarRows?.[0]?.scene_datetime
          ? new Date(sarRows[0].scene_datetime).getTime()
          : 0;
        if (!Number.isFinite(lastSar) || now - lastSar > SAR_STALE_MS) {
          if (enqueueSarIngest({ fieldId: f.id, field: f })) sarEnqueued += 1;
        }
      } catch (e) {
        errors.push(`sar ${f.id}: ${e?.message || e}`);
      }
    }
  } finally {
    const elapsed = Date.now() - t0;
    stats.inflight = false;
    stats.lastRunAt = new Date(t0).toISOString();
    stats.lastRunMs = elapsed;
    stats.totalSweeps += 1;
    stats.lastResult = {
      trigger,
      fieldsChecked,
      ndviEnqueued,
      sarEnqueued,
      errors: errors.slice(0, 10),
    };
    stats.nextRunAt = new Date(Date.now() + HOURS * 3_600_000).toISOString();
    console.log(
      `[refreshScheduler] ${trigger} sweep done in ${elapsed}ms: ` +
        `${fieldsChecked} fields, ${ndviEnqueued} NDVI / ${sarEnqueued} SAR enqueued` +
        (errors.length ? `, ${errors.length} errors` : "")
    );
  }
  return { ok: true, ...stats.lastResult };
}

/**
 * Start the scheduler. Idempotent — calling twice does nothing the
 * second time. Returns true if a new schedule was installed.
 */
export function startRefreshScheduler() {
  if (DISABLED) {
    console.log("[refreshScheduler] disabled via REFRESH_DISABLED=1");
    return false;
  }
  if (timer) return false;
  console.log(
    `[refreshScheduler] enabled — first sweep in ${BOOT_DELAY_MS}ms, ` +
      `then every ${HOURS}h. Stale thresholds: NDVI ${NDVI_STALE_MS / 86_400_000}d, ` +
      `SAR ${SAR_STALE_MS / 86_400_000}d.`
  );
  // First sweep after a small warm-up so we don't pummel the queue
  // immediately on boot.
  setTimeout(() => {
    runRefreshSweep({ trigger: "boot" }).catch((e) =>
      console.warn("[refreshScheduler] boot sweep crashed:", e?.message || e)
    );
  }, BOOT_DELAY_MS);
  // Self-rescheduling interval. Using setInterval on top of the timer
  // (rather than chained setTimeout) is fine here — sweeps are bounded
  // and the inflight guard prevents overlap.
  timer = setInterval(
    () => {
      runRefreshSweep({ trigger: "scheduled" }).catch((e) =>
        console.warn(
          "[refreshScheduler] scheduled sweep crashed:",
          e?.message || e
        )
      );
    },
    HOURS * 3_600_000
  );
  stats.nextRunAt = new Date(Date.now() + BOOT_DELAY_MS).toISOString();
  return true;
}

export function refreshSchedulerStatus() {
  return { ...stats };
}

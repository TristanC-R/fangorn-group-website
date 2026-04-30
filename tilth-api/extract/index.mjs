/**
 * Background extraction queue.
 *
 * One in-memory work queue + worker pool runs alongside the HTTP server. The
 * queue is keyed by `${fieldId}:${layerId}` so duplicate enqueues collapse —
 * if a field is saved twice in quick succession we don't run extraction
 * twice.
 *
 * Workers:
 *   - upsert a row into `tilth_field_layer_data` with status='pending' as
 *     soon as work is dequeued, so the frontend's Realtime subscription
 *     immediately shows a spinner for that (field, layer);
 *   - run the strategy (WFS or arcgis_trace) bounded by a per-job timeout;
 *   - upsert the result with status='ok' | 'partial' | 'error' and the
 *     `upstream_version` stamp so we can skip identical re-runs later.
 *
 * Realtime updates flow naturally: every upsert publishes a change event
 * because the table is in the `supabase_realtime` publication (see
 * supabase/schema.sql).
 */

import { adminClient } from "../supabaseAdmin.mjs";

import { configFor, upstreamVersionFor } from "./layers.mjs";
import { extractWfs } from "./wfsExtractor.mjs";
import { extractArcgisTrace } from "./rasterTrace.mjs";

const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.TILTH_EXTRACT_CONCURRENCY || 4)));
const PER_JOB_TIMEOUT_MS = Math.max(10_000, Number(process.env.TILTH_EXTRACT_JOB_TIMEOUT_MS || 60_000));

const queue = new Map(); // jobKey -> job
const inflight = new Set(); // jobKey
let activeWorkers = 0;

/**
 * Pluggable layer-context resolver. server.mjs wires this on startup so the
 * extractor can fetch the latest WMS_LAYERS def + cached legend without
 * importing server.mjs (which would create a cycle).
 */
let layerContextProvider = null;
export function setLayerContextProvider(fn) {
  layerContextProvider = fn;
}

function jobKey(fieldId, layerId) {
  return `${fieldId}:${layerId}`;
}

async function loadLayerContext(layerId) {
  if (!layerContextProvider) return { def: null, legend: null };
  return layerContextProvider(layerId);
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

async function upsertPending({ fieldId, layerId, strategy, upstreamVersion }) {
  const admin = adminClient();
  if (!admin) return;
  await admin
    .from("tilth_field_layer_data")
    .upsert(
      {
        field_id: fieldId,
        layer_id: layerId,
        strategy,
        status: "pending",
        upstream_version: upstreamVersion,
        error_message: null,
        feature_count: null,
      },
      { onConflict: "field_id,layer_id" }
    );
}

async function upsertResult({
  fieldId,
  layerId,
  strategy,
  status,
  features,
  bbox,
  upstreamVersion,
  errorMessage,
  count,
}) {
  const admin = adminClient();
  if (!admin) return;
  const { error } = await admin
    .from("tilth_field_layer_data")
    .upsert(
      {
        field_id: fieldId,
        layer_id: layerId,
        strategy,
        status,
        features: features || null,
        bbox: bbox || null,
        upstream_version: upstreamVersion || null,
        error_message: errorMessage || null,
        feature_count: count == null ? null : count,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "field_id,layer_id" }
    );
  if (error) {
    console.warn(
      `[tilth-extract] supabase upsert failed for ${fieldId}:${layerId}: ${error.message}`
    );
  }
}

async function runJob(job) {
  const { fieldId, layerId, field } = job;
  const cfg = configFor(layerId);
  const { def: layerDef, legend } = await loadLayerContext(layerId);
  if (!layerDef && cfg.strategy === "arcgis_trace") {
    await upsertResult({
      fieldId,
      layerId,
      strategy: cfg.strategy,
      status: "error",
      features: null,
      bbox: null,
      upstreamVersion: null,
      errorMessage: `unknown layer ${layerId}`,
      count: 0,
    });
    return;
  }
  const upstreamVersion = upstreamVersionFor(layerId, layerDef, cfg);
  await upsertPending({ fieldId, layerId, strategy: cfg.strategy, upstreamVersion });

  if (cfg.strategy === "unsupported") {
    await upsertResult({
      fieldId,
      layerId,
      strategy: "unsupported",
      status: "ok",
      features: { type: "FeatureCollection", features: [] },
      bbox: null,
      upstreamVersion,
      errorMessage: null,
      count: 0,
    });
    return;
  }

  let result;
  try {
    if (cfg.strategy === "wfs") {
      result = await withTimeout(
        extractWfs({ layerDef, extractCfg: cfg, field }),
        PER_JOB_TIMEOUT_MS,
        `extractWfs(${layerId})`
      );
    } else if (cfg.strategy === "arcgis_trace") {
      result = await withTimeout(
        extractArcgisTrace({ layerDef, layerLegend: legend, field }),
        PER_JOB_TIMEOUT_MS,
        `extractArcgisTrace(${layerId})`
      );
    } else {
      result = { status: "error", error: `unknown strategy ${cfg.strategy}`, features: null, count: 0 };
    }
  } catch (e) {
    result = { status: "error", error: String(e?.message || e), features: null, count: 0 };
  }

  // Compute bbox from the extracted features (if any) so the frontend can
  // do quick "is this row even visible?" checks without parsing GeoJSON.
  let bbox = null;
  if (result?.features?.features?.length) {
    bbox = bboxOfFeatureCollection(result.features);
  }
  await upsertResult({
    fieldId,
    layerId,
    strategy: cfg.strategy,
    status: result.status === "error" ? "error" : result.status === "partial" ? "partial" : "ok",
    features: result.features,
    bbox,
    upstreamVersion,
    errorMessage: result.status === "error" ? String(result.error || "extraction failed") : null,
    count: result.count ?? (result.features?.features?.length || 0),
  });
}

function bboxOfFeatureCollection(fc) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      const [x, y] = coords;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      return;
    }
    for (const c of coords) visit(c);
  };
  for (const f of fc.features || []) {
    if (!f?.geometry?.coordinates) continue;
    visit(f.geometry.coordinates);
  }
  if (!Number.isFinite(minx)) return null;
  return [minx, miny, maxx, maxy];
}

async function pump() {
  while (activeWorkers < CONCURRENCY && queue.size > 0) {
    // Drain in insertion order: fetch the oldest job that isn't already
    // running. (We don't lock on insertion order strictly, but in practice
    // the user-facing flow always batches by field so this works fine.)
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
    activeWorkers++;
    runJob(job)
      .catch((e) => {
        console.warn(`[tilth-extract] job ${nextKey} crashed:`, e?.message || e);
      })
      .finally(() => {
        activeWorkers--;
        inflight.delete(nextKey);
        // Re-pump asynchronously so we don't blow the stack on bursts.
        setImmediate(pump);
      });
  }
}

/**
 * Enqueue extraction of ONE (field, layer). Idempotent: if the same job is
 * already queued or in-flight, the existing one wins.
 */
export function enqueueExtraction({ fieldId, layerId, field }) {
  const k = jobKey(fieldId, layerId);
  if (inflight.has(k) || queue.has(k)) return false;
  queue.set(k, { fieldId, layerId, field });
  setImmediate(pump);
  return true;
}

/**
 * Enqueue extraction for every layer id we know how to extract. `layerIds`
 * is an explicit allowlist so server.mjs (which owns the manifest) controls
 * what's in scope.
 */
export function enqueueExtractAll({ fieldId, field, layerIds }) {
  let queued = 0;
  for (const layerId of layerIds || []) {
    if (enqueueExtraction({ fieldId, layerId, field })) queued++;
  }
  return queued;
}

export function queueStatus() {
  return {
    queued: queue.size,
    inflight: inflight.size,
    workers: activeWorkers,
    concurrency: CONCURRENCY,
  };
}

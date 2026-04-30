/**
 * Sentinel-2 NDVI helpers (frontend).
 *
 * Three responsibilities:
 *
 *   1. Trigger an ingest pass on the Tilth API. The API queues work in
 *      the background and writes results to `tilth_field_ndvi` via the
 *      service role key. We POST and walk away — completion arrives via
 *      Supabase Realtime, not a response body.
 *
 *   2. Expose a small `useFieldNdviScenes` React hook that subscribes
 *      to `tilth_field_ndvi` for a set of field ids and surfaces:
 *
 *        Map<fieldId, Array<sceneRow>>  // newest scene first
 *
 *      with a status flag for the workspace's loading / error UI.
 *
 *   3. Build a tile URL for the per-scene NDVI raster overlay so the
 *      Satellite workspace can hand it straight to FieldMapThree2D's
 *      existing `mode: "tile"` overlay slot.
 */

import { useEffect, useMemo, useState } from "react";

import { supabase } from "./supabaseClient.js";
import { getTilthApiBase } from "./tilthApi.js";

async function getAuthHeader() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) return null;
  return `Bearer ${data.session.access_token}`;
}

/**
 * Kick off an NDVI ingest for one field. The Tilth API will:
 *   - STAC-search Sentinel-2 L2A scenes intersecting the field's bbox,
 *   - skip scenes already cached as `status='ok'`,
 *   - compute per-field NDVI stats via titiler `/item/statistics`,
 *   - upsert each row into `tilth_field_ndvi`.
 *
 * Returns `{ ok, queued, queue, error? }`.
 */
export async function triggerNdviRefresh(fieldId, options = {}) {
  const base = getTilthApiBase();
  if (!base) {
    const err = "tilth-api not reachable";
    console.warn(`[tilthSentinel] triggerNdviRefresh(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
  const auth = await getAuthHeader();
  if (!auth) {
    const err = "not signed in (no Supabase session)";
    console.warn(`[tilthSentinel] triggerNdviRefresh(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
  try {
    const res = await fetch(
      `${base}/api/fields/${encodeURIComponent(fieldId)}/ndvi/refresh`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lookbackDays: options.lookbackDays,
          maxCloudCover: options.maxCloudCover,
          sceneLimit: options.sceneLimit,
          // When true the backend deletes existing rows for this field
          // before re-running. Used after a methodology change (e.g.
          // turning on SCL cloud masking) to invalidate stale stats.
          force: Boolean(options.force),
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || `HTTP ${res.status}`;
      console.warn(`[tilthSentinel] triggerNdviRefresh(${fieldId}) — ${err}`);
      return { ok: false, error: err };
    }
    return { ok: true, ...data };
  } catch (e) {
    const err = String(e?.message || e);
    console.warn(`[tilthSentinel] triggerNdviRefresh(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
}

/**
 * Auto-refresh fields whose latest cached NDVI scene is older than
 * `staleDays` (or has no rows at all). Used by the Satellite workspace
 * on mount so farmers don't have to click anything — if the periodic
 * server sweep is up, this is mostly a no-op; if not (e.g. local dev
 * or the API process restarted), this is the safety net.
 *
 * `scenes` is the Map<fieldId, Array<row>> from `useFieldNdviScenes`.
 * Returns the number of refresh requests fired so the caller can
 * surface a one-line status if it wants to.
 */
const NDVI_AUTO_STALE_DAYS = 7;
const NDVI_COOLDOWN_KEY = "tilth:ndvi_auto_refresh_ts";

export async function autoRefreshStaleFields(
  fieldIds,
  scenesMap,
  { staleDays = NDVI_AUTO_STALE_DAYS } = {}
) {
  if (!Array.isArray(fieldIds) || !fieldIds.length) return 0;
  if (!(scenesMap instanceof Map)) return 0;

  try {
    const last = Number(localStorage.getItem(NDVI_COOLDOWN_KEY) || 0);
    if (Date.now() - last < staleDays * 86_400_000) return 0;
  } catch { /* private mode */ }

  const cutoff = Date.now() - staleDays * 86_400_000;
  let fired = 0;
  for (const id of fieldIds) {
    const arr = scenesMap.get(id) || [];
    const newest = arr.find(
      (r) =>
        r &&
        r.status === "ok" &&
        Number.isFinite(r.ndvi_mean) &&
        Number.isFinite(r.valid_pixel_count) &&
        r.valid_pixel_count > 0
    );
    const newestT = newest?.scene_datetime
      ? new Date(newest.scene_datetime).getTime()
      : 0;
    if (!Number.isFinite(newestT) || newestT < cutoff) {
      // Fire-and-forget. The hook's Realtime / poll loop surfaces
      // results when the queue catches up.
      triggerNdviRefresh(id).catch(() => {});
      fired += 1;
    }
  }
  if (fired > 0) {
    try { localStorage.setItem(NDVI_COOLDOWN_KEY, String(Date.now())); } catch { /* */ }
  }
  return fired;
}

/**
 * Poll the Tilth API's Sentinel queue status. Returns
 *   { queued, inflight, workers, concurrency } | null
 * Useful for surfacing "X fields ingesting" in the workspace header so
 * the user can tell whether the queue is doing background work
 * (typically left over from auto-triggers on field create/edit).
 */
export function useSentinelQueueStatus({ pollMs = 3000 } = {}) {
  const [queue, setQueue] = useState(null);
  useEffect(() => {
    const base = getTilthApiBase();
    if (!base) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${base}/api/sentinel/status`, {
          method: "GET",
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!alive) return;
        setQueue(body?.queue || null);
      } catch {
        /* swallow — transient network errors are fine here */
      }
    };
    tick();
    const id = setInterval(tick, Math.max(1000, pollMs));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);
  return queue;
}

/**
 * Build a slippy-tile URL template for NDVI rasters of one Sentinel-2
 * scene. Hands back a function `(z, x, y) => string` so it slots
 * directly into FieldMapThree2D's `overlays={[{ mode: 'tile', url }]}`
 * prop.
 */
export function buildNdviTileUrlFn({ itemId, collection = "sentinel-2-l2a", colormap, rescale } = {}) {
  if (!itemId) return null;
  const base = getTilthApiBase();
  if (!base) return null;
  return (z, x, y) => {
    const params = new URLSearchParams();
    params.set("collection", collection);
    if (colormap) params.set("colormap", colormap);
    if (rescale) params.set("rescale", rescale);
    return `${base}/api/sentinel/tiles/${encodeURIComponent(itemId)}/${z}/${x}/${y}.png?${params.toString()}`;
  };
}

/**
 * Subscribe to UPDATE/INSERT events on `tilth_field_ndvi` for the
 * provided field ids. Returns:
 *   {
 *     scenes: Map<fieldId, Array<row>>,  // newest scene first per field
 *     status: 'idle' | 'connecting' | 'ready' | 'error' | 'no-supabase',
 *     latest: Map<fieldId, row|null>,    // most recent OK scene per field
 *   }
 *
 * Initial state is fetched via a one-shot `select` so the UI doesn't
 * sit empty while Realtime catches up. A 5s polling fallback keeps the
 * workspace honest if the channel drops.
 */
export function useFieldNdviScenes(fieldIds) {
  // Build a normalised, sorted, comma-joined string key. The previous
  // version returned a fresh array reference and used `[ids, idsKey]`
  // as the effect dependency, which meant any parent re-render that
  // produced a new `fieldIds` reference (even with identical contents)
  // tore down the realtime subscription, cleared the scenes Map, and
  // re-fetched the snapshot from Supabase. That made every field-switch
  // feel like a full refetch. Keying the effect on the stable string
  // alone fixes that.
  const idsKey = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const id of fieldIds || []) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    out.sort();
    return out.join(",");
  }, [fieldIds]);

  const [state, setState] = useState({
    scenes: new Map(),
    latest: new Map(),
    status: "idle",
  });

  useEffect(() => {
    if (!supabase) {
      setState({ scenes: new Map(), latest: new Map(), status: "no-supabase" });
      return undefined;
    }
    const ids = idsKey ? idsKey.split(",") : [];
    if (!ids.length) {
      setState({ scenes: new Map(), latest: new Map(), status: "idle" });
      return undefined;
    }

    let alive = true;
    let snapshotLoaded = false;
    // Don't blow the existing scenes Map away on re-subscribe — only
    // signal that we're reconnecting. The snapshot select that follows
    // will reconcile any drift.
    setState((s) => ({ ...s, status: "connecting" }));

    const upsertOne = (row) => {
      if (!alive || !row || !row.field_id) return;
      setState((prev) => {
        const scenes = new Map(prev.scenes);
        const arr = (scenes.get(row.field_id) || []).filter((r) => r.item_id !== row.item_id);
        arr.push(row);
        arr.sort(
          (a, b) => new Date(b.scene_datetime).getTime() - new Date(a.scene_datetime).getTime()
        );
        scenes.set(row.field_id, arr);

        const latest = new Map(prev.latest);
        const newest = arr.find(
          (r) =>
            r.status === "ok" &&
            Number.isFinite(r.ndvi_mean) &&
            Number.isFinite(r.valid_pixel_count) &&
            r.valid_pixel_count > 0
        );
        latest.set(row.field_id, newest || null);

        return { ...prev, scenes, latest };
      });
    };

    const removeOne = (row) => {
      if (!alive || !row || !row.field_id) return;
      setState((prev) => {
        const scenes = new Map(prev.scenes);
        const arr = (scenes.get(row.field_id) || []).filter((r) => r.item_id !== row.item_id);
        if (arr.length === 0) scenes.delete(row.field_id);
        else scenes.set(row.field_id, arr);
        const latest = new Map(prev.latest);
        const newest = arr.find(
          (r) =>
            r.status === "ok" &&
            Number.isFinite(r.ndvi_mean) &&
            Number.isFinite(r.valid_pixel_count) &&
            r.valid_pixel_count > 0
        );
        latest.set(row.field_id, newest || null);
        return { ...prev, scenes, latest };
      });
    };

    // Reconcile a freshly-fetched batch of rows into existing state
    // without wiping anything. Each row is upserted by (field_id,
    // item_id); previous-state rows for ids not in the current set are
    // dropped (useful if the user removed a field).
    const reconcileFromRows = (rows) => {
      setState((prev) => {
        const idSet = new Set(ids);
        const scenes = new Map();
        // Carry over rows for ids still in scope, keyed by item_id so
        // we can overwrite individual rows from the snapshot.
        for (const [fieldId, arr] of prev.scenes) {
          if (idSet.has(fieldId)) scenes.set(fieldId, arr.slice());
        }
        const byKey = new Map();
        for (const [fieldId, arr] of scenes) {
          for (const row of arr) byKey.set(`${fieldId}|${row.item_id}`, row);
        }
        for (const row of rows || []) {
          if (!idSet.has(row.field_id)) continue;
          byKey.set(`${row.field_id}|${row.item_id}`, row);
        }
        // Rebuild Map from byKey, preserving sort order per field.
        scenes.clear();
        for (const row of byKey.values()) {
          const arr = scenes.get(row.field_id) || [];
          arr.push(row);
          scenes.set(row.field_id, arr);
        }
        const latest = new Map();
        for (const [fieldId, arr] of scenes) {
          arr.sort(
            (a, b) =>
              new Date(b.scene_datetime).getTime() -
              new Date(a.scene_datetime).getTime()
          );
          const newest = arr.find(
            (r) =>
              r.status === "ok" &&
              Number.isFinite(r.ndvi_mean) &&
              Number.isFinite(r.valid_pixel_count) &&
              r.valid_pixel_count > 0
          );
          latest.set(fieldId, newest || null);
        }
        return { scenes, latest, status: "ready" };
      });
    };

    (async () => {
      try {
        const { data, error } = await supabase
          .from("tilth_field_ndvi")
          .select("*")
          .in("field_id", ids)
          .order("scene_datetime", { ascending: false });
        if (!alive) return;
        if (error) {
          console.warn("[tilthSentinel] initial select failed:", error.message);
          setState((s) => ({ ...s, status: "error" }));
          return;
        }
        snapshotLoaded = true;
        reconcileFromRows(data);
      } catch (e) {
        if (!alive) return;
        console.warn("[tilthSentinel] initial select crashed:", e?.message || e);
        setState((s) => ({ ...s, status: "error" }));
      }
    })();

    let realtimeOk = false;
    const channel = supabase
      .channel(`tilth_field_ndvi:${idsKey}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tilth_field_ndvi",
          filter: `field_id=in.(${ids.join(",")})`,
        },
        (payload) => {
          if (!alive) return;
          if (payload.eventType === "DELETE") removeOne(payload.old);
          else upsertOne(payload.new);
        }
      )
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          realtimeOk = true;
          setState((s) => ({ ...s, status: "ready" }));
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          realtimeOk = false;
          console.warn(
            `[tilthSentinel] realtime channel ${status} (snapshotLoaded=${snapshotLoaded})`
          );
          if (!snapshotLoaded) setState((s) => ({ ...s, status: "error" }));
        }
      });

    // Polling is only a fallback. When realtime is healthy we don't
    // need to hammer Supabase every 5s — once a minute is plenty for
    // catching dropped events. When realtime hasn't connected we
    // poll faster (10s) so the user still sees data flowing.
    const poll = async () => {
      if (!alive) return;
      try {
        const { data, error } = await supabase
          .from("tilth_field_ndvi")
          .select("*")
          .in("field_id", ids)
          .order("scene_datetime", { ascending: false });
        if (!alive) return;
        if (error) {
          console.warn("[tilthSentinel] poll select failed:", error.message);
          return;
        }
        reconcileFromRows(data);
      } catch (e) {
        console.warn("[tilthSentinel] poll crashed:", e?.message || e);
      }
    };
    // Self-rescheduling poller: 60s when realtime is healthy, 10s
    // when it isn't. Re-evaluates the interval each tick so it speeds
    // up automatically if realtime drops mid-session.
    let pollTimer = null;
    const schedulePoll = () => {
      if (!alive) return;
      pollTimer = setTimeout(async () => {
        await poll();
        schedulePoll();
      }, realtimeOk ? 60_000 : 10_000);
    };
    schedulePoll();

    return () => {
      alive = false;
      if (pollTimer) clearTimeout(pollTimer);
      try {
        supabase.removeChannel(channel);
      } catch {
        /* best effort */
      }
    };
  }, [idsKey]);

  return state;
}

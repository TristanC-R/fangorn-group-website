/**
 * Sentinel-1 SAR helpers (frontend).
 *
 * Direct sibling of `tilthSentinel.js` (NDVI). Three responsibilities:
 *
 *   1. Trigger an ingest pass on the Tilth API. The API queues work in
 *      the background and writes results to `tilth_field_sar` via the
 *      service role key. We POST and walk away — completion arrives
 *      via Supabase Realtime, not a response body.
 *
 *   2. Expose a `useFieldSarScenes` React hook that subscribes to
 *      `tilth_field_sar` for a set of field ids and surfaces:
 *        Map<fieldId, Array<row>>     // newest scene first
 *        Map<fieldId, row | null>     // most recent OK scene
 *      with a status flag and the same self-rescheduling poll fallback
 *      as the NDVI hook.
 *
 *   3. Build a tile URL for SAR rasters keyed by polarisation band
 *      (`vh` | `vv` | `ratio`), so the workspace can drop it straight
 *      into FieldMapThree2D's `mode: "tile"` overlay slot.
 *
 * Backscatter values arrive in linear power; the workspace and the
 * dB mirrors stored alongside (`vh_mean_db`, `vv_mean_db`,
 * `vh_vv_ratio_mean_db`) are the values the operator actually reads.
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
 * Kick off a SAR ingest for one field. The Tilth API will:
 *   - STAC-search Sentinel-1 RTC scenes intersecting the field's bbox,
 *   - skip scenes already cached as `status='ok'`,
 *   - compute per-field VV / VH backscatter stats via titiler
 *     `/item/statistics`,
 *   - upsert each row into `tilth_field_sar`.
 *
 * Returns `{ ok, queued, queue, error? }`.
 */
export async function triggerSarRefresh(fieldId, options = {}) {
  const base = getTilthApiBase();
  if (!base) {
    const err = "tilth-api not reachable";
    console.warn(`[tilthSar] triggerSarRefresh(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
  const auth = await getAuthHeader();
  if (!auth) {
    const err = "not signed in (no Supabase session)";
    console.warn(`[tilthSar] triggerSarRefresh(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
  try {
    const res = await fetch(
      `${base}/api/fields/${encodeURIComponent(fieldId)}/sar/refresh`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lookbackDays: options.lookbackDays,
          sceneLimit: options.sceneLimit,
          force: Boolean(options.force),
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || `HTTP ${res.status}`;
      console.warn(`[tilthSar] triggerSarRefresh(${fieldId}) — ${err}`);
      return { ok: false, error: err };
    }
    return { ok: true, ...data };
  } catch (e) {
    const err = String(e?.message || e);
    console.warn(`[tilthSar] triggerSarRefresh(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
}

/**
 * Auto-refresh fields whose latest cached SAR scene is older than
 * `staleDays` days. Used by the Radar workspace on mount as a safety
 * net for the server-side periodic sweep. Returns the number of
 * refresh requests fired.
 */
const SAR_AUTO_STALE_DAYS = 7;
const SAR_COOLDOWN_KEY = "tilth:sar_auto_refresh_ts";

export async function autoRefreshStaleSarFields(
  fieldIds,
  scenesMap,
  { staleDays = SAR_AUTO_STALE_DAYS } = {}
) {
  if (!Array.isArray(fieldIds) || !fieldIds.length) return 0;
  if (!(scenesMap instanceof Map)) return 0;

  try {
    const last = Number(localStorage.getItem(SAR_COOLDOWN_KEY) || 0);
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
        (Number.isFinite(r.vh_mean) || Number.isFinite(r.vv_mean)) &&
        Number.isFinite(r.valid_pixel_count) &&
        r.valid_pixel_count > 0
    );
    const newestT = newest?.scene_datetime
      ? new Date(newest.scene_datetime).getTime()
      : 0;
    if (!Number.isFinite(newestT) || newestT < cutoff) {
      triggerSarRefresh(id).catch(() => {});
      fired += 1;
    }
  }
  if (fired > 0) {
    try { localStorage.setItem(SAR_COOLDOWN_KEY, String(Date.now())); } catch { /* */ }
  }
  return fired;
}

/**
 * Poll the Tilth API's SAR ingest queue. Returns
 *   { queued, inflight, workers, concurrency } | null
 */
export function useSarQueueStatus({ pollMs = 3000 } = {}) {
  const [queue, setQueue] = useState(null);
  useEffect(() => {
    const base = getTilthApiBase();
    if (!base) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const auth = await getAuthHeader();
        if (!auth) return;
        const res = await fetch(`${base}/api/sentinel1/status`, {
          method: "GET",
          headers: { Authorization: auth },
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!alive) return;
        setQueue(body?.queue || null);
      } catch {
        /* swallow transient errors */
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
 * Build a slippy-tile URL function for one Sentinel-1 RTC scene.
 * `band` chooses what's visualised:
 *   - "vh" (default) — VH backscatter in dB; viridis ramp.
 *   - "vv"           — VV backscatter in dB; magma ramp.
 *   - "ratio"        — VH/VV ratio in dB; viridis ramp (vegetation index).
 *
 * Returns `(z, x, y) => string` so it slots straight into
 * FieldMapThree2D's `overlays={[{ mode: 'tile', url }]}` prop.
 */
export function buildSarTileUrlFn({
  itemId,
  collection = "sentinel-1-rtc",
  band = "vh",
  rescale,
  colormap,
} = {}) {
  if (!itemId) return null;
  const base = getTilthApiBase();
  if (!base) return null;
  return (z, x, y) => {
    const params = new URLSearchParams();
    params.set("collection", collection);
    params.set("band", band);
    if (rescale) params.set("rescale", rescale);
    if (colormap) params.set("colormap", colormap);
    return `${base}/api/sentinel1/tiles/${encodeURIComponent(itemId)}/${z}/${x}/${y}.png?${params.toString()}`;
  };
}

/**
 * Subscribe to UPDATE/INSERT events on `tilth_field_sar` for the
 * provided field ids. Same shape as `useFieldNdviScenes` so the
 * workspace can plug it in identically. Returns:
 *   {
 *     scenes: Map<fieldId, Array<row>>,  // newest scene first per field
 *     latest: Map<fieldId, row|null>,    // most recent OK scene
 *     status: 'idle' | 'connecting' | 'ready' | 'error' | 'no-supabase',
 *   }
 *
 * Determines "OK" by `status === 'ok'` AND a finite VH or VV mean
 * AND `valid_pixel_count > 0`.
 */
export function useFieldSarScenes(fieldIds) {
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
    setState((s) => ({ ...s, status: "connecting" }));

    const isOk = (r) =>
      r &&
      r.status === "ok" &&
      (Number.isFinite(r.vh_mean) || Number.isFinite(r.vv_mean)) &&
      Number.isFinite(r.valid_pixel_count) &&
      r.valid_pixel_count > 0;

    const upsertOne = (row) => {
      if (!alive || !row || !row.field_id) return;
      setState((prev) => {
        const scenes = new Map(prev.scenes);
        const arr = (scenes.get(row.field_id) || []).filter(
          (r) => r.item_id !== row.item_id
        );
        arr.push(row);
        arr.sort(
          (a, b) =>
            new Date(b.scene_datetime).getTime() -
            new Date(a.scene_datetime).getTime()
        );
        scenes.set(row.field_id, arr);
        const latest = new Map(prev.latest);
        latest.set(row.field_id, arr.find(isOk) || null);
        return { ...prev, scenes, latest };
      });
    };

    const removeOne = (row) => {
      if (!alive || !row || !row.field_id) return;
      setState((prev) => {
        const scenes = new Map(prev.scenes);
        const arr = (scenes.get(row.field_id) || []).filter(
          (r) => r.item_id !== row.item_id
        );
        if (arr.length === 0) scenes.delete(row.field_id);
        else scenes.set(row.field_id, arr);
        const latest = new Map(prev.latest);
        latest.set(row.field_id, arr.find(isOk) || null);
        return { ...prev, scenes, latest };
      });
    };

    const reconcileFromRows = (rows) => {
      setState((prev) => {
        const idSet = new Set(ids);
        const scenes = new Map();
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
          latest.set(fieldId, arr.find(isOk) || null);
        }
        return { scenes, latest, status: "ready" };
      });
    };

    (async () => {
      try {
        const { data, error } = await supabase
          .from("tilth_field_sar")
          .select("*")
          .in("field_id", ids)
          .order("scene_datetime", { ascending: false });
        if (!alive) return;
        if (error) {
          console.warn("[tilthSar] initial select failed:", error.message);
          setState((s) => ({ ...s, status: "error" }));
          return;
        }
        snapshotLoaded = true;
        reconcileFromRows(data);
      } catch (e) {
        if (!alive) return;
        console.warn("[tilthSar] initial select crashed:", e?.message || e);
        setState((s) => ({ ...s, status: "error" }));
      }
    })();

    let realtimeOk = false;
    const channel = supabase
      .channel(`tilth_field_sar:${idsKey}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tilth_field_sar",
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
            `[tilthSar] realtime channel ${status} (snapshotLoaded=${snapshotLoaded})`
          );
          if (!snapshotLoaded) setState((s) => ({ ...s, status: "error" }));
        }
      });

    const poll = async () => {
      if (!alive) return;
      try {
        const { data, error } = await supabase
          .from("tilth_field_sar")
          .select("*")
          .in("field_id", ids)
          .order("scene_datetime", { ascending: false });
        if (!alive) return;
        if (error) {
          console.warn("[tilthSar] poll select failed:", error.message);
          return;
        }
        reconcileFromRows(data);
      } catch (e) {
        console.warn("[tilthSar] poll crashed:", e?.message || e);
      }
    };
    let pollTimer = null;
    const schedulePoll = () => {
      if (!alive) return;
      pollTimer = setTimeout(
        async () => {
          await poll();
          schedulePoll();
        },
        realtimeOk ? 60_000 : 10_000
      );
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

// Default tile rendering ranges (kept in lockstep with the backend
// `sarRender.bands`). Workspaces use these for the legend.
export const SAR_BAND_DEFAULTS = {
  vh: { rescale: "-25,-5", colormap: "viridis", label: "VH (vegetation)" },
  vv: { rescale: "-20,0", colormap: "magma", label: "VV (surface / soil)" },
  ratio: {
    rescale: "-15,-3",
    colormap: "viridis",
    label: "VH / VV (structure)",
  },
};

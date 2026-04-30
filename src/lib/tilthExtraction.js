/**
 * Per-field × per-layer extraction helpers (frontend).
 *
 * Two responsibilities:
 *   1. Trigger extraction on the Tilth API. The API queues work in the
 *      background and writes results to `tilth_field_layer_data` via the
 *      service role key. We only POST and walk away — completion arrives
 *      via Supabase Realtime, not a response body.
 *   2. Subscribe to Realtime UPDATE / INSERT events on
 *      `tilth_field_layer_data` for a given set of field ids and surface
 *      a Map<fieldId, Map<layerId, row>> via a small `useFieldLayerData`
 *      React hook so the SoilWorkspace can render straight from state.
 *
 * The extractor runs entirely server-side (PNG decode, marching-squares,
 * polygon simplify, turf intersect) — the client just consumes finished
 * GeoJSON FeatureCollections.
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

export async function triggerExtractAll(fieldId) {
  const base = getTilthApiBase();
  if (!base) {
    const err = "tilth-api not reachable";
    console.warn(`[tilthExtraction] triggerExtractAll(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
  const auth = await getAuthHeader();
  if (!auth) {
    const err = "not signed in (no Supabase session)";
    console.warn(`[tilthExtraction] triggerExtractAll(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
  try {
    const res = await fetch(
      `${base}/api/fields/${encodeURIComponent(fieldId)}/extract`,
      { method: "POST", headers: { Authorization: auth } }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || `HTTP ${res.status}`;
      console.warn(`[tilthExtraction] triggerExtractAll(${fieldId}) — ${err}`);
      return { ok: false, error: err };
    }
    return { ok: true, ...data };
  } catch (e) {
    const err = String(e?.message || e);
    console.warn(`[tilthExtraction] triggerExtractAll(${fieldId}) — ${err}`);
    return { ok: false, error: err };
  }
}

export async function triggerExtractLayer(fieldId, layerId) {
  const base = getTilthApiBase();
  if (!base) {
    const err = "tilth-api not reachable";
    console.warn(`[tilthExtraction] triggerExtractLayer(${fieldId}, ${layerId}) — ${err}`);
    return { ok: false, error: err };
  }
  const auth = await getAuthHeader();
  if (!auth) {
    const err = "not signed in (no Supabase session)";
    console.warn(`[tilthExtraction] triggerExtractLayer(${fieldId}, ${layerId}) — ${err}`);
    return { ok: false, error: err };
  }
  try {
    const res = await fetch(
      `${base}/api/fields/${encodeURIComponent(fieldId)}/layers/${encodeURIComponent(layerId)}/extract`,
      { method: "POST", headers: { Authorization: auth } }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || `HTTP ${res.status}`;
      console.warn(`[tilthExtraction] triggerExtractLayer(${fieldId}, ${layerId}) — ${err}`);
      return { ok: false, error: err };
    }
    return { ok: true, ...data };
  } catch (e) {
    const err = String(e?.message || e);
    console.warn(`[tilthExtraction] triggerExtractLayer(${fieldId}, ${layerId}) — ${err}`);
    return { ok: false, error: err };
  }
}

/**
 * Subscribe to UPDATE/INSERT events on `tilth_field_layer_data` for the
 * provided field ids. Returns `{ data, status }` where:
 *   - data : Map<fieldId, Map<layerId, row>> with the latest row per pair
 *   - status : 'idle' | 'connecting' | 'ready' | 'error' | 'no-supabase'
 *
 * Initial state is fetched via a one-shot `select` so the UI doesn't sit
 * empty while Realtime catches up.
 */
export function useFieldLayerData(fieldIds) {
  const ids = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const id of fieldIds || []) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    out.sort();
    return out;
  }, [fieldIds]);

  const idsKey = ids.join(",");
  const [state, setState] = useState({ data: new Map(), status: "idle" });

  useEffect(() => {
    if (!supabase) {
      setState({ data: new Map(), status: "no-supabase" });
      return undefined;
    }
    if (!ids.length) {
      setState({ data: new Map(), status: "idle" });
      return undefined;
    }

    let alive = true;
    let snapshotLoaded = false;
    setState((s) => ({ ...s, status: "connecting" }));

    const updateOne = (row) => {
      if (!alive || !row) return;
      setState((prev) => {
        const next = new Map(prev.data);
        let bucket = next.get(row.field_id);
        if (!bucket) {
          bucket = new Map();
          next.set(row.field_id, bucket);
        } else {
          bucket = new Map(bucket);
          next.set(row.field_id, bucket);
        }
        bucket.set(row.layer_id, row);
        return { ...prev, data: next };
      });
    };

    const removeOne = (row) => {
      if (!alive || !row) return;
      setState((prev) => {
        const next = new Map(prev.data);
        const bucket = next.get(row.field_id);
        if (!bucket) return prev;
        const cloned = new Map(bucket);
        cloned.delete(row.layer_id);
        if (cloned.size === 0) next.delete(row.field_id);
        else next.set(row.field_id, cloned);
        return { ...prev, data: next };
      });
    };

    // 1) Initial snapshot.
    (async () => {
      try {
        const { data, error } = await supabase
          .from("tilth_field_layer_data")
          .select("*")
          .in("field_id", ids);
        if (!alive) return;
        if (error) {
          console.warn("[tilthExtraction] initial select failed:", error.message);
          setState((s) => ({ ...s, status: "error" }));
          return;
        }
        const next = new Map();
        for (const row of data || []) {
          let bucket = next.get(row.field_id);
          if (!bucket) {
            bucket = new Map();
            next.set(row.field_id, bucket);
          }
          bucket.set(row.layer_id, row);
        }
        snapshotLoaded = true;
        setState({ data: next, status: "ready" });
      } catch (e) {
        if (!alive) return;
        console.warn("[tilthExtraction] initial select crashed:", e?.message || e);
        setState((s) => ({ ...s, status: "error" }));
      }
    })();

    // 2) Realtime subscription.
    // Supabase Realtime postgres_changes filter syntax: 'col=in.(a,b,c)'
    // (parentheses, comma-delimited). Each id is a UUID so quoting is fine.
    const channel = supabase
      .channel(`tilth_field_layer_data:${idsKey}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tilth_field_layer_data",
          filter: `field_id=in.(${ids.join(",")})`,
        },
        (payload) => {
          if (!alive) return;
          if (payload.eventType === "DELETE") removeOne(payload.old);
          else updateOne(payload.new);
        }
      )
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setState((s) => ({ ...s, status: "ready" }));
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // Don't downgrade once the snapshot select has succeeded — the
          // user can still trigger extraction and read finished rows via
          // the snapshot polling path; live updates are a nice-to-have.
          console.warn(
            `[tilthExtraction] realtime channel ${status} (snapshotLoaded=${snapshotLoaded})`
          );
          if (!snapshotLoaded) {
            setState((s) => ({ ...s, status: "error" }));
          }
        }
      });

    // 3) Lightweight polling fallback. Even if the Realtime channel works,
    // there's a brief window between an extraction finishing and the
    // postgres_changes event arriving — and on flaky networks the channel
    // may silently miss updates. A 5-second `select` keeps the UI honest
    // without hammering the DB (one query, indexed by field_id IN (…)).
    const POLL_INTERVAL_MS = 5000;
    const poll = async () => {
      if (!alive) return;
      try {
        const { data, error } = await supabase
          .from("tilth_field_layer_data")
          .select("*")
          .in("field_id", ids);
        if (!alive) return;
        if (error) {
          console.warn("[tilthExtraction] poll select failed:", error.message);
          return;
        }
        const next = new Map();
        for (const row of data || []) {
          let bucket = next.get(row.field_id);
          if (!bucket) {
            bucket = new Map();
            next.set(row.field_id, bucket);
          }
          bucket.set(row.layer_id, row);
        }
        setState((s) => ({ ...s, data: next }));
      } catch (e) {
        console.warn("[tilthExtraction] poll crashed:", e?.message || e);
      }
    };
    const pollTimer = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(pollTimer);
      try {
        supabase.removeChannel(channel);
      } catch {
        // channel teardown best-effort
      }
    };
  }, [ids, idsKey]);

  return state;
}

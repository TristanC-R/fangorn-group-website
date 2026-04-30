/**
 * Copernicus DEM 30 m helpers (frontend).
 *
 * Unlike NDVI/SAR which are time-series, elevation is a single static
 * row per field. The hook subscribes to `tilth_field_elevation` via
 * Supabase Realtime so the UI updates as soon as the backend finishes
 * processing.
 *
 *   useFieldElevation(fieldIds)
 *     → { data: Map<fieldId, row>, status, refresh(fieldId) }
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "./supabaseClient.js";
import { getTilthApiBase } from "./tilthApi.js";

async function getAuthHeader() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) return null;
  return `Bearer ${data.session.access_token}`;
}

export async function triggerElevationRefresh(fieldId, { force = false } = {}) {
  const base = getTilthApiBase();
  if (!base) return { ok: false, error: "tilth-api not reachable" };
  const auth = await getAuthHeader();
  if (!auth) return { ok: false, error: "not signed in" };
  try {
    const res = await fetch(
      `${base}/api/fields/${encodeURIComponent(fieldId)}/elevation/refresh`,
      {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Subscribe to `tilth_field_elevation` for the given field ids.
 *
 * Returns:
 *   {
 *     data:    Map<fieldId, row>,
 *     status:  'idle' | 'connecting' | 'ready' | 'error' | 'no-supabase',
 *     refresh: (fieldId, opts?) => void,
 *   }
 */
export function useFieldElevation(fieldIds) {
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
    data: new Map(),
    status: "idle",
  });

  const refresh = useCallback((fieldId, opts) => {
    triggerElevationRefresh(fieldId, opts).catch(() => {});
  }, []);

  useEffect(() => {
    if (!supabase) {
      setState({ data: new Map(), status: "no-supabase" });
      return undefined;
    }
    const ids = idsKey ? idsKey.split(",") : [];
    if (!ids.length) {
      setState({ data: new Map(), status: "idle" });
      return undefined;
    }

    let alive = true;
    setState((s) => ({ ...s, status: "connecting" }));

    const applyRows = (rows) => {
      if (!alive) return;
      const m = new Map();
      for (const row of rows || []) {
        if (row?.field_id) m.set(row.field_id, row);
      }
      setState({ data: m, status: "ready" });
    };

    const upsertOne = (row) => {
      if (!alive || !row?.field_id) return;
      setState((prev) => {
        const m = new Map(prev.data);
        m.set(row.field_id, row);
        return { ...prev, data: m };
      });
    };

    const removeOne = (row) => {
      if (!alive || !row?.field_id) return;
      setState((prev) => {
        const m = new Map(prev.data);
        m.delete(row.field_id);
        return { ...prev, data: m };
      });
    };

    (async () => {
      try {
        const { data, error } = await supabase
          .from("tilth_field_elevation")
          .select("*")
          .in("field_id", ids);
        if (!alive) return;
        if (error) {
          console.warn("[tilthElevation] initial select failed:", error.message);
          setState((s) => ({ ...s, status: "error" }));
          return;
        }
        applyRows(data);
      } catch (e) {
        if (!alive) return;
        console.warn("[tilthElevation] initial select crashed:", e?.message || e);
        setState((s) => ({ ...s, status: "error" }));
      }
    })();

    const channel = supabase
      .channel(`tilth_field_elevation:${idsKey}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tilth_field_elevation",
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
          setState((s) => ({ ...s, status: "ready" }));
        }
      });

    return () => {
      alive = false;
      try { supabase.removeChannel(channel); } catch { /* */ }
    };
  }, [idsKey]);

  return useMemo(
    () => ({ ...state, refresh }),
    [state, refresh]
  );
}

/**
 * Auto-trigger elevation extraction for fields that don't have it yet.
 * Called once when the topography workspace mounts.
 */
export async function autoRefreshElevation(fieldIds, elevationData) {
  if (!Array.isArray(fieldIds) || !fieldIds.length) return 0;
  let fired = 0;
  for (const id of fieldIds) {
    const row = elevationData instanceof Map ? elevationData.get(id) : null;
    if (!row || row.status === "error") {
      triggerElevationRefresh(id).catch(() => {});
      fired++;
    }
  }
  return fired;
}

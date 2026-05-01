import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";

/**
 * Local-storage backed Tilth store. Lets workspaces persist records, scheme
 * assignments, yield numbers, field attributes, etc. without needing the
 * provider APIs wired up yet. Keyed per farm id so multiple farms don't
 * collide.
 */

const PREFIX = "tilth";

const LISTENERS = new Map(); // storageKey -> Set<fn>

function storageKey(ns, farmId) {
  return `${PREFIX}:${ns}:${farmId || "default"}`;
}

function readRaw(ns, farmId, fallback) {
  try {
    const raw = window.localStorage.getItem(storageKey(ns, farmId));
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeRaw(ns, farmId, value, { remote = true } = {}) {
  const k = storageKey(ns, farmId);
  try {
    window.localStorage.setItem(k, JSON.stringify(value));
  } catch {
    /* quota or private mode — silently ignore */
  }
  const subs = LISTENERS.get(k);
  if (subs) {
    for (const fn of subs) {
      try {
        fn();
      } catch {
        /* ignore subscriber errors */
      }
    }
  }
  if (remote) syncRemote(ns, farmId, value);
}

function syncRemote(ns, farmId, value) {
  if (!supabase || !farmId) return;
  supabase
    .from("farm_app_data")
    .upsert(
      {
        farm_id: farmId,
        namespace: ns,
        data: value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "farm_id,namespace" }
    )
    .then(({ error }) => {
      if (error) console.warn("Could not sync Tilth data", ns, error.message);
    });
}

async function loadRemote(ns, farmId, fallback) {
  if (!supabase || !farmId) return readRaw(ns, farmId, fallback);
  const local = readRaw(ns, farmId, fallback);
  const { data, error } = await supabase
    .from("farm_app_data")
    .select("data")
    .eq("farm_id", farmId)
    .eq("namespace", ns)
    .maybeSingle();
  if (error) return local;
  if (data) {
    writeRaw(ns, farmId, data.data ?? fallback, { remote: false });
    return data.data ?? fallback;
  }
  if (local !== fallback) syncRemote(ns, farmId, local);
  return local;
}

export async function hydrateFarmStore(farmId) {
  if (!supabase || !farmId) return;
  const { data, error } = await supabase
    .from("farm_app_data")
    .select("namespace,data")
    .eq("farm_id", farmId);
  if (error || !Array.isArray(data)) return;
  for (const row of data) {
    if (!row?.namespace) continue;
    writeRaw(row.namespace, farmId, row.data, { remote: false });
  }
}

function subscribe(ns, farmId, fn) {
  const k = storageKey(ns, farmId);
  let set = LISTENERS.get(k);
  if (!set) {
    set = new Set();
    LISTENERS.set(k, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) LISTENERS.delete(k);
  };
}

/**
 * Reactive hook for a localStorage-backed value. Updates from any component
 * using the same `(ns, farmId)` key are broadcast via an in-memory pubsub so
 * Home / Analytics / Reports reflect fresh data when you flip back to them.
 */
export function useLocalValue(ns, farmId, fallback) {
  const [state, setState] = useState(() => readRaw(ns, farmId, fallback));

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe(ns, farmId, () => {
      setState(readRaw(ns, farmId, fallback));
    });
    setState(readRaw(ns, farmId, fallback));
    loadRemote(ns, farmId, fallback).then((value) => {
      if (!cancelled) setState(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ns, farmId, fallback]);

  const update = useCallback(
    (valueOrFn) => {
      const current = readRaw(ns, farmId, fallback);
      const next =
        typeof valueOrFn === "function" ? valueOrFn(current) : valueOrFn;
      writeRaw(ns, farmId, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ns, farmId]
  );

  return [state, update];
}

export const tilthStore = {
  loadNamespace(ns, farmId, fallback = []) {
    return readRaw(ns, farmId, fallback);
  },
  saveNamespace(ns, farmId, value) {
    writeRaw(ns, farmId, value);
  },
  loadRecords(farmId) {
    return readRaw("records", farmId, []);
  },
  saveRecords(farmId, rows) {
    writeRaw("records", farmId, rows);
  },
  loadCustomProducts(farmId) {
    return readRaw("custom_products", farmId, []);
  },
  saveCustomProducts(farmId, rows) {
    writeRaw("custom_products", farmId, rows);
  },
  loadAssignments(farmId) {
    return readRaw("assignments", farmId, {});
  },
  saveAssignments(farmId, map) {
    writeRaw("assignments", farmId, map);
  },
  loadYield(farmId) {
    return readRaw("yield", farmId, {});
  },
  saveYield(farmId, map) {
    writeRaw("yield", farmId, map);
  },
  loadFieldAttrs(farmId) {
    return readRaw("fieldAttrs", farmId, {});
  },
  saveFieldAttrs(farmId, map) {
    writeRaw("fieldAttrs", farmId, map);
  },
  loadRotations(farmId) {
    return readRaw("rotations", farmId, {});
  },
  saveRotations(farmId, map) {
    writeRaw("rotations", farmId, map);
  },

  /**
   * Planting history — array of planting events per field.
   * Shape: { [fieldId]: [ { id, crop, plantingDate, notes, createdAt }, ... ] }
   * Sorted newest-first. The first entry is the *current* planting.
   */
  loadPlantings(farmId) {
    return readRaw("plantings", farmId, {});
  },
  savePlantings(farmId, map) {
    writeRaw("plantings", farmId, map);
  },

  loadTasks(farmId) {
    return readRaw("tasks", farmId, []);
  },
  saveTasks(farmId, rows) {
    writeRaw("tasks", farmId, rows);
  },
  loadFinances(farmId) {
    return readRaw("finances", farmId, []);
  },
  saveFinances(farmId, rows) {
    writeRaw("finances", farmId, rows);
  },
  loadInventory(farmId) {
    return readRaw("inventory", farmId, []);
  },
  saveInventory(farmId, rows) {
    writeRaw("inventory", farmId, rows);
  },
  loadTeamLocations(farmId) {
    return readRaw("team_locations", farmId, []);
  },
  saveTeamLocations(farmId, rows) {
    writeRaw("team_locations", farmId, rows);
  },
  upsertTask(farmId, task) {
    const rows = readRaw("tasks", farmId, []);
    const sourceKey = task.sourceKey || null;
    const id = task.id || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      status: "pending",
      priority: "medium",
      category: "general",
      createdAt: new Date().toISOString(),
      ...task,
      id,
      updatedAt: new Date().toISOString(),
    };
    const idx = sourceKey
      ? rows.findIndex((r) => r.sourceKey === sourceKey)
      : rows.findIndex((r) => r.id === id);
    const next = idx >= 0
      ? rows.map((r, i) => (i === idx ? { ...r, ...entry, id: r.id } : r))
      : [entry, ...rows];
    writeRaw("tasks", farmId, next);
    return { task: idx >= 0 ? next[idx] : entry, tasks: next };
  },
  cancelTaskBySourceKey(farmId, sourceKey) {
    if (!sourceKey) return { task: null, tasks: readRaw("tasks", farmId, []) };
    const rows = readRaw("tasks", farmId, []);
    let task = null;
    const next = rows.map((r) => {
      if (r.sourceKey !== sourceKey) return r;
      task = { ...r, status: "cancelled", updatedAt: new Date().toISOString() };
      return task;
    });
    if (task) writeRaw("tasks", farmId, next);
    return { task, tasks: next };
  },

  /** Convenience: get the current (most recent) planting for a field. */
  currentPlanting(farmId, fieldId) {
    const all = readRaw("plantings", farmId, {});
    const arr = all[fieldId];
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[0];
  },

  /** Add a new planting event, pushing it to the top. Also patches fieldAttrs.crop. */
  addPlanting(farmId, fieldId, { crop, plantingDate, notes }) {
    const all = readRaw("plantings", farmId, {});
    const arr = Array.isArray(all[fieldId]) ? [...all[fieldId]] : [];
    const entry = {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      crop,
      plantingDate,
      notes: notes || "",
      createdAt: new Date().toISOString(),
    };
    arr.unshift(entry);
    all[fieldId] = arr;
    writeRaw("plantings", farmId, all);

    const attrs = readRaw("fieldAttrs", farmId, {});
    attrs[fieldId] = { ...(attrs[fieldId] || {}), crop };
    writeRaw("fieldAttrs", farmId, attrs);

    return entry;
  },

  /** Remove a planting event by id. */
  removePlanting(farmId, fieldId, plantingId) {
    const all = readRaw("plantings", farmId, {});
    const arr = Array.isArray(all[fieldId]) ? all[fieldId].filter((p) => p.id !== plantingId) : [];
    all[fieldId] = arr;
    writeRaw("plantings", farmId, all);

    if (arr.length) {
      const attrs = readRaw("fieldAttrs", farmId, {});
      attrs[fieldId] = { ...(attrs[fieldId] || {}), crop: arr[0].crop };
      writeRaw("fieldAttrs", farmId, attrs);
    }
  },

  /** Edit an existing planting event. */
  updatePlanting(farmId, fieldId, plantingId, patch) {
    const all = readRaw("plantings", farmId, {});
    const arr = Array.isArray(all[fieldId]) ? [...all[fieldId]] : [];
    const idx = arr.findIndex((p) => p.id === plantingId);
    if (idx < 0) return;
    arr[idx] = { ...arr[idx], ...patch };
    all[fieldId] = arr;
    writeRaw("plantings", farmId, all);

    if (idx === 0 && patch.crop) {
      const attrs = readRaw("fieldAttrs", farmId, {});
      attrs[fieldId] = { ...(attrs[fieldId] || {}), crop: patch.crop };
      writeRaw("fieldAttrs", farmId, attrs);
    }
  },
};

/** Helper for tests / "start over" buttons — wipe everything for a farm. */
export function resetFarmStore(farmId) {
  const nses = ["records", "assignments", "yield", "fieldAttrs", "plantings", "rotations"];
  for (const ns of nses) writeRaw(ns, farmId, ns === "records" ? [] : {});
}

/**
 * Notification engine for Tilth.
 *
 * Derives actionable alerts from three data sources:
 *   1. Crop health flags (NDVI dips, water stress, stalled growth, etc.)
 *   2. Crop phenology (upcoming stage transitions, harvest windows, N timing)
 *   3. Operational records (PHI countdowns, NVZ closed-period warnings)
 *
 * The core `generateNotifications` function is pure — same input, same
 * output. The `useNotifications` hook adds dismiss/read state via
 * localStorage so notifications survive page reloads.
 *
 * Every notification carries a deterministic `id` derived from its source
 * data so the same underlying condition never spawns duplicates.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { CROP_CATALOGUE, daysSincePlanting, expectedStage } from "./cropPhenology.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const DISMISSED_KEY = "tilth:dismissed_notifications";
const READ_KEY      = "tilth:read_notifications";

/** @type {Record<string, { label: string, color: string }>} */
export const NOTIFICATION_CATEGORIES = {
  health:     { label: "Crop health",   color: "#B4412E" },
  phenology:  { label: "Growth stage",  color: "#649A5C" },
  harvest:    { label: "Harvest",       color: "#EC9A29" },
  nitrogen:   { label: "Nitrogen",      color: "#2F6077" },
  compliance: { label: "Compliance",    color: "#C07C12" },
  data:       { label: "Data quality",  color: "#839788" },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic ID by hashing the source components.
 * Uses a simple djb2-style hash — good enough for deduplication within a
 * single browser session.
 */
function deterministicId(...parts) {
  const str = parts.map(String).join("|");
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return "n_" + (hash >>> 0).toString(36);
}

/**
 * Build a notification object with standard shape.
 * @param {object} opts
 * @returns {object}
 */
function note({
  type,
  priority,
  title,
  detail,
  fieldId,
  fieldName,
  category,
  timestamp,
  actionLabel,
  actionSection,
  idParts,
}) {
  return {
    id: deterministicId(...idParts),
    type,
    priority,
    title,
    detail,
    fieldId:       fieldId ?? null,
    fieldName:     fieldName ?? null,
    category,
    timestamp:     timestamp ?? Date.now(),
    actionLabel:   actionLabel ?? null,
    actionSection: actionSection ?? null,
  };
}

// ---------------------------------------------------------------------------
// Flag metadata — maps health flag tags to notification properties
// ---------------------------------------------------------------------------

const FLAG_META = {
  ndvi_dip_7d: {
    priority: "high",
    title: (f) => `NDVI drop on ${f}`,
    detail: "Sudden 7-day NDVI decline detected — possible stress, disease or lodging.",
    category: "health",
    actionLabel: "View satellite data",
    actionSection: "sensing",
  },
  water_stress: {
    priority: "high",
    title: (f) => `Water stress on ${f}`,
    detail: "Moisture index (NDMI) indicates water deficit during active growth.",
    category: "health",
    actionLabel: "Check soil moisture",
    actionSection: "soil",
  },
  below_cohort: {
    priority: "medium",
    title: (f) => `${f} trailing the farm`,
    detail: "NDVI is significantly below the farm median — compare with neighbours.",
    category: "health",
    actionLabel: "Compare fields",
    actionSection: "insights",
  },
  late_emergence: {
    priority: "high",
    title: (f) => `Late emergence on ${f}`,
    detail: "Past expected emergence date and NDVI is still very low.",
    category: "health",
    actionLabel: "View health detail",
    actionSection: "insights",
  },
  below_expected_for_stage: {
    priority: "high",
    title: (f) => `${f} behind schedule`,
    detail: "Crop vigour is below the expected range for the current growth stage.",
    category: "health",
    actionLabel: "View health detail",
    actionSection: "insights",
  },
  stuck: {
    priority: "medium",
    title: (f) => `Growth stalled on ${f}`,
    detail: "Negligible NDVI change over 21 days during active growth.",
    category: "health",
    actionLabel: "View health detail",
    actionSection: "insights",
  },
  sar_ndvi_divergence: {
    priority: "medium",
    title: (f) => `Radar anomaly on ${f}`,
    detail: "Radar backscatter rising while NDVI is falling — possible lodging.",
    category: "health",
    actionLabel: "View radar data",
    actionSection: "sensing",
  },
  no_recent_data: {
    priority: "info",
    title: (f) => `No recent imagery for ${f}`,
    detail: "No clean satellite scene in the last 14 days.",
    category: "data",
    actionLabel: "View satellite data",
    actionSection: "sensing",
  },
};

// ---------------------------------------------------------------------------
// Notification generators (pure)
// ---------------------------------------------------------------------------

/**
 * Generate health-flag notifications from the health map.
 * @param {Map|Object} healthMap — fieldId → healthRecord
 * @param {Array} fields
 * @param {number} now
 */
function fromHealthFlags(healthMap, fields, now) {
  const results = [];
  const entries = healthMap instanceof Map
    ? [...healthMap.entries()]
    : Object.entries(healthMap || {});

  const fieldNameMap = new Map(
    (fields || []).map((f) => [f.id, f.name || f.id])
  );

  for (const [fieldId, rec] of entries) {
    if (!rec || !Array.isArray(rec.flags)) continue;
    const name = fieldNameMap.get(fieldId) || fieldId;
    for (const flag of rec.flags) {
      const meta = FLAG_META[flag];
      if (!meta) continue;
      results.push(
        note({
          type:          flag,
          priority:      meta.priority,
          title:         meta.title(name),
          detail:        meta.detail,
          fieldId,
          fieldName:     name,
          category:      meta.category,
          timestamp:     now,
          actionLabel:   meta.actionLabel,
          actionSection: meta.actionSection,
          idParts:       [flag, fieldId],
        })
      );
    }
  }
  return results;
}

/**
 * Generate phenology-driven notifications from the plantings map.
 * @param {Object} plantingsMap — { fieldId: [{ crop, plantingDate, ... }] }
 * @param {Array} fields
 * @param {number} now
 */
function fromPhenology(plantingsMap, fields, now) {
  const results = [];
  if (!plantingsMap) return results;

  const fieldNameMap = new Map(
    (fields || []).map((f) => [f.id, f.name || f.id])
  );

  for (const [fieldId, plantings] of Object.entries(plantingsMap)) {
    if (!Array.isArray(plantings) || !plantings.length) continue;
    const current = plantings[0];
    if (!current?.crop || !current?.plantingDate) continue;

    const crop = CROP_CATALOGUE[current.crop];
    if (!crop) continue;

    const name = fieldNameMap.get(fieldId) || fieldId;
    const dsp = daysSincePlanting(current.plantingDate, now);
    if (dsp == null) continue;

    const stageInfo = expectedStage(current.crop, dsp);
    if (!stageInfo) continue;

    const stages = crop.stages;

    // Upcoming stage transition (within 14 days)
    const nextStageIdx = stageInfo.stageIndex + 1;
    if (nextStageIdx < stages.length) {
      const nextStage = stages[nextStageIdx];
      const daysToNext = nextStage.dayRange[0] - dsp;
      if (daysToNext > 0 && daysToNext <= 14) {
        results.push(
          note({
            type:          "stage_transition",
            priority:      "info",
            title:         `${current.crop} on ${name}: ${nextStage.name} in ~${daysToNext}d`,
            detail:        `${current.crop} is expected to enter ${nextStage.name} stage in approximately ${daysToNext} days.`,
            fieldId,
            fieldName:     name,
            category:      "phenology",
            timestamp:     now,
            actionLabel:   "View growth stage",
            actionSection: "insights",
            idParts:       ["stage_transition", fieldId, nextStage.name],
          })
        );
      }
    }

    // Harvest approaching (within 21 days)
    const harvestStage = stages.find((s) => s.name === "harvest" || s.name === "termination");
    if (harvestStage) {
      const daysToHarvest = harvestStage.dayRange[0] - dsp;
      if (daysToHarvest > 0 && daysToHarvest <= 21) {
        results.push(
          note({
            type:          "harvest_approaching",
            priority:      daysToHarvest <= 7 ? "high" : "medium",
            title:         `${current.crop} on ${name}: harvest in ~${daysToHarvest}d`,
            detail:        `${current.crop} is approaching harvest window. Plan combining and logistics.`,
            fieldId,
            fieldName:     name,
            category:      "harvest",
            timestamp:     now,
            actionLabel:   "View yield data",
            actionSection: "insights",
            idParts:       ["harvest_approaching", fieldId],
          })
        );
      }
    }

    // N timing windows — notify if the crop has nTimings and we're in
    // a stage that typically receives nitrogen
    if (crop.nTimings?.length && crop.family !== "pulse" && crop.family !== "cover") {
      const nStages = ["tillering", "stem extension", "vegetative", "canopy build"];
      const currentStageName = stageInfo.stageName?.toLowerCase();
      if (nStages.some((ns) => currentStageName?.includes(ns))) {
        const nextStageForN = stages.find(
          (s, idx) => idx > stageInfo.stageIndex && !nStages.some((ns) => s.name.toLowerCase().includes(ns))
        );
        const daysRemaining = nextStageForN
          ? nextStageForN.dayRange[0] - dsp
          : null;
        if (daysRemaining == null || daysRemaining > 0) {
          results.push(
            note({
              type:          "n_timing",
              priority:      "medium",
              title:         `N timing window for ${current.crop} on ${name}`,
              detail:        `${crop.nTimings[0]}. Current stage: ${stageInfo.stageName}.${daysRemaining != null ? ` Window closes in ~${daysRemaining} days.` : ""}`,
              fieldId,
              fieldName:     name,
              category:      "nitrogen",
              timestamp:     now,
              actionLabel:   "View records",
              actionSection: "records",
              idParts:       ["n_timing", fieldId, stageInfo.stageName],
            })
          );
        }
      }
    }
  }

  return results;
}

/**
 * Generate compliance notifications from operational records.
 *
 * Scans for:
 *   - PHI (Pre-Harvest Interval) countdowns nearing zero (< 3 days)
 *   - NVZ closed-period warnings (starting within 7 days)
 *
 * @param {Array} records — array of record objects from tilthStore
 * @param {Array} fields
 * @param {number} now
 */
function fromRecords(records, fields, now) {
  const results = [];
  if (!Array.isArray(records)) return results;

  const fieldNameMap = new Map(
    (fields || []).map((f) => [f.id, f.name || f.id])
  );

  for (const rec of records) {
    if (!rec) continue;

    // PHI countdown: records with a phi_days and application_date
    if (
      Number.isFinite(rec.phi_days) &&
      rec.phi_days > 0 &&
      rec.application_date
    ) {
      const appTime = new Date(rec.application_date).getTime();
      if (Number.isFinite(appTime)) {
        const expiryTime = appTime + rec.phi_days * DAY_MS;
        const daysRemaining = Math.ceil((expiryTime - now) / DAY_MS);
        if (daysRemaining >= 0 && daysRemaining < 3) {
          const name = fieldNameMap.get(rec.field_id) || rec.field_id || "Unknown";
          results.push(
            note({
              type:          "phi_expiry",
              priority:      daysRemaining <= 0 ? "critical" : "high",
              title:         daysRemaining <= 0
                ? `PHI expired for ${rec.product || "spray"} on ${name}`
                : `PHI expires in ${daysRemaining}d — ${rec.product || "spray"} on ${name}`,
              detail:        `Pre-harvest interval for ${rec.product || "application"} ${daysRemaining <= 0 ? "has passed" : `ends in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}`}. Ensure harvest timing is compliant.`,
              fieldId:       rec.field_id ?? null,
              fieldName:     name,
              category:      "compliance",
              timestamp:     now,
              actionLabel:   "View spray records",
              actionSection: "records",
              idParts:       ["phi_expiry", rec.field_id, rec.id || rec.application_date],
            })
          );
        }
      }
    }

    // NVZ closed-period warning: records with nvz_closed_start date
    if (rec.nvz_closed_start) {
      const closedStart = new Date(rec.nvz_closed_start).getTime();
      if (Number.isFinite(closedStart)) {
        const daysUntil = Math.ceil((closedStart - now) / DAY_MS);
        if (daysUntil >= 0 && daysUntil <= 7) {
          const name = fieldNameMap.get(rec.field_id) || rec.field_id || "Unknown";
          results.push(
            note({
              type:          "nvz_closed_period",
              priority:      daysUntil <= 2 ? "high" : "medium",
              title:         daysUntil <= 0
                ? `NVZ closed period has started — ${name}`
                : `NVZ closed period starts in ${daysUntil}d — ${name}`,
              detail:        `Nitrate Vulnerable Zone restrictions ${daysUntil <= 0 ? "are now in effect" : `begin in ${daysUntil} day${daysUntil !== 1 ? "s" : ""}`}. Plan applications accordingly.`,
              fieldId:       rec.field_id ?? null,
              fieldName:     name,
              category:      "compliance",
              timestamp:     now,
              actionLabel:   "View compliance records",
              actionSection: "records",
              idParts:       ["nvz_closed", rec.field_id, rec.nvz_closed_start],
            })
          );
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API — pure generator
// ---------------------------------------------------------------------------

/**
 * Generate the full set of notifications by scanning all data sources.
 *
 * @param {Map|Object} healthMap    — fieldId → crop-health record
 * @param {Object}     plantingsMap — fieldId → planting array
 * @param {Array}      records      — operational records from tilthStore
 * @param {Array}      fields       — field objects with `.id` and `.name`
 * @param {number}     [now]        — timestamp (ms); defaults to Date.now()
 * @returns {Array<{
 *   id: string,
 *   type: string,
 *   priority: 'critical'|'high'|'medium'|'info',
 *   title: string,
 *   detail: string,
 *   fieldId: string|null,
 *   fieldName: string|null,
 *   category: string,
 *   timestamp: number,
 *   actionLabel: string|null,
 *   actionSection: string|null,
 * }>}
 */
export function generateNotifications(healthMap, plantingsMap, records, fields, now = Date.now()) {
  const all = [
    ...fromHealthFlags(healthMap, fields, now),
    ...fromPhenology(plantingsMap, fields, now),
    ...fromRecords(records, fields, now),
  ];

  // Sort: critical → high → medium → info
  const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, info: 3 };
  all.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));

  return all;
}

// ---------------------------------------------------------------------------
// localStorage helpers for dismiss / read state
// ---------------------------------------------------------------------------

function readSet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function writeSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch { /* quota — silently ignore */ }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Reactive notification hook. Generates notifications from the current data
 * sources, filters out dismissed IDs, and exposes dismiss/read actions.
 *
 * @param {Map|Object} healthMap
 * @param {Object}     plantingsMap
 * @param {Array}      records
 * @param {Array}      fields
 * @returns {{
 *   notifications: object[],
 *   unreadCount: number,
 *   dismiss: (id: string) => void,
 *   dismissAll: () => void,
 *   markRead: (id: string) => void,
 * }}
 */
export function useNotifications(healthMap, plantingsMap, records, fields) {
  const [dismissedIds, setDismissedIds] = useState(() => readSet(DISMISSED_KEY));
  const [readIds, setReadIds]           = useState(() => readSet(READ_KEY));

  // Keep localStorage in sync when dismiss/read state changes.
  useEffect(() => { writeSet(DISMISSED_KEY, dismissedIds); }, [dismissedIds]);
  useEffect(() => { writeSet(READ_KEY, readIds); }, [readIds]);

  const all = useMemo(
    () => generateNotifications(healthMap, plantingsMap, records, fields),
    [healthMap, plantingsMap, records, fields]
  );

  const notifications = useMemo(
    () => all.filter((n) => !dismissedIds.has(n.id)),
    [all, dismissedIds]
  );

  const unreadCount = useMemo(
    () => notifications.filter((n) => !readIds.has(n.id)).length,
    [notifications, readIds]
  );

  const dismiss = useCallback((id) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const dismissAll = useCallback(() => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      for (const n of notifications) next.add(n.id);
      return next;
    });
  }, [notifications]);

  const markRead = useCallback((id) => {
    setReadIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  return { notifications, unreadCount, dismiss, dismissAll, markRead };
}

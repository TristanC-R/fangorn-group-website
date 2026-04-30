/**
 * Report analytics engine.
 *
 * Pure functions that take per-field NDVI/SAR scenes and produce
 * time-series analyses, period-over-period comparisons, field
 * rankings, actionable recommendations, and inline SVG sparklines
 * suitable for embedding in an HTML report.
 */

import { flagSuspectScenes } from "./cropHealth.js";
import { CROP_CATALOGUE, daysSincePlanting, expectedStage } from "./cropPhenology.js";

const DAY_MS = 86_400_000;
function ms(iso) { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : 0; }

// ─── Time-series slicing ─────────────────────────────────────────────

function cleanScenesInRange(scenes, start, end) {
  if (!Array.isArray(scenes) || !scenes.length) return [];
  const asc = scenes
    .filter((s) => s?.status === "ok" && Number.isFinite(s.ndvi_mean) && (s.valid_pixel_count ?? 0) > 0)
    .sort((a, b) => ms(a.scene_datetime) - ms(b.scene_datetime));
  const suspect = flagSuspectScenes(asc);
  const sMs = start.getTime();
  const eMs = end.getTime();
  return asc.filter((s) => !suspect.has(s.item_id) && ms(s.scene_datetime) >= sMs && ms(s.scene_datetime) <= eMs);
}

// ─── Per-field period analysis ───────────────────────────────────────

export function analyseFieldPeriod(scenes, start, end) {
  const clean = cleanScenesInRange(scenes, start, end);
  if (!clean.length) return null;

  const ndviValues = clean.map((s) => s.ndvi_mean);
  const mean = ndviValues.reduce((a, v) => a + v, 0) / ndviValues.length;
  const min = Math.min(...ndviValues);
  const max = Math.max(...ndviValues);
  const range = max - min;
  const stddev = Math.sqrt(ndviValues.reduce((a, v) => a + (v - mean) ** 2, 0) / ndviValues.length);

  const first = clean[0];
  const last = clean[clean.length - 1];
  const periodChange = last.ndvi_mean - first.ndvi_mean;
  const periodChangePct = first.ndvi_mean > 0.01 ? (periodChange / first.ndvi_mean) * 100 : 0;

  // Linear regression slope (NDVI per day)
  const slope = linearSlope(clean.map((s) => ({ t: ms(s.scene_datetime), v: s.ndvi_mean })));

  // EVI / NDWI / NDMI summaries if available
  const eviValues = clean.filter((s) => Number.isFinite(s.evi_mean)).map((s) => s.evi_mean);
  const ndwiValues = clean.filter((s) => Number.isFinite(s.ndwi_mean)).map((s) => s.ndwi_mean);
  const ndmiValues = clean.filter((s) => Number.isFinite(s.ndmi_mean)).map((s) => s.ndmi_mean);

  // Detect largest dip in period
  let maxDip = 0, dipDate = null;
  for (let i = 1; i < clean.length; i++) {
    const drop = clean[i - 1].ndvi_mean - clean[i].ndvi_mean;
    if (drop > maxDip) {
      maxDip = drop;
      dipDate = clean[i].scene_datetime;
    }
  }

  // Detect peak in period
  const peakScene = clean.reduce((best, s) => (!best || s.ndvi_mean > best.ndvi_mean ? s : best), null);

  return {
    sceneCount: clean.length,
    mean: round(mean, 3),
    min: round(min, 3),
    max: round(max, 3),
    range: round(range, 3),
    stddev: round(stddev, 4),
    periodChange: round(periodChange, 3),
    periodChangePct: round(periodChangePct, 1),
    slopePerDay: slope,
    startNdvi: round(first.ndvi_mean, 3),
    endNdvi: round(last.ndvi_mean, 3),
    startDate: first.scene_datetime,
    endDate: last.scene_datetime,
    maxDip: round(maxDip, 3),
    dipDate,
    peakNdvi: peakScene ? round(peakScene.ndvi_mean, 3) : null,
    peakDate: peakScene?.scene_datetime || null,
    eviMean: eviValues.length ? round(avg(eviValues), 3) : null,
    ndwiMean: ndwiValues.length ? round(avg(ndwiValues), 3) : null,
    ndmiMean: ndmiValues.length ? round(avg(ndmiValues), 3) : null,
    sparkData: clean.map((s) => ({ t: ms(s.scene_datetime), ndvi: s.ndvi_mean })),
  };
}

// ─── Period-over-period comparison ───────────────────────────────────

export function periodComparison(scenes, currentStart, currentEnd) {
  const days = Math.round((currentEnd.getTime() - currentStart.getTime()) / DAY_MS);
  const prevEnd = new Date(currentStart.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - days * DAY_MS);

  const current = analyseFieldPeriod(scenes, currentStart, currentEnd);
  const previous = analyseFieldPeriod(scenes, prevStart, prevEnd);

  if (!current) return null;

  let delta = null, deltaPct = null;
  if (previous) {
    delta = round(current.mean - previous.mean, 3);
    deltaPct = previous.mean > 0.01 ? round((delta / previous.mean) * 100, 1) : null;
  }

  return {
    current,
    previous,
    delta,
    deltaPct,
    improved: delta != null ? delta > 0.02 : null,
    declined: delta != null ? delta < -0.02 : null,
    stable: delta != null ? Math.abs(delta) <= 0.02 : null,
    prevLabel: `${isoDay(prevStart)} – ${isoDay(prevEnd)}`,
  };
}

// ─── Farm-level rankings ─────────────────────────────────────────────

export function farmRankings(fieldAnalyses) {
  const valid = fieldAnalyses.filter((f) => f.analysis != null);
  if (!valid.length) return { top: [], bottom: [], mostImproved: [], mostDeclined: [] };

  const byMean = [...valid].sort((a, b) => b.analysis.mean - a.analysis.mean);
  const byChange = [...valid].sort((a, b) => b.analysis.periodChange - a.analysis.periodChange);

  return {
    top: byMean.slice(0, 5),
    bottom: byMean.slice(-5).reverse(),
    mostImproved: byChange.filter((f) => f.analysis.periodChange > 0).slice(0, 5),
    mostDeclined: byChange.filter((f) => f.analysis.periodChange < 0).slice(-5).reverse(),
  };
}

// ─── Recommendations engine ──────────────────────────────────────────

/**
 * @param {Array} fieldAnalyses
 * @param {Map} healthMap
 * @param {string} cadence
 * @param {Object} [plantingsMap] — { fieldId: [ { crop, plantingDate }, ... ] }
 */
export function generateRecommendations(fieldAnalyses, healthMap, cadence, plantingsMap) {
  const recs = [];
  const now = Date.now();

  const declining = fieldAnalyses.filter((f) => f.analysis?.slopePerDay < -0.003);
  if (declining.length) {
    recs.push({
      priority: "high",
      category: "Crop health",
      title: `${declining.length} field${declining.length > 1 ? "s" : ""} showing declining NDVI`,
      detail: `${declining.map((f) => f.name).join(", ")} — consider a walk-over inspection to check for disease, pest pressure, or nutrient deficiency.`,
      fields: declining.map((f) => f.name),
    });
  }

  const dips = fieldAnalyses.filter((f) => f.analysis?.maxDip >= 0.10);
  if (dips.length) {
    recs.push({
      priority: "high",
      category: "Anomaly detection",
      title: `Significant NDVI drops detected in ${dips.length} field${dips.length > 1 ? "s" : ""}`,
      detail: `Drops of ≥0.10 NDVI within a single revisit: ${dips.map((f) => `${f.name} (−${f.analysis.maxDip})`).join(", ")}. Could indicate lodging, disease onset, or localised damage.`,
      fields: dips.map((f) => f.name),
    });
  }

  const stale = [];
  for (const f of fieldAnalyses) {
    const h = healthMap?.get(f.fieldId);
    if (h?.flags?.includes("no_recent_data")) stale.push(f.name);
  }
  if (stale.length) {
    recs.push({
      priority: "medium",
      category: "Data gaps",
      title: `${stale.length} field${stale.length > 1 ? "s" : ""} without recent satellite imagery`,
      detail: `${stale.join(", ")} — persistent cloud cover may be blocking. Check the satellite workspace for the latest SAR data as an alternative.`,
      fields: stale,
    });
  }

  const belowCohort = [];
  for (const f of fieldAnalyses) {
    const h = healthMap?.get(f.fieldId);
    if (h?.flags?.includes("below_cohort")) belowCohort.push(f.name);
  }
  if (belowCohort.length) {
    recs.push({
      priority: "medium",
      category: "Performance",
      title: `${belowCohort.length} field${belowCohort.length > 1 ? "s" : ""} trailing the farm average`,
      detail: `${belowCohort.join(", ")} are underperforming relative to the rest of the farm. Review soil conditions, drainage, and input history.`,
      fields: belowCohort,
    });
  }

  const highVariability = fieldAnalyses.filter((f) => f.analysis?.stddev > 0.08);
  if (highVariability.length) {
    recs.push({
      priority: "low",
      category: "Variability",
      title: `High within-period NDVI variability on ${highVariability.length} field${highVariability.length > 1 ? "s" : ""}`,
      detail: `${highVariability.map((f) => f.name).join(", ")} show NDVI standard deviation > 0.08 — may indicate patchy establishment, mixed cropping, or inconsistent management.`,
      fields: highVariability.map((f) => f.name),
    });
  }

  const improving = fieldAnalyses.filter((f) => f.analysis?.slopePerDay > 0.005);
  if (improving.length) {
    recs.push({
      priority: "info",
      category: "Positive trends",
      title: `${improving.length} field${improving.length > 1 ? "s" : ""} showing strong growth`,
      detail: `${improving.map((f) => f.name).join(", ")} — vegetation indices are trending upward. Good canopy development.`,
      fields: improving.map((f) => f.name),
    });
  }

  const moistureStress = [];
  for (const f of fieldAnalyses) {
    if (f.analysis?.ndmiMean != null && f.analysis.ndmiMean < -0.1) moistureStress.push(f.name);
  }
  if (moistureStress.length) {
    recs.push({
      priority: "medium",
      category: "Water stress",
      title: `Low moisture index on ${moistureStress.length} field${moistureStress.length > 1 ? "s" : ""}`,
      detail: `${moistureStress.join(", ")} show mean NDMI below −0.1, suggesting potential water stress. Review drainage and irrigation if applicable.`,
      fields: moistureStress,
    });
  }

  // ── Crop-specific recommendations from planting data ──
  if (plantingsMap) {
    const behindSchedule = [];
    const nTimingAlerts = [];
    const riskAlerts = [];
    const harvestApproaching = [];

    for (const f of fieldAnalyses) {
      const planting = plantingsMap[f.fieldId]?.[0];
      if (!planting?.crop || !planting?.plantingDate) continue;

      const crop = CROP_CATALOGUE[planting.crop];
      if (!crop) continue;

      const dsp = daysSincePlanting(planting.plantingDate, now);
      if (dsp == null) continue;

      const stg = expectedStage(planting.crop, dsp);
      if (!stg) continue;

      // Behind schedule: NDVI well below expected for the crop stage
      const h = healthMap?.get(f.fieldId);
      if (h?.flags?.includes("below_expected_for_stage")) {
        behindSchedule.push({ name: f.name, crop: planting.crop, stage: stg.stageName, expected: stg.ndviExpected });
      }

      // N timing reminders based on crop phenology
      if (crop.nTimings?.length) {
        const stages = crop.stages;
        const nextStageIdx = stg.stageIndex + 1;
        if (nextStageIdx < stages.length) {
          const nextStage = stages[nextStageIdx];
          const daysToNext = nextStage.dayRange[0] - dsp;
          if (daysToNext > 0 && daysToNext <= 14) {
            nTimingAlerts.push({ name: f.name, crop: planting.crop, nextStage: nextStage.name, daysToNext, nTiming: crop.nTimings[0] });
          }
        }
      }

      // Key risk alerts during vulnerable stages
      if (crop.keyRisks?.length && stg.stageIndex >= 2 && stg.stageIndex < crop.stages.length - 2) {
        riskAlerts.push({ name: f.name, crop: planting.crop, stage: stg.stageName, risks: crop.keyRisks });
      }

      // Harvest approaching
      const lastStage = crop.stages[crop.stages.length - 1];
      const daysToHarvest = lastStage.dayRange[0] - dsp;
      if (daysToHarvest > 0 && daysToHarvest <= 21) {
        harvestApproaching.push({ name: f.name, crop: planting.crop, daysToHarvest });
      }
    }

    if (behindSchedule.length) {
      recs.push({
        priority: "high",
        category: "Crop calendar",
        title: `${behindSchedule.length} field${behindSchedule.length > 1 ? "s" : ""} behind expected growth for crop type`,
        detail: behindSchedule.map((b) => `${b.name} (${b.crop}, ${b.stage}): expected NDVI ${b.expected[0].toFixed(2)}–${b.expected[1].toFixed(2)}`).join("; ") + ". Check for establishment issues, disease, or nutrient deficiency.",
        fields: behindSchedule.map((b) => b.name),
      });
    }

    if (nTimingAlerts.length) {
      recs.push({
        priority: "medium",
        category: "Input timing",
        title: `Upcoming growth stage transitions — review N timing`,
        detail: nTimingAlerts.map((a) => `${a.name} (${a.crop}): entering ${a.nextStage} in ~${a.daysToNext} days. ${a.nTiming}`).join("; "),
        fields: nTimingAlerts.map((a) => a.name),
      });
    }

    if (harvestApproaching.length) {
      recs.push({
        priority: "medium",
        category: "Harvest planning",
        title: `${harvestApproaching.length} field${harvestApproaching.length > 1 ? "s" : ""} approaching harvest window`,
        detail: harvestApproaching.map((h) => `${h.name} (${h.crop}): ~${h.daysToHarvest} days to harvest`).join("; ") + ". Begin planning logistics, desiccation timing, and storage.",
        fields: harvestApproaching.map((h) => h.name),
      });
    }

    // Aggregate key risks by crop for fields in active growth
    const riskByCrop = new Map();
    for (const r of riskAlerts) {
      const existing = riskByCrop.get(r.crop) || { fields: [], risks: r.risks };
      existing.fields.push(r.name);
      riskByCrop.set(r.crop, existing);
    }
    for (const [crop, data] of riskByCrop) {
      recs.push({
        priority: "low",
        category: "Crop risk watch",
        title: `${crop}: watch for ${data.risks.slice(0, 3).join(", ")}`,
        detail: `Fields in active growth: ${data.fields.join(", ")}. Key risks for ${crop} at this stage include ${data.risks.join(", ")}.`,
        fields: data.fields,
      });
    }
  }

  recs.sort((a, b) => { const p = { high: 0, medium: 1, low: 2, info: 3 }; return (p[a.priority] ?? 9) - (p[b.priority] ?? 9); });
  return recs;
}

// ─── Inline SVG sparkline for HTML reports ───────────────────────────

export function sparklineSvg(data, { width = 200, height = 36, color = "#104E3F" } = {}) {
  if (!data || data.length < 2) return "";
  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const tRange = tMax - tMin || 1;
  const vMin = Math.min(...data.map((d) => d.ndvi));
  const vMax = Math.max(...data.map((d) => d.ndvi));
  const vRange = vMax - vMin || 0.01;

  const points = data.map((d) => {
    const x = ((d.t - tMin) / tRange) * (width - 4) + 2;
    const y = height - 2 - ((d.ndvi - vMin) / vRange) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const areaPoints = `2,${height - 2} ${points} ${(width - 2).toFixed(1)},${height - 2}`;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <polyline points="${areaPoints}" fill="${color}" fill-opacity="0.08" stroke="none"/>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${data[data.length - 1].t === tMax ? (width - 2).toFixed(1) : "2"}" cy="${(height - 2 - ((data[data.length - 1].ndvi - vMin) / vRange) * (height - 4)).toFixed(1)}" r="2.5" fill="${color}"/>
  </svg>`;
}

// ─── Operations-input correlation ────────────────────────────────────

export function operationsCorrelation(records, scenes, fieldId, start, end) {
  const clean = cleanScenesInRange(scenes, start, end);
  if (clean.length < 2) return null;

  const fieldRecords = records
    .filter((r) => r.fieldId === fieldId && r.date)
    .filter((r) => { const t = new Date(r.date).getTime(); return t >= start.getTime() && t <= end.getTime(); })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  if (!fieldRecords.length) return null;

  const events = fieldRecords.map((r) => {
    const rDate = new Date(r.date).getTime();
    const before = clean.filter((s) => ms(s.scene_datetime) < rDate).slice(-1)[0];
    const after = clean.filter((s) => ms(s.scene_datetime) > rDate && ms(s.scene_datetime) - rDate < 21 * DAY_MS).slice(0, 1)[0];

    let ndviDelta = null;
    if (before && after) ndviDelta = round(after.ndvi_mean - before.ndvi_mean, 3);

    return {
      date: r.date,
      product: r.productId || "Unknown",
      rate: r.rate,
      area: r.area,
      operator: r.operator,
      ndviBefore: before?.ndvi_mean ?? null,
      ndviAfter: after?.ndvi_mean ?? null,
      ndviDelta,
    };
  });

  return { events, fieldRecords: fieldRecords.length };
}

// ─── Utilities ───────────────────────────────────────────────────────

function linearSlope(points) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of points) { sx += p.t; sy += p.v; sxy += p.t * p.v; sxx += p.t * p.t; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return 0;
  return round(((n * sxy - sx * sy) / denom) * DAY_MS, 6);
}

function round(v, decimals) { const f = 10 ** decimals; return Math.round(v * f) / f; }
function avg(arr) { return arr.reduce((a, v) => a + v, 0) / arr.length; }
function isoDay(d) { return d.toISOString().slice(0, 10); }

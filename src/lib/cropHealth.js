/**
 * Crop health analytics for Tilth.
 *
 * The product principle: farmers are not remote-sensing analysts. They
 * shouldn't have to read NDVI curves, decode dB units, or know what
 * SCL is. They want to glance at the dashboard and see "this field is
 * fine, that one needs a look — here's why."
 *
 * This module turns the raw per-field, per-scene NDVI + SAR data into
 * a small, well-defined health record per field:
 *
 *   {
 *     stage:       'bare' | 'emerging' | 'growing' | 'peak'
 *                  | 'senescing' | 'harvested' | 'unknown',
 *     score:       0..100,           // higher is better
 *     trend:       'improving' | 'stable' | 'declining' | 'unknown',
 *     flags:       Array<flagTag>,   // actionable anomaly labels
 *     summary:     string,           // one-sentence plain-English read
 *     confidence:  'low' | 'medium' | 'high',
 *     latest:      ndviRow | null,
 *     metrics: { ndviMean, vhMeanDb, ndviSlope14d, daysSinceScene, ... }
 *   }
 *
 * Determinism is the contract: same input → same output. No date-now
 * inside the analyzer (the caller passes `now` so phenology windows
 * can be unit-tested).
 *
 * Stage detection
 * ---------------
 * Hybrid: NDVI level + slope. Crop type isn't always known so we use
 * universal thresholds tuned for UK arable. Sentinel-1 SAR is used
 * as a tie-breaker when NDVI is cloud-suspect.
 *
 * Score
 * -----
 * Composite, blended:
 *   - 40%  absolute NDVI position vs stage expectation
 *   - 25%  slope (improving = bonus, declining outside of late season = penalty)
 *   - 20%  cohort percentile (vs other fields on the same farm)
 *   - 15%  freshness + confidence (recent clean scenes lift the score)
 *
 * Flags
 * -----
 *   - 'ndvi_dip_7d'         — 7-day NDVI fall ≥ 0.10 outside senescence
 *   - 'below_cohort'        — ≥ 0.10 below cohort median (clean only)
 *   - 'stuck'               — ≤ 0.05 NDVI change over 21 days during emergence/growing
 *   - 'late_emergence'      — past expected emergence date (Apr 1) and NDVI < 0.30
 *   - 'sar_ndvi_divergence' — VH dB rising while NDVI falling (possible lodging
 *                             or canopy gap with stem retained)
 *   - 'cloud_blocked'       — ≥ 50% of recent scenes were cloud-suspect
 *   - 'no_recent_data'      — most recent OK scene > 14 days old
 *
 * Hook
 * ----
 * `useFarmHealth(fields)` composes `useFieldNdviScenes` +
 * `useFieldSarScenes`, runs the analyzer per field, and returns
 *   { health: Map<fieldId, record>, status, suspectByField }
 * so workspaces and the Home page can drop it in directly.
 */

import { useMemo } from "react";

import {
  useFieldNdviScenes,
} from "./tilthSentinel.js";
import { useFieldSarScenes } from "./tilthSar.js";
import {
  cropNdviExpectation,
  phenologyToHealthStage,
} from "./cropPhenology.js";

const DAY_MS = 86_400_000;

// Stage NDVI thresholds (universal, tuned for UK arable). When a crop
// type is known we could refine these per-crop, but the universal
// version works well for the green-amber-red read.
const NDVI_BARE_MAX = 0.20;
const NDVI_EMERGING_MAX = 0.40;
const NDVI_GROWING_MAX = 0.65;
const NDVI_PEAK_MIN = 0.65;

// Senescence detection: NDVI dropped ≥ this fraction below its season
// peak. A crop that hit 0.85 and is now at 0.55 has clearly turned.
const SENESCENCE_FRAC = 0.7;

// "Recent" = lookback window for slope + dip detection (days).
const RECENT_DAYS = 14;
// Stale-data threshold for the no_recent_data flag.
const STALE_DAYS = 14;

// Cohort comparison threshold: a field this far below the farm's
// clean median is flagged.
const COHORT_DEVIATION = 0.10;

// 7-day dip threshold for the ndvi_dip_7d flag, outside senescence.
const SEVEN_DAY_DIP = 0.10;

// Stuck-at-emergence threshold.
const STUCK_DELTA = 0.05;
const STUCK_WINDOW_DAYS = 21;

/**
 * Parse a scene_datetime to ms. Returns 0 on failure.
 */
function ms(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The same multi-signal cloud-suspect detector the Satellite workspace
 * uses, exported here so the analyzer can build clean cohorts.
 *
 * Kept in lockstep with `flagSuspectByTemporalNeighbours` in
 * SatelliteWorkspace.jsx — when one moves, the other should follow.
 */
const SUSPECT_NEIGHBOURS = 3;
const SUSPECT_HAMPEL_K = 3;
const SUSPECT_HARD_FLOOR_NDVI = 0.15;
const SUSPECT_HARD_FLOOR_NEIGHBOUR = 0.4;
const SUSPECT_CLOUD_AWARE_PCT = 30;
const SUSPECT_CLOUD_AWARE_DROP = 0.1;
const SUSPECT_ABSOLUTE_DEVIATION = 0.3;
const SUSPECT_MAD_FLOOR = 0.02;

export function flagSuspectScenes(scenesAsc) {
  const suspect = new Set();
  if (!Array.isArray(scenesAsc) || scenesAsc.length < 3) return suspect;
  for (let i = 0; i < scenesAsc.length; i++) {
    const cur = scenesAsc[i];
    if (!Number.isFinite(cur?.ndvi_mean)) continue;
    const neighbours = [];
    let leftCount = 0;
    let rightCount = 0;
    let li = i - 1;
    let ri = i + 1;
    while (
      (leftCount < SUSPECT_NEIGHBOURS && li >= 0) ||
      (rightCount < SUSPECT_NEIGHBOURS && ri < scenesAsc.length)
    ) {
      if (leftCount < SUSPECT_NEIGHBOURS && li >= 0) {
        const n = scenesAsc[li];
        if (Number.isFinite(n?.ndvi_mean)) {
          neighbours.push(n.ndvi_mean);
          leftCount += 1;
        }
        li -= 1;
      }
      if (rightCount < SUSPECT_NEIGHBOURS && ri < scenesAsc.length) {
        const n = scenesAsc[ri];
        if (Number.isFinite(n?.ndvi_mean)) {
          neighbours.push(n.ndvi_mean);
          rightCount += 1;
        }
        ri += 1;
      }
    }
    if (neighbours.length < 2) continue;
    const sortedN = neighbours.slice().sort((a, b) => a - b);
    const median = sortedN[Math.floor(sortedN.length / 2)];
    const deviation = cur.ndvi_mean - median;
    const absDevs = sortedN
      .map((v) => Math.abs(v - median))
      .sort((a, b) => a - b);
    const mad = absDevs[Math.floor(absDevs.length / 2)];
    const robustSigma = 1.4826 * Math.max(mad, SUSPECT_MAD_FLOOR);

    if (
      cur.ndvi_mean <= SUSPECT_HARD_FLOOR_NDVI &&
      median >= SUSPECT_HARD_FLOOR_NEIGHBOUR
    ) {
      suspect.add(cur.item_id);
      continue;
    }
    if (Math.abs(deviation) > SUSPECT_HAMPEL_K * robustSigma) {
      suspect.add(cur.item_id);
      continue;
    }
    const cloudPct = Number.isFinite(cur?.scene_cloud_pct)
      ? Number(cur.scene_cloud_pct)
      : 0;
    if (
      cloudPct >= SUSPECT_CLOUD_AWARE_PCT &&
      deviation <= -SUSPECT_CLOUD_AWARE_DROP
    ) {
      suspect.add(cur.item_id);
      continue;
    }
    if (Math.abs(deviation) > SUSPECT_ABSOLUTE_DEVIATION) {
      suspect.add(cur.item_id);
    }
  }
  return suspect;
}

/**
 * Detect the broad growth stage from a clean ascending NDVI series.
 * Falls back to 'unknown' when there isn't enough data.
 */
function detectStage(cleanedAsc) {
  if (!cleanedAsc.length) return { stage: "unknown", peakNdvi: null };
  const latest = cleanedAsc[cleanedAsc.length - 1];
  const v = latest.ndvi_mean;
  let peak = -Infinity;
  for (const s of cleanedAsc) {
    if (Number.isFinite(s.ndvi_mean) && s.ndvi_mean > peak) peak = s.ndvi_mean;
  }
  // Senescence: latest NDVI is meaningfully below the peak AND the peak
  // was at least 0.5 (otherwise we just saw a noisy emergence series).
  if (peak >= 0.5 && v <= peak * SENESCENCE_FRAC && v < NDVI_GROWING_MAX) {
    if (v < NDVI_BARE_MAX) return { stage: "harvested", peakNdvi: peak };
    return { stage: "senescing", peakNdvi: peak };
  }
  if (v <= NDVI_BARE_MAX) return { stage: "bare", peakNdvi: peak };
  if (v <= NDVI_EMERGING_MAX) return { stage: "emerging", peakNdvi: peak };
  if (v < NDVI_PEAK_MIN) return { stage: "growing", peakNdvi: peak };
  return { stage: "peak", peakNdvi: peak };
}

/**
 * Linear regression slope (NDVI per day) over the points within the
 * last `windowDays` days. Returns null if fewer than 2 points.
 */
function recentSlope(cleanedAsc, now, windowDays) {
  const cutoff = now - windowDays * DAY_MS;
  const pts = cleanedAsc
    .filter((s) => ms(s.scene_datetime) >= cutoff)
    .map((s) => ({ x: (ms(s.scene_datetime) - cutoff) / DAY_MS, y: s.ndvi_mean }));
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * The expected NDVI window for a given stage. Values are deliberately
 * loose — a healthy emerging crop can be 0.25-0.45 depending on
 * canopy uniformity.
 */
function stageExpectedNdvi(stage) {
  switch (stage) {
    case "bare":
      return [0.05, 0.20];
    case "emerging":
      return [0.25, 0.45];
    case "growing":
      return [0.40, 0.70];
    case "peak":
      return [0.65, 0.92];
    case "senescing":
      return [0.25, 0.55];
    case "harvested":
      return [0.05, 0.25];
    default:
      return [0.30, 0.70];
  }
}

/**
 * Bound x into [lo, hi].
 */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Compute the per-field health record from one field's scene list.
 *
 * @param {object} ctx
 * @param {Array} ctx.ndviScenes — newest-first array from `useFieldNdviScenes`
 * @param {Array} ctx.sarScenes  — newest-first array from `useFieldSarScenes`
 * @param {number} ctx.cohortMedian — clean cohort median NDVI for the farm
 * @param {number} ctx.cohortStdev  — clean cohort std-dev (for percentile)
 * @param {number} ctx.now          — `Date.now()`-style ms timestamp
 *
 * Returns the health record described at the top of this file.
 */
export function computeFieldHealth({
  ndviScenes = [],
  sarScenes = [],
  cohortMedian = null,
  cohortStdev = null,
  now = Date.now(),
  cropName = null,
  plantingDate = null,
} = {}) {
  // Ascending, OK-only NDVI series.
  const ndviAsc = (ndviScenes || [])
    .filter(
      (s) =>
        s &&
        s.status === "ok" &&
        Number.isFinite(s.ndvi_mean) &&
        Number.isFinite(s.valid_pixel_count) &&
        s.valid_pixel_count > 0
    )
    .slice()
    .sort((a, b) => ms(a.scene_datetime) - ms(b.scene_datetime));
  const suspect = flagSuspectScenes(ndviAsc);
  const cleanAsc = ndviAsc.filter((s) => !suspect.has(s.item_id));

  const latest = cleanAsc[cleanAsc.length - 1] || null;
  const v = latest?.ndvi_mean ?? null;
  const latestT = latest ? ms(latest.scene_datetime) : 0;
  const daysSinceScene = latestT
    ? Math.max(0, Math.round((now - latestT) / DAY_MS))
    : null;

  const cropExpectation = cropNdviExpectation(cropName, plantingDate, now);

  // Use crop-aware stage if available; otherwise fall back to universal detection.
  let stage, peakNdvi;
  if (cropExpectation) {
    stage = phenologyToHealthStage(cropExpectation.stageName);
    peakNdvi = null;
    for (const s of cleanAsc) {
      if (Number.isFinite(s.ndvi_mean) && (peakNdvi == null || s.ndvi_mean > peakNdvi)) peakNdvi = s.ndvi_mean;
    }
  } else {
    ({ stage, peakNdvi } = detectStage(cleanAsc, now));
  }
  const slope14d = recentSlope(cleanAsc, now, RECENT_DAYS);

  // Trend label.
  let trend = "unknown";
  if (slope14d != null) {
    if (slope14d > 0.005) trend = "improving";
    else if (slope14d < -0.005) trend = "declining";
    else trend = "stable";
  }

  // Flags.
  const flags = [];

  // 7-day dip — find the closest-to-7d-ago scene and compare.
  if (cleanAsc.length >= 2 && stage !== "senescing" && stage !== "harvested") {
    const target = now - 7 * DAY_MS;
    let best = null;
    let bestDt = Infinity;
    for (const s of cleanAsc) {
      const dt = Math.abs(ms(s.scene_datetime) - target);
      if (dt < bestDt && dt < 5 * DAY_MS) {
        bestDt = dt;
        best = s;
      }
    }
    if (best && Number.isFinite(v) && Number.isFinite(best.ndvi_mean)) {
      if (best.ndvi_mean - v >= SEVEN_DAY_DIP) flags.push("ndvi_dip_7d");
    }
  }

  // Below cohort.
  if (
    Number.isFinite(v) &&
    Number.isFinite(cohortMedian) &&
    v - cohortMedian <= -COHORT_DEVIATION
  ) {
    flags.push("below_cohort");
  }

  // Stuck — emergence/growing window with negligible change over 21d.
  if (
    (stage === "emerging" || stage === "growing") &&
    cleanAsc.length >= 3 &&
    Number.isFinite(v)
  ) {
    const target = now - STUCK_WINDOW_DAYS * DAY_MS;
    let earliest = null;
    for (const s of cleanAsc) {
      if (ms(s.scene_datetime) >= target) {
        earliest = earliest || s;
        break;
      }
    }
    if (earliest && Math.abs(v - earliest.ndvi_mean) < STUCK_DELTA) {
      flags.push("stuck");
    }
  }

  // Late emergence — crop-aware if planting data is known, otherwise
  // fall back to the universal Apr 1 – May 15 check.
  if (Number.isFinite(v) && v < 0.30) {
    if (cropExpectation && cropExpectation.stageName !== "drilling" && cropExpectation.isLate) {
      flags.push("late_emergence");
    } else if (!cropExpectation) {
      const d = new Date(now);
      const apr1 = new Date(d.getFullYear(), 3, 1).getTime();
      const may15 = new Date(d.getFullYear(), 4, 15).getTime();
      if (now >= apr1 && now <= may15) flags.push("late_emergence");
    }
  }

  // Crop-specific: NDVI well below expected range for the current growth stage.
  if (cropExpectation && Number.isFinite(v) && v < cropExpectation.lo - 0.10 && stage !== "harvested" && stage !== "bare") {
    flags.push("below_expected_for_stage");
  }

  // SAR vs NDVI divergence — VH rising ≥ 1 dB while NDVI dropping
  // ≥ 0.05 over the same ~14d window. Indicates either lodging
  // (canopy mass remains, biomass volume goes up structurally) or
  // a canopy gap with retained stem.
  if (Number.isFinite(slope14d) && slope14d < -0.005) {
    const sarAsc = (sarScenes || [])
      .filter(
        (s) =>
          s &&
          s.status === "ok" &&
          Number.isFinite(s.vh_mean_db) &&
          (s.valid_pixel_count ?? 0) > 0
      )
      .slice()
      .sort((a, b) => ms(a.scene_datetime) - ms(b.scene_datetime));
    if (sarAsc.length >= 2) {
      const cutoff = now - RECENT_DAYS * DAY_MS;
      const recentSar = sarAsc.filter(
        (s) => ms(s.scene_datetime) >= cutoff
      );
      if (recentSar.length >= 2) {
        const first = recentSar[0].vh_mean_db;
        const last = recentSar[recentSar.length - 1].vh_mean_db;
        const dDb = last - first;
        const ndviDelta = -slope14d * RECENT_DAYS;
        if (dDb > 1 && ndviDelta > 0.05) flags.push("sar_ndvi_divergence");
      }
    }
  }

  // Cloud blocked — most recent ~30 days of scenes are mostly suspect.
  const recentNdvi30 = ndviAsc.filter(
    (s) => ms(s.scene_datetime) >= now - 30 * DAY_MS
  );
  if (recentNdvi30.length >= 4) {
    const suspectCount = recentNdvi30.filter((s) => suspect.has(s.item_id)).length;
    if (suspectCount / recentNdvi30.length >= 0.5) flags.push("cloud_blocked");
  }

  // No recent data.
  if (daysSinceScene == null || daysSinceScene > STALE_DAYS) {
    flags.push("no_recent_data");
  }

  // Water stress — NDMI below threshold during active growth.
  if (
    latest &&
    Number.isFinite(latest.ndmi_mean) &&
    latest.ndmi_mean < -0.1 &&
    (stage === "growing" || stage === "peak")
  ) {
    flags.push("water_stress");
  }

  // Score components.
  // 1. Absolute NDVI vs stage expectation — crop-specific when available.
  let absoluteScore = 50;
  if (Number.isFinite(v)) {
    const lo = cropExpectation ? cropExpectation.lo : stageExpectedNdvi(stage)[0];
    const hi = cropExpectation ? cropExpectation.hi : stageExpectedNdvi(stage)[1];
    if (v < lo) absoluteScore = 50 - (lo - v) * 200;
    else if (v > hi) absoluteScore = 95;
    else absoluteScore = 50 + ((v - lo) / Math.max(1e-3, hi - lo)) * 50;
    absoluteScore = clamp(absoluteScore, 0, 100);
  }

  // 2. Slope.
  let slopeScore = 50;
  if (Number.isFinite(slope14d)) {
    if (stage === "senescing" || stage === "harvested") {
      // Decline is expected here — we just don't reward it heavily.
      slopeScore = 50;
    } else if (stage === "peak") {
      // Stable near peak is good; a sudden drop is bad.
      slopeScore = clamp(50 + slope14d * 1500, 0, 100);
    } else {
      // emerging / growing — improving is great.
      slopeScore = clamp(50 + slope14d * 2000, 0, 100);
    }
  }

  // 3. Cohort percentile (vs farm median).
  let cohortScore = 50;
  if (Number.isFinite(v) && Number.isFinite(cohortMedian)) {
    if (Number.isFinite(cohortStdev) && cohortStdev > 1e-3) {
      const z = (v - cohortMedian) / cohortStdev;
      cohortScore = clamp(50 + z * 25, 0, 100); // ~one σ ~= 25 points
    } else {
      cohortScore = clamp(50 + (v - cohortMedian) * 200, 0, 100);
    }
  }

  // 4. Freshness.
  let freshScore = 50;
  if (daysSinceScene == null) freshScore = 25;
  else if (daysSinceScene <= 5) freshScore = 90;
  else if (daysSinceScene <= 10) freshScore = 75;
  else if (daysSinceScene <= 20) freshScore = 55;
  else freshScore = 30;

  let score = Math.round(
    absoluteScore * 0.4 +
      slopeScore * 0.25 +
      cohortScore * 0.2 +
      freshScore * 0.15
  );
  // Knock the score down for any actionable flag — a "great absolute
  // NDVI" field with a 7-day dip should not read green.
  if (flags.includes("ndvi_dip_7d")) score -= 12;
  if (flags.includes("below_cohort")) score -= 8;
  if (flags.includes("stuck")) score -= 10;
  if (flags.includes("late_emergence")) score -= 15;
  if (flags.includes("sar_ndvi_divergence")) score -= 8;
  if (flags.includes("no_recent_data")) score -= 5;
  if (flags.includes("below_expected_for_stage")) score -= 12;
  score = clamp(score, 0, 100);

  // Confidence.
  const cleanCount = cleanAsc.length;
  let confidence = "low";
  if (cleanCount >= 6 && (daysSinceScene ?? 99) <= 14) confidence = "high";
  else if (cleanCount >= 3 && (daysSinceScene ?? 99) <= 21) confidence = "medium";

  // Plain-English summary. Order of precedence: most actionable flag
  // first, then stage + trend.
  const cropLabel = cropExpectation ? `${cropName} (${cropExpectation.stageName})` : null;
  const dspDays = cropExpectation?.daysSincePlanting ?? null;

  const summary = (() => {
    if (flags.includes("below_expected_for_stage") && cropLabel)
      return `${cropName} is behind where it should be at ${cropExpectation.stageName} stage — NDVI below expected range. Check for establishment issues or stress.`;
    if (flags.includes("late_emergence"))
      return cropLabel
        ? `${cropName} hasn't established on schedule — past expected emergence and NDVI still low.`
        : "Crop hasn't established — past expected emergence and NDVI still low.";
    if (flags.includes("stuck"))
      return cropLabel
        ? `${cropName} growth has stalled during ${cropExpectation.stageName}. Worth a walk-over.`
        : "Growth has stalled over the past three weeks. Worth a walk-over.";
    if (flags.includes("ndvi_dip_7d"))
      return "Sudden drop in NDVI over the last week — check for stress, lodging or cloud.";
    if (flags.includes("sar_ndvi_divergence"))
      return "Radar disagrees with NDVI — possible lodging or canopy break.";
    if (flags.includes("water_stress"))
      return "Moisture index (NDMI) suggests water stress — check soil moisture and irrigation.";
    if (flags.includes("below_cohort"))
      return "Trailing the rest of the farm. Compare with neighbours for context.";
    if (flags.includes("cloud_blocked"))
      return "Recent NDVI is mostly cloud-suspect. Use the radar workspace for a clean reading.";
    if (flags.includes("no_recent_data") && stage !== "harvested")
      return "No fresh imagery in two weeks. Auto-refresh has been kicked off.";
    if (cropLabel) {
      switch (stage) {
        case "bare":
          return `${cropName}: recently drilled, waiting for emergence.`;
        case "emerging":
          return trend === "improving"
            ? `${cropName} establishing well through ${cropExpectation.stageName}.`
            : `${cropName} is emerging (${cropExpectation.stageName}).`;
        case "growing":
          return trend === "improving"
            ? `${cropName}: healthy canopy build during ${cropExpectation.stageName}, on track.`
            : trend === "declining"
              ? `${cropName}: canopy going backwards during ${cropExpectation.stageName} — investigate.`
              : `${cropName}: ${cropExpectation.stageName}, holding steady.`;
        case "peak":
          return trend === "declining"
            ? `${cropName}: past peak, beginning ${cropExpectation.stageName}.`
            : `${cropName}: at peak canopy (${cropExpectation.stageName}).`;
        case "senescing":
          return `${cropName}: ripening down (${cropExpectation.stageName}).`;
        case "harvested":
          return `${cropName}: harvested or post-senescence.`;
        default:
          return `${cropName}: ${cropExpectation.stageName}, ${dspDays != null ? `${dspDays} days since planting` : "monitoring"}.`;
      }
    }
    switch (stage) {
      case "bare":
        return "Bare ground. No active crop signal.";
      case "emerging":
        return trend === "improving"
          ? "Establishing well — NDVI rising into early canopy."
          : "Crop is emerging.";
      case "growing":
        return trend === "improving"
          ? "Healthy canopy build, on track."
          : trend === "declining"
            ? "Canopy is going backwards mid-season — keep an eye."
            : "Mid-season canopy, holding steady.";
      case "peak":
        return trend === "declining"
          ? "Past peak, beginning to senesce."
          : "Crop is at peak canopy.";
      case "senescing":
        return "Senescing as expected — crop is ripening down.";
      case "harvested":
        return "Field has been harvested or is post-senescence.";
      default:
        return cleanCount === 0
          ? "Not enough clean imagery yet — auto-refresh has been kicked off."
          : "Crop status not yet classifiable.";
    }
  })();

  return {
    stage,
    score,
    trend,
    flags,
    summary,
    confidence,
    latest,
    cropContext: cropExpectation ? {
      cropName,
      stageName: cropExpectation.stageName,
      daysSincePlanting: cropExpectation.daysSincePlanting,
      expectedNdvi: [cropExpectation.lo, cropExpectation.hi],
      stageProgress: cropExpectation.progress,
      isLate: cropExpectation.isLate,
      stageIndex: cropExpectation.stageIndex,
      totalStages: cropExpectation.totalStages,
    } : null,
    metrics: {
      ndviMean: Number.isFinite(v) ? v : null,
      ndviSlope14d: slope14d,
      peakNdvi: Number.isFinite(peakNdvi) ? peakNdvi : null,
      daysSinceScene,
      cohortDelta:
        Number.isFinite(v) && Number.isFinite(cohortMedian)
          ? v - cohortMedian
          : null,
      cleanSceneCount: cleanCount,
      vhMeanDb: (() => {
        const vh = (sarScenes || []).find(
          (s) =>
            s &&
            s.status === "ok" &&
            Number.isFinite(s.vh_mean_db) &&
            (s.valid_pixel_count ?? 0) > 0
        );
        return vh?.vh_mean_db ?? null;
      })(),
      eviMean: latest?.evi_mean ?? null,
      ndwiMean: latest?.ndwi_mean ?? null,
      ndmiMean: latest?.ndmi_mean ?? null,
    },
  };
}

/**
 * Compute farm-level cohort baseline from a scenes-by-field map.
 * Returns { median, stdev, count } over the latest non-suspect scene
 * per field.
 */
export function computeFarmCohort(scenesByField, now = Date.now()) {
  const latestPerField = [];
  for (const [, arr] of scenesByField) {
    const ascending = (arr || [])
      .filter(
        (s) =>
          s &&
          s.status === "ok" &&
          Number.isFinite(s.ndvi_mean) &&
          (s.valid_pixel_count ?? 0) > 0
      )
      .slice()
      .sort((a, b) => ms(a.scene_datetime) - ms(b.scene_datetime));
    const suspect = flagSuspectScenes(ascending);
    const clean = ascending.filter((s) => !suspect.has(s.item_id));
    const newest = clean[clean.length - 1] || null;
    if (newest && (now - ms(newest.scene_datetime)) <= 21 * DAY_MS) {
      latestPerField.push(newest.ndvi_mean);
    }
  }
  if (!latestPerField.length) return { median: null, stdev: null, count: 0 };
  const sorted = latestPerField.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance =
    sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sorted.length;
  return {
    median,
    stdev: Math.sqrt(variance),
    count: sorted.length,
  };
}

/**
 * Friendly labels for the React side. Centralised so the workspace and
 * Home page render the same strings.
 */
export const STAGE_LABELS = {
  bare: "Bare",
  emerging: "Emerging",
  growing: "Growing",
  peak: "Peak canopy",
  senescing: "Senescing",
  harvested: "Harvested",
  unknown: "Unclassified",
};

export const FLAG_LABELS = {
  ndvi_dip_7d: "7-day NDVI drop",
  below_cohort: "Behind the farm",
  stuck: "Growth stalled",
  late_emergence: "Late to emerge",
  sar_ndvi_divergence: "Radar disagrees with NDVI",
  cloud_blocked: "Cloud-blocked imagery",
  no_recent_data: "No recent imagery",
  water_stress: "Possible water stress",
  below_expected_for_stage: "Below expected for growth stage",
};

/**
 * Score → green/amber/red bucket. Used by the choropleth and the pill
 * tone in the workspace.
 */
export function scoreTone(score) {
  if (!Number.isFinite(score)) return "neutral";
  if (score >= 70) return "ok";
  if (score >= 45) return "warn";
  return "danger";
}

/**
 * Score → display color (mirrors scoreTone, but as raw hex for SVG /
 * choropleth use).
 */
export function scoreColor(score) {
  if (!Number.isFinite(score)) return "#cfd9cf";
  if (score >= 70) return "#3F7A4A"; // forest green — healthy
  if (score >= 45) return "#C07C12"; // amber — needs attention
  return "#B4412E"; // red — critical
}

/**
 * The React hook that workspaces and the Home page consume. Composes
 * the NDVI + SAR Realtime hooks and computes a per-field health record
 * for every field. Memoised on the underlying scene Maps so it doesn't
 * recompute on every render.
 */
/**
 * @param {Array} fields
 * @param {Object} [plantingsMap] — { fieldId: [ { crop, plantingDate, ... }, ... ] }
 *   from tilthStore.loadPlantings(). Pass it in so the hook can use crop-aware analysis.
 */
export function useFarmHealth(fields, plantingsMap) {
  const fieldIds = useMemo(
    () =>
      (fields || [])
        .filter((f) => f && Array.isArray(f.boundary) && f.boundary.length >= 3)
        .map((f) => f.id),
    [fields]
  );

  const ndvi = useFieldNdviScenes(fieldIds);
  const sar = useFieldSarScenes(fieldIds);

  const result = useMemo(() => {
    const now = Date.now();
    const cohort = computeFarmCohort(ndvi.scenes, now);
    const health = new Map();
    for (const f of fields || []) {
      if (!f?.id) continue;
      if (!Array.isArray(f.boundary) || f.boundary.length < 3) continue;
      const ndviScenes = ndvi.scenes.get(f.id) || [];
      const sarScenes = sar.scenes.get(f.id) || [];
      const planting = plantingsMap?.[f.id]?.[0] || null;
      const rec = computeFieldHealth({
        ndviScenes,
        sarScenes,
        cohortMedian: cohort.median,
        cohortStdev: cohort.stdev,
        now,
        cropName: planting?.crop || null,
        plantingDate: planting?.plantingDate || null,
      });
      health.set(f.id, rec);
    }
    return {
      health,
      cohort,
      status: ndvi.status === "ready" || sar.status === "ready"
        ? "ready"
        : ndvi.status === "error" || sar.status === "error"
          ? "error"
          : ndvi.status === "no-supabase"
            ? "no-supabase"
            : "loading",
      ndvi,
      sar,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ndvi.scenes, sar.scenes, ndvi.status, sar.status, fields, plantingsMap]);

  return result;
}

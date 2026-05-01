import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  EmptyState,
  Kicker,
  Pill,
  Row,
  SectionHeader,
  Subpanel,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { FieldMapThree2D } from "../FieldMapThree2D.jsx";
import { ringCentroid } from "../geoPointInPolygon.js";
import {
  autoRefreshStaleFields,
  buildNdviTileUrlFn,
  triggerNdviRefresh,
  useFieldNdviScenes,
  useSentinelQueueStatus,
} from "../../lib/tilthSentinel.js";

/**
 * Sentinel-2 NDVI workspace — wired to Microsoft Planetary Computer via
 * the Tilth API. Each saved field gets:
 *   - a per-scene NDVI mean curve over the last lookback window,
 *   - a choropleth painted onto the field polygon at the active scene,
 *   - an optional NDVI raster tile overlay covering the whole field bbox.
 *
 * Data comes from `tilth_field_ndvi` (populated by the Tilth API ingest
 * queue against MPC titiler `/item/statistics`). The workspace itself
 * only reads the table — refresh is a one-click background trigger.
 */

// Pinned across the whole workspace so the polygon colour ramp matches
// the Sentinel raster overlay exactly. These mirror NDVI_DEFAULT_RESCALE
// + NDVI_DEFAULT_COLORMAP in tilth-api/sentinel/mpcClient.mjs — keep
// them in sync if you change the titiler defaults.
const NDVI_RAMP_MIN = 0.0;
const NDVI_RAMP_MAX = 0.9;
const NDVI_RESCALE_PARAM = `${NDVI_RAMP_MIN.toFixed(1)},${NDVI_RAMP_MAX.toFixed(1)}`;
const NDVI_COLORMAP = "rdylgn";

// 3-stop red → yellow → green ramp matching matplotlib's RdYlGn used by
// titiler. Lerps in linear sRGB; close enough for at-a-glance choropleth.
const NDVI_RAMP_STOPS = [
  { t: 0.0, rgb: [165, 0, 38] }, // bare / stressed (low NDVI, often <0.2)
  { t: 0.5, rgb: [255, 255, 191] }, // mid (around 0.45)
  { t: 1.0, rgb: [0, 104, 55] }, // healthy canopy (>0.75 → dark green)
];

function ndviColor(v) {
  if (!Number.isFinite(v)) return "#cfd9cf";
  const t = Math.max(0, Math.min(1, (v - NDVI_RAMP_MIN) / (NDVI_RAMP_MAX - NDVI_RAMP_MIN)));
  let lo = NDVI_RAMP_STOPS[0];
  let hi = NDVI_RAMP_STOPS[NDVI_RAMP_STOPS.length - 1];
  for (let i = 0; i < NDVI_RAMP_STOPS.length - 1; i++) {
    if (t >= NDVI_RAMP_STOPS[i].t && t <= NDVI_RAMP_STOPS[i + 1].t) {
      lo = NDVI_RAMP_STOPS[i];
      hi = NDVI_RAMP_STOPS[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, hi.t - lo.t);
  const k = (t - lo.t) / span;
  const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k);
  const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k);
  const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

function fmtNdvi(v) {
  return Number.isFinite(v) ? v.toFixed(2) : "—";
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffDays = Math.round((Date.now() - t) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 56) return `${Math.round(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.round(diffDays / 30)}mo ago`;
  return `${Math.round(diffDays / 365)}y ago`;
}

// Multi-signal cloud-contamination detector parameters. The previous
// version was a single fixed deviation threshold which missed the
// "partly cloudy, just below threshold" cases (e.g. 28 March where
// cloud over the field dropped NDVI by 0.18 from its temporal
// neighbours — close to suspicious but a step under the 0.25 cutoff,
// even though the scene was visibly cloudy in the SCENE CLOUD pill).
//
// We now combine four checks; ANY one triggers a flag:
//
//   1. Hard floor — NDVI ≤ 0.15 while neighbours' median ≥ 0.40.
//      A bright field can't physically drop to bare-soil NDVI in 5
//      days. This is almost always thick cloud the SCL labelled as
//      vegetation (yes, it happens).
//
//   2. Hampel filter — robust |x - median| / (1.4826 × MAD) > 3.
//      Median absolute deviation gives a per-field sense of "normal"
//      week-to-week variance. During stable canopy small deviations
//      are flagged; during emergence/senescence larger swings are
//      tolerated. The 1.4826 factor turns MAD into a robust σ
//      estimate equivalent to Gaussian σ.
//
//   3. Cloud-aware downward shift — scene_cloud_pct ≥ 30% AND NDVI
//      ≥ 0.10 below neighbour median. Catches "partly cloudy, SCL
//      missed it" cases that don't trip the absolute threshold.
//
//   4. Absolute fallback — |deviation| > 0.30. Catches anything the
//      adaptive checks would let through.
const SUSPECT_NEIGHBOURS = 3;
const SUSPECT_HAMPEL_K = 3;
const SUSPECT_HARD_FLOOR_NDVI = 0.15;
const SUSPECT_HARD_FLOOR_NEIGHBOUR = 0.4;
const SUSPECT_CLOUD_AWARE_PCT = 30;
const SUSPECT_CLOUD_AWARE_DROP = 0.1;
const SUSPECT_ABSOLUTE_DEVIATION = 0.3;
const SUSPECT_MAD_FLOOR = 0.02; // never call MAD<0.02 — too sensitive

/**
 * Flag scenes that are almost certainly cloud-contaminated. Uses four
 * complementary heuristics so a single conservative threshold never
 * has to do all the work; see SUSPECT_* constants above for rationale.
 *
 * Returns a Set of item_ids to flag. Only run on already-filtered
 * "ok + valid pixels" scenes, sorted ascending by datetime.
 */
function flagSuspectByTemporalNeighbours(scenesAsc) {
  const suspect = new Set();
  if (!Array.isArray(scenesAsc) || scenesAsc.length < 3) return suspect;
  for (let i = 0; i < scenesAsc.length; i++) {
    const cur = scenesAsc[i];
    if (!Number.isFinite(cur?.ndvi_mean)) continue;
    const neighbours = [];
    for (let j = 1; j <= SUSPECT_NEIGHBOURS && i - j >= 0; j++) {
      const v = scenesAsc[i - j]?.ndvi_mean;
      if (Number.isFinite(v)) neighbours.push(v);
    }
    for (let j = 1; j <= SUSPECT_NEIGHBOURS && i + j < scenesAsc.length; j++) {
      const v = scenesAsc[i + j]?.ndvi_mean;
      if (Number.isFinite(v)) neighbours.push(v);
    }
    // Need at least 2 neighbours to call a deviation meaningful;
    // otherwise an end-of-series scene gets flagged just because it's
    // alone.
    if (neighbours.length < 2) continue;

    const sortedN = neighbours.slice().sort((a, b) => a - b);
    const median = sortedN[Math.floor(sortedN.length / 2)];
    const deviation = cur.ndvi_mean - median;
    const absDevs = sortedN
      .map((v) => Math.abs(v - median))
      .sort((a, b) => a - b);
    const mad = absDevs[Math.floor(absDevs.length / 2)];
    const robustSigma = 1.4826 * Math.max(mad, SUSPECT_MAD_FLOOR);

    // 1. Hard floor — NDVI collapsed against vigorous neighbours.
    if (
      cur.ndvi_mean <= SUSPECT_HARD_FLOOR_NDVI &&
      median >= SUSPECT_HARD_FLOOR_NEIGHBOUR
    ) {
      suspect.add(cur.item_id);
      continue;
    }

    // 2. Hampel test — adaptive to local variance.
    if (Math.abs(deviation) > SUSPECT_HAMPEL_K * robustSigma) {
      suspect.add(cur.item_id);
      continue;
    }

    // 3. Cloud-aware downward shift — partial cloud cover.
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

    // 4. Absolute fallback.
    if (Math.abs(deviation) > SUSPECT_ABSOLUTE_DEVIATION) {
      suspect.add(cur.item_id);
    }
  }
  return suspect;
}

// --- Phenology metrics --------------------------------------------------

const DAY_MS = 86_400_000;
const PHENOLOGY_WINDOW_DAYS = 365;
const PHENOLOGY_EMERGENCE_THRESHOLD = 0.3;
const PHENOLOGY_SENESCENCE_FRACTION = 0.75;

/**
 * Compute one season's worth of phenology metrics from a cleaned (no
 * suspect) NDVI time series for a single field. Operates over the most
 * recent `windowDays` so phase boundaries don't smear across multi-year
 * histories.
 *
 * Metrics:
 *   - peak: { value, iso } — max NDVI in window
 *   - emergence: first scene where NDVI rose through 0.3 and stayed
 *     above 0.3 for the next ≥2 scenes (filters one-off spikes).
 *   - senescence: first scene after the peak where NDVI dropped below
 *     75% of peak and stayed below for the next ≥2 scenes.
 *   - daysToPeak: emergence → peak (null if either missing)
 *   - daysSincePeak: peak → today (null if peak missing)
 *   - seasonAUC: Σ NDVI × days_between, integrated emergence → today
 *     (or → senescence if past it). Strong proxy for cumulative
 *     biomass / yield.
 *   - meanNdvi: simple mean of in-window scenes.
 */
function computePhenology(scenesAsc, { windowDays = PHENOLOGY_WINDOW_DAYS } = {}) {
  const now = Date.now();
  const cutoff = now - windowDays * DAY_MS;
  const series = (scenesAsc || [])
    .filter(
      (s) =>
        s.status === "ok" &&
        Number.isFinite(s.ndvi_mean) &&
        (s.valid_pixel_count ?? 0) > 0 &&
        new Date(s.scene_datetime).getTime() >= cutoff
    )
    .map((s) => ({
      t: new Date(s.scene_datetime).getTime(),
      v: s.ndvi_mean,
      iso: s.scene_datetime,
    }))
    .sort((a, b) => a.t - b.t);
  if (series.length < 4) {
    return {
      ok: false,
      reason: "insufficient-data",
      sceneCount: series.length,
    };
  }

  // Peak
  let peakIdx = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].v > series[peakIdx].v) peakIdx = i;
  }
  const peak = series[peakIdx];

  // Emergence: first 3-scene run where every scene ≥ 0.3, prior to peak.
  let emergenceIdx = -1;
  for (let i = 0; i <= peakIdx && i + 2 < series.length; i++) {
    if (
      series[i].v >= PHENOLOGY_EMERGENCE_THRESHOLD &&
      series[i + 1].v >= PHENOLOGY_EMERGENCE_THRESHOLD &&
      series[i + 2].v >= PHENOLOGY_EMERGENCE_THRESHOLD
    ) {
      emergenceIdx = i;
      break;
    }
  }
  const emergence = emergenceIdx >= 0 ? series[emergenceIdx] : null;

  // Senescence: first 3-scene run after peak where every scene below
  // 75% × peak.
  const senCutoff = peak.v * PHENOLOGY_SENESCENCE_FRACTION;
  let senescenceIdx = -1;
  for (let i = peakIdx + 1; i + 2 < series.length; i++) {
    if (
      series[i].v < senCutoff &&
      series[i + 1].v < senCutoff &&
      series[i + 2].v < senCutoff
    ) {
      senescenceIdx = i;
      break;
    }
  }
  const senescence = senescenceIdx >= 0 ? series[senescenceIdx] : null;

  // AUC from emergence to (senescence ?? now). Trapezoidal integration
  // in NDVI × days. Caps integration at 365 days to avoid carrying a
  // partial second season.
  let auc = null;
  if (emergence) {
    const startT = emergence.t;
    const endT = senescence ? senescence.t : Math.min(now, startT + 365 * DAY_MS);
    let acc = 0;
    for (let i = 0; i + 1 < series.length; i++) {
      const a = series[i];
      const b = series[i + 1];
      if (b.t < startT || a.t > endT) continue;
      const x0 = Math.max(a.t, startT);
      const x1 = Math.min(b.t, endT);
      if (x1 <= x0) continue;
      const dt = (x1 - x0) / DAY_MS;
      // Linear interp at slice boundaries.
      const span = (b.t - a.t) || 1;
      const va = a.v + ((x0 - a.t) / span) * (b.v - a.v);
      const vb = a.v + ((x1 - a.t) / span) * (b.v - a.v);
      acc += ((va + vb) / 2) * dt;
    }
    auc = acc;
  }

  const daysBetween = (a, b) =>
    Number.isFinite(a) && Number.isFinite(b)
      ? Math.round((b - a) / DAY_MS)
      : null;

  const meanNdvi =
    series.reduce((s, p) => s + p.v, 0) / Math.max(1, series.length);

  return {
    ok: true,
    sceneCount: series.length,
    windowDays,
    peak,
    emergence,
    senescence,
    daysToPeak: emergence ? daysBetween(emergence.t, peak.t) : null,
    daysSincePeak: daysBetween(peak.t, now),
    daysSinceEmergence: emergence ? daysBetween(emergence.t, now) : null,
    seasonAUC: auc,
    meanNdvi,
    latest: series[series.length - 1],
  };
}

/**
 * Per-field NDVI mean curve. Renders this-year scenes as the primary
 * line with one dot per Sentinel-2 scene, the active scene as an
 * orange marker, and suspect (cloud-contaminated) scenes as muted grey
 * dots excluded from the connecting line.
 *
 * If `showYearOverYear` and the cached series extends past 365 days,
 * the previous year's track is rendered as a dashed slate line shifted
 * forward by 365 days so it sits aligned by week-of-year against the
 * current track.
 */
const YEAR_MS = 365 * 86_400_000;

function NdviCurve({ scenes, activeIso, suspectIds, showYearOverYear = true }) {
  const allPoints = useMemo(() => {
    const suspect = suspectIds || new Set();
    const arr = (scenes || [])
      .filter(
        (s) =>
          s.status === "ok" &&
          Number.isFinite(s.ndvi_mean) &&
          Number.isFinite(s.valid_pixel_count) &&
          s.valid_pixel_count > 0
      )
      .map((s) => ({
        t: new Date(s.scene_datetime).getTime(),
        v: Math.max(NDVI_RAMP_MIN, Math.min(NDVI_RAMP_MAX, s.ndvi_mean)),
        iso: s.scene_datetime,
        id: s.item_id,
        suspect: suspect.has(s.item_id),
      }))
      .sort((a, b) => a.t - b.t);
    return arr;
  }, [scenes, suspectIds]);

  // Split into this-year (≤365d) and last-year (>365d) tracks. The
  // last-year track is rendered shifted forward by 365 days so the
  // user can read week-aligned comparisons (e.g. "last year on this
  // week of April was 0.65").
  const now = Date.now();
  const cutoff = now - YEAR_MS;
  const thisYear = allPoints.filter((p) => p.t >= cutoff);
  const lastYearShifted = showYearOverYear
    ? allPoints
        .filter((p) => p.t < cutoff && p.t >= cutoff - YEAR_MS)
        .map((p) => ({ ...p, t: p.t + YEAR_MS, isPrev: true }))
    : [];

  const points = thisYear;

  const w = 560;
  const h = 110;
  const padX = 14;
  const padY = 10;

  if (points.length === 0 && lastYearShifted.length === 0) {
    return (
      <div
        style={{
          height: h,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: fonts.mono,
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.muted,
          background: brand.bgSection,
          border: `1px solid ${brand.border}`,
          borderRadius: radius.base,
        }}
      >
        No usable scenes yet
      </div>
    );
  }

  // Domain from the union so previous-year track is fully visible too.
  const allTs = [...points.map((p) => p.t), ...lastYearShifted.map((p) => p.t)];
  const t0 = allTs.length ? Math.min(...allTs) : now - YEAR_MS;
  const t1 = allTs.length ? Math.max(...allTs) : now;
  const span = Math.max(1, t1 - t0);
  const xFor = (t) => padX + ((t - t0) / span) * (w - padX * 2);
  const yFor = (v) =>
    h - padY - ((v - NDVI_RAMP_MIN) / (NDVI_RAMP_MAX - NDVI_RAMP_MIN)) * (h - padY * 2);

  const cleanPoints = points.filter((p) => !p.suspect);
  const path = cleanPoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.t).toFixed(1)},${yFor(p.v).toFixed(1)}`)
    .join(" ");
  const area = cleanPoints.length
    ? `${path} L${xFor(cleanPoints[cleanPoints.length - 1].t).toFixed(1)},${h - padY} L${xFor(cleanPoints[0].t).toFixed(1)},${h - padY} Z`
    : "";

  const cleanLastYear = lastYearShifted.filter((p) => !p.suspect);
  const lastYearPath = cleanLastYear
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.t).toFixed(1)},${yFor(p.v).toFixed(1)}`)
    .join(" ");

  const activePoint = activeIso
    ? points.find((p) => p.iso === activeIso) || null
    : null;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ display: "block", borderRadius: radius.base }}
      aria-hidden
    >
      <defs>
        <linearGradient id="ndvi-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#006837" stopOpacity="0.42" />
          <stop offset="60%" stopColor="#FFFFBF" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#A50026" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((v) => {
        const y = h - padY - v * (h - padY * 2);
        return (
          <line
            key={v}
            x1={padX}
            x2={w - padX}
            y1={y}
            y2={y}
            stroke="#D5E5D7"
            strokeDasharray="2,3"
          />
        );
      })}
      {lastYearPath ? (
        <path
          d={lastYearPath}
          fill="none"
          stroke="#94A3B8"
          strokeWidth="1.25"
          strokeDasharray="4,3"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.85}
        />
      ) : null}
      {cleanLastYear.map((p) => (
        <circle
          key={`prev-${p.iso}`}
          cx={xFor(p.t)}
          cy={yFor(p.v)}
          r={1.4}
          fill="#94A3B8"
          opacity={0.6}
        />
      ))}
      <path d={area} fill="url(#ndvi-fill)" />
      <path
        d={path}
        fill="none"
        stroke="#104E3F"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((p) => (
        <circle
          key={p.iso}
          cx={xFor(p.t)}
          cy={yFor(p.v)}
          r={p.suspect ? 2.2 : 1.8}
          fill={p.suspect ? "#FFFFFF" : "#104E3F"}
          stroke={p.suspect ? "#9CA3AF" : "none"}
          strokeWidth={p.suspect ? 1 : 0}
          opacity={p.suspect ? 0.85 : 0.55}
        />
      ))}
      {activePoint ? (
        <>
          <line
            x1={xFor(activePoint.t)}
            x2={xFor(activePoint.t)}
            y1={padY}
            y2={h - padY}
            stroke="#EC9A29"
            strokeDasharray="3,3"
          />
          <circle
            cx={xFor(activePoint.t)}
            cy={yFor(activePoint.v)}
            r={3.5}
            fill="#EC9A29"
          />
        </>
      ) : null}
    </svg>
  );
}

function LegendSwatch({ color, label }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 7px",
        background: brand.bgSection,
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: brand.forest,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 10, height: 10, background: color, borderRadius: 2 }} />
      {label}
    </div>
  );
}

function useNarrowViewport(maxWidth = 760) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [maxWidth]);

  return matches;
}

export function SatelliteWorkspace({ fields }) {
  const withRings = useMemo(
    () =>
      (fields || []).filter(
        (f) => Array.isArray(f.boundary) && f.boundary.length >= 3
      ),
    [fields]
  );

  const fieldIds = useMemo(() => withRings.map((f) => f.id), [withRings]);
  const { scenes, latest, status } = useFieldNdviScenes(fieldIds);
  const queueStatus = useSentinelQueueStatus({ pollMs: 3000 });

  // Mount-time auto-refresh: once the initial snapshot is in, silently
  // kick off ingests for any field whose latest scene is stale (or
  // missing). Belt-and-braces with the server-side periodic sweep —
  // this is what gets the user a fresh choropleth the first time they
  // open the workspace after a long gap, even if the scheduler missed
  // its tick. Guarded by a ref so it only runs once per mount.
  const ndviAutoRefreshedRef = useRef(false);
  useEffect(() => {
    if (ndviAutoRefreshedRef.current) return;
    if (status !== "ready") return;
    if (!fieldIds.length) return;
    ndviAutoRefreshedRef.current = true;
    autoRefreshStaleFields(fieldIds, scenes).catch(() => {
      /* surfaced via console */
    });
  }, [status, fieldIds, scenes]);

  // Per-field set of item_ids whose NDVI deviates sharply from temporal
  // neighbours. These are almost always cloud / haze contamination that
  // SCL didn't catch (the classic "scene_cloud 49% / field_masked 0% /
  // ndvi 0.02" failure mode). We exclude them from the cohort median,
  // the "below cohort" flag list, the choropleth, and the default
  // "active scene" pick — but the user can still scrub onto them
  // manually and the curve renders them in muted grey for visibility.
  const suspectByField = useMemo(() => {
    const out = new Map();
    for (const fieldId of fieldIds) {
      const arr = (scenes.get(fieldId) || [])
        .filter(
          (s) =>
            s.status === "ok" &&
            Number.isFinite(s.ndvi_mean) &&
            (s.valid_pixel_count ?? 0) > 0
        )
        .slice()
        .sort(
          (a, b) =>
            new Date(a.scene_datetime).getTime() -
            new Date(b.scene_datetime).getTime()
        );
      out.set(fieldId, flagSuspectByTemporalNeighbours(arr));
    }
    return out;
  }, [fieldIds, scenes]);

  // "Latest non-suspect" scene per field. Falls back to `latest`
  // (raw newest) only if every scene in the lookback was flagged —
  // better to show something than nothing in that edge case.
  const latestGood = useMemo(() => {
    const out = new Map();
    for (const fieldId of fieldIds) {
      const suspect = suspectByField.get(fieldId) || new Set();
      const arr = (scenes.get(fieldId) || [])
        .filter(
          (s) =>
            s.status === "ok" &&
            Number.isFinite(s.ndvi_mean) &&
            (s.valid_pixel_count ?? 0) > 0
        )
        .slice()
        .sort(
          (a, b) =>
            new Date(b.scene_datetime).getTime() -
            new Date(a.scene_datetime).getTime()
        );
      const pick = arr.find((s) => !suspect.has(s.item_id));
      out.set(fieldId, pick || latest.get(fieldId) || null);
    }
    return out;
  }, [fieldIds, scenes, suspectByField, latest]);

  const [selectedFieldId, setSelectedFieldId] = useState(null);
  // Active scene is identified by item_id on a per-field basis. We keep
  // a Map<fieldId, item_id> in state so each field remembers its own
  // scrubber position when the user toggles between fields.
  const [activeByField, setActiveByField] = useState(new Map());
  const [showRaster, setShowRaster] = useState(false);
  const [rasterOpacity, setRasterOpacity] = useState(0.65);
  const [refreshingId, setRefreshingId] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const isMobileView = useNarrowViewport();

  // When `withRings` first hydrates, default the selected field to the
  // first one so the curve+map have something to draw immediately.
  useEffect(() => {
    if (selectedFieldId && fieldIds.includes(selectedFieldId)) return;
    setSelectedFieldId(fieldIds[0] || null);
  }, [fieldIds, selectedFieldId]);

  // Whenever `scenes` updates, default each field's active scene to its
  // newest non-suspect row if the user hasn't picked one. This way the
  // map and curve open on a clean scene rather than a cloud-contaminated
  // one that just happens to be the most recent.
  useEffect(() => {
    setActiveByField((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const fieldId of fieldIds) {
        if (next.has(fieldId)) continue;
        const rec = latestGood.get(fieldId);
        if (rec) {
          next.set(fieldId, rec.item_id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [fieldIds, latestGood]);

  const activeScenesByField = useMemo(() => {
    const out = new Map();
    for (const fieldId of fieldIds) {
      const arr = scenes.get(fieldId) || [];
      const id = activeByField.get(fieldId);
      const found = id ? arr.find((s) => s.item_id === id) : null;
      out.set(fieldId, found || latestGood.get(fieldId) || null);
    }
    return out;
  }, [fieldIds, scenes, activeByField, latestGood]);

  const selectedScenes = scenes.get(selectedFieldId) || [];
  const selectedActive = activeScenesByField.get(selectedFieldId) || null;
  const selectedField = withRings.find((f) => f.id === selectedFieldId) || null;

  // Phenology metrics for the selected field, computed off the
  // suspect-filtered ascending series. Recomputes when scenes or
  // the suspect set change.
  const selectedPhenology = useMemo(() => {
    if (!selectedFieldId) return null;
    const suspect = suspectByField.get(selectedFieldId) || new Set();
    const cleaned = (scenes.get(selectedFieldId) || [])
      .filter(
        (s) =>
          s.status === "ok" &&
          Number.isFinite(s.ndvi_mean) &&
          (s.valid_pixel_count ?? 0) > 0 &&
          !suspect.has(s.item_id)
      )
      .slice()
      .sort(
        (a, b) =>
          new Date(a.scene_datetime).getTime() -
          new Date(b.scene_datetime).getTime()
      );
    return computePhenology(cleaned);
  }, [selectedFieldId, scenes, suspectByField]);

  // Year-over-year: compare the active scene to the closest non-
  // suspect scene from 365 days earlier (within ±14 days). Returns
  // { lastYearMean, lastYearIso, delta } or null when no prior-year
  // data is available within the window.
  const selectedYoY = useMemo(() => {
    if (!selectedActive || !selectedFieldId) return null;
    const suspect = suspectByField.get(selectedFieldId) || new Set();
    const targetT = new Date(selectedActive.scene_datetime).getTime() - YEAR_MS;
    const candidates = (scenes.get(selectedFieldId) || []).filter(
      (s) =>
        s.status === "ok" &&
        Number.isFinite(s.ndvi_mean) &&
        (s.valid_pixel_count ?? 0) > 0 &&
        !suspect.has(s.item_id)
    );
    let best = null;
    let bestDelta = Infinity;
    for (const s of candidates) {
      const dt = Math.abs(new Date(s.scene_datetime).getTime() - targetT);
      if (dt < bestDelta && dt < 14 * DAY_MS) {
        bestDelta = dt;
        best = s;
      }
    }
    if (!best) return null;
    return {
      lastYearMean: best.ndvi_mean,
      lastYearIso: best.scene_datetime,
      delta: selectedActive.ndvi_mean - best.ndvi_mean,
    };
  }, [selectedActive, selectedFieldId, scenes, suspectByField]);

  const choropleth = useMemo(() => {
    if (isMobileView) return {};
    const out = {};
    for (const f of withRings) {
      const rec = activeScenesByField.get(f.id);
      if (rec && Number.isFinite(rec.ndvi_mean) && rec.status === "ok") {
        out[f.id] = {
          value: rec.ndvi_mean.toFixed(2),
          color: ndviColor(rec.ndvi_mean),
        };
      }
    }
    return out;
  }, [isMobileView, withRings, activeScenesByField]);

  const mapCenter = useMemo(() => {
    const target = selectedField || withRings[0];
    if (!target) return { lat: 54, lng: -2, zoom: 6 };
    const c = ringCentroid(target.boundary);
    return { lat: c.lat, lng: c.lng, zoom: 14 };
  }, [selectedField, withRings]);

  const rasterOverlay = useMemo(() => {
    if (isMobileView) return null;
    if (!showRaster || !selectedActive?.item_id || selectedActive.status !== "ok") return null;
    const url = buildNdviTileUrlFn({
      itemId: selectedActive.item_id,
      collection: selectedActive.collection || "sentinel-2-l2a",
      colormap: NDVI_COLORMAP,
      rescale: NDVI_RESCALE_PARAM,
    });
    if (!url) return null;
    return [
      {
        id: `ndvi-${selectedActive.item_id}`,
        opacity: rasterOpacity,
        minZoom: 8,
        maxZoom: 19,
        url,
      },
    ];
  }, [isMobileView, showRaster, selectedActive, rasterOpacity]);

  // Quality / freshness summary across all fields.
  const summary = useMemo(() => {
    let okFields = 0;
    let pendingFields = 0;
    let errorFields = 0;
    let noDataFields = 0;
    let mostRecent = null;
    let medianAcc = 0;
    let medianN = 0;
    for (const f of withRings) {
      // Use the latest non-suspect scene so a single cloud-contaminated
      // outlier doesn't drag the cohort median down.
      const rec = latestGood.get(f.id);
      if (!rec) {
        const arr = scenes.get(f.id) || [];
        if (arr.some((r) => r.status === "pending")) pendingFields += 1;
        else if (arr.some((r) => r.status === "error")) errorFields += 1;
        else if (arr.length) noDataFields += 1;
        continue;
      }
      okFields += 1;
      medianAcc += rec.ndvi_mean;
      medianN += 1;
      const t = new Date(rec.scene_datetime).getTime();
      if (Number.isFinite(t) && (mostRecent == null || t > mostRecent)) mostRecent = t;
    }
    let suspectCount = 0;
    for (const set of suspectByField.values()) suspectCount += set.size;
    return {
      okFields,
      pendingFields,
      errorFields,
      noDataFields,
      suspectCount,
      median: medianN > 0 ? (medianAcc / medianN).toFixed(2) : "—",
      mostRecent: mostRecent ? new Date(mostRecent).toISOString() : null,
    };
  }, [withRings, latestGood, scenes, suspectByField]);

  // Anomaly flag list — fields whose latest NDVI is meaningfully below
  // the cohort median for this refresh window. Suspect (cloud-
  // contaminated) scenes are excluded so we don't get false positives
  // every time a cloud rolls over a single field.
  const flagged = useMemo(() => {
    const baseline = Number.isFinite(Number(summary.median))
      ? Number(summary.median)
      : null;
    if (baseline == null) return [];
    const arr = [];
    for (const f of withRings) {
      const rec = latestGood.get(f.id);
      if (!rec) continue;
      const delta = rec.ndvi_mean - baseline;
      if (delta < -0.1) {
        arr.push({
          id: f.id,
          name: f.name || "Unnamed field",
          ndvi: rec.ndvi_mean,
          delta,
        });
      }
    }
    return arr.sort((a, b) => a.delta - b.delta).slice(0, 4);
  }, [withRings, latestGood, summary]);

  const handleRefresh = useCallback(
    async (fieldId, { force = false, lookbackDays } = {}) => {
      if (!fieldId) return;
      setRefreshingId(fieldId);
      setRefreshError(null);
      const result = await triggerNdviRefresh(fieldId, {
        force,
        lookbackDays,
      });
      setRefreshingId(null);
      if (!result.ok) {
        setRefreshError(result.error || "Could not start refresh");
      }
    },
    []
  );

  const handleRefreshAll = useCallback(
    async ({ force = false } = {}) => {
      setRefreshError(null);
      let lastErr = null;
      for (const f of withRings) {
        setRefreshingId(f.id);
        const r = await triggerNdviRefresh(f.id, { force });
        if (!r.ok) lastErr = r.error || "Refresh failed";
      }
      setRefreshingId(null);
      if (lastErr) setRefreshError(lastErr);
    },
    [withRings]
  );

  const hasFields = withRings.length > 0;

  // Header status pill — communicates "is anything happening?" at a glance.
  const headerPill = useMemo(() => {
    if (status === "no-supabase") {
      return <Pill tone="warn">Sign in to load NDVI</Pill>;
    }
    if (status === "error") return <Pill tone="warn">Connection issue</Pill>;
    if (summary.pendingFields > 0) {
      return <Pill tone="info">Ingesting · {summary.pendingFields} field(s)</Pill>;
    }
    if (summary.okFields === 0 && hasFields) {
      return <Pill tone="warn">No scenes yet · click Refresh</Pill>;
    }
    if (summary.mostRecent) {
      return <Pill tone="ok">Latest scene · {fmtRelative(summary.mostRecent)}</Pill>;
    }
    return null;
  }, [status, summary, hasFields]);

  const queueBusy =
    queueStatus &&
    (Number(queueStatus.queued || 0) > 0 ||
      Number(queueStatus.inflight || 0) > 0);

  const headerActions = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {headerPill}
      {queueBusy ? (
        <Pill
          tone="info"
          title={`${queueStatus.inflight} field update(s) are being processed and ${queueStatus.queued} are waiting.`}
          style={{ textTransform: "none", letterSpacing: "0.06em" }}
        >
          Ingest queue · {queueStatus.inflight} processing
          {queueStatus.queued > 0 ? ` · ${queueStatus.queued} waiting` : ""}
        </Pill>
      ) : null}
      {summary.suspectCount > 0 ? (
        <Pill
          tone="warn"
          title="Scenes whose NDVI deviates sharply from temporal neighbours, almost always cloud / haze contamination that SCL didn't catch. Excluded from the cohort median and below-cohort flag list, shown muted in the curve and scrubber."
          style={{ textTransform: "none", letterSpacing: "0.06em" }}
        >
          {summary.suspectCount} cloud-suspect
        </Pill>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => handleRefreshAll({ force: false })}
        disabled={!hasFields || refreshingId != null}
      >
        {refreshingId ? "Refreshing…" : "Refresh all from Sentinel-2"}
      </Button>
    </div>
  );

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Remote sensing"
          title="Vegetation indices"
          description="Sentinel-2 optical imagery — NDVI, EVI, NDWI, NDMI, NDRE, SAVI and NBR per field. These low-cost indices support crop-stage, moisture, canopy, and stress warnings."
          actions={headerActions}
        />
      }
    >
      {!hasFields ? (
        <Card padding={24}>
          <EmptyState
            kicker="No fields"
            title="Map boundaries to unlock NDVI"
            description="NDVI ingests against your stored field boundaries. Map at least one field, then come back here."
          />
        </Card>
      ) : (
        <div
          className="tilth-sat-layout"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 340px",
            gap: 12,
            overflow: "hidden",
          }}
        >
          {!isMobileView ? (
          <div className="tilth-sat-map-column" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
            <div style={{ flex: "1 1 auto", minHeight: 0 }}>
              <FieldMapThree2D
                key={`ndvi-${mapCenter.lat}-${mapCenter.lng}`}
                center={[mapCenter.lat, mapCenter.lng]}
                zoom={mapCenter.zoom}
                savedFields={withRings}
                draftRing={[]}
                mapMode="pan"
                basemap="satellite"
                choropleth={choropleth}
                overlays={rasterOverlay}
                selectedFieldId={selectedFieldId}
                onSelectField={setSelectedFieldId}
                height="100%"
              />
            </div>

            <div
              style={{
                flex: "0 0 auto",
                padding: "8px 10px",
                background: brand.white,
                border: `1px solid ${brand.border}`,
                borderRadius: radius.base,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "0 0 auto" }}>
                <LegendSwatch color={ndviColor(0.05)} label="Stressed" />
                <LegendSwatch color={ndviColor(0.45)} label="Mid" />
                <LegendSwatch color={ndviColor(0.8)} label="Canopy" />
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: brand.forest,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={showRaster}
                  onChange={(e) => setShowRaster(e.target.checked)}
                  disabled={!selectedActive}
                  style={{ accentColor: brand.forest }}
                />
                NDVI raster
              </label>
              {showRaster && selectedActive ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flex: "0 0 auto",
                  }}
                >
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      color: brand.muted,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                    }}
                  >
                    Opacity
                  </span>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={rasterOpacity}
                    onChange={(e) => setRasterOpacity(parseFloat(e.target.value))}
                    style={{ width: 100, accentColor: brand.forest }}
                  />
                </div>
              ) : null}
              <Pill tone="info">Median NDVI {summary.median}</Pill>
              {summary.pendingFields > 0 ? (
                <Pill tone="warn">{summary.pendingFields} pending</Pill>
              ) : null}
            </div>
          </div>
          ) : null}

          <div
            className="tilth-sat-side tilth-scroll"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 0,
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            <Card padding={12}>
              <Subpanel
                kicker={selectedField ? "Selected field" : "Pick a field"}
                title={selectedField?.name || "—"}
                actions={
                  selectedActive ? (
                    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                      <Pill tone="neutral">NDVI {fmtNdvi(selectedActive.ndvi_mean)}</Pill>
                      {Number.isFinite(selectedActive.evi_mean) && (
                        <Pill tone="neutral" title="Enhanced Vegetation Index — more sensitive in dense canopy">EVI {fmtNdvi(selectedActive.evi_mean)}</Pill>
                      )}
                      {Number.isFinite(selectedActive.ndwi_mean) && (
                        <Pill tone={selectedActive.ndwi_mean < -0.3 ? "warn" : "neutral"} title="Normalised Difference Water Index — canopy water content">NDWI {fmtNdvi(selectedActive.ndwi_mean)}</Pill>
                      )}
                      {Number.isFinite(selectedActive.ndmi_mean) && (
                        <Pill tone={selectedActive.ndmi_mean < -0.1 ? "warn" : "neutral"} title="Normalised Difference Moisture Index — canopy/soil moisture">NDMI {fmtNdvi(selectedActive.ndmi_mean)}</Pill>
                      )}
                      {Number.isFinite(selectedActive.ndre_mean) && (
                        <Pill tone={selectedActive.ndre_mean < 0.18 ? "warn" : "neutral"} title="Normalised Difference Red Edge — chlorophyll/nitrogen stress signal">NDRE {fmtNdvi(selectedActive.ndre_mean)}</Pill>
                      )}
                      {Number.isFinite(selectedActive.savi_mean) && (
                        <Pill tone={selectedActive.savi_mean < 0.22 ? "warn" : "neutral"} title="Soil Adjusted Vegetation Index — useful in sparse canopy and early growth">SAVI {fmtNdvi(selectedActive.savi_mean)}</Pill>
                      )}
                      {Number.isFinite(selectedActive.nbr_mean) && (
                        <Pill tone="neutral" title="Normalised Burn Ratio — useful for residue, exposed soil, and damage context">NBR {fmtNdvi(selectedActive.nbr_mean)}</Pill>
                      )}
                    </span>
                  ) : null
                }
                style={{ marginBottom: 0 }}
              >
                <NdviCurve
                  scenes={selectedScenes}
                  activeIso={selectedActive?.scene_datetime || null}
                  suspectIds={
                    suspectByField.get(selectedFieldId) || new Set()
                  }
                />
                <SceneScrubber
                  scenes={selectedScenes}
                  activeItemId={selectedActive?.item_id || null}
                  suspectIds={
                    suspectByField.get(selectedFieldId) || new Set()
                  }
                  onPick={(itemId) => {
                    if (!selectedFieldId) return;
                    setActiveByField((prev) => {
                      const next = new Map(prev);
                      next.set(selectedFieldId, itemId);
                      return next;
                    });
                  }}
                />
                <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <Pill tone="neutral">
                    {selectedScenes.filter((s) => s.status === "ok").length} usable
                    scenes
                  </Pill>
                  <Pill tone="info">Sentinel-2 L2A</Pill>
                  {selectedActive ? (
                    <Pill tone="neutral">{fmtDate(selectedActive.scene_datetime)}</Pill>
                  ) : null}
                  {selectedActive && Number.isFinite(selectedActive.scene_cloud_pct) ? (
                    <Pill
                      tone={selectedActive.scene_cloud_pct > 30 ? "warn" : "neutral"}
                    >
                      Scene cloud {Math.round(selectedActive.scene_cloud_pct)}%
                    </Pill>
                  ) : null}
                  {selectedActive && Number.isFinite(selectedActive.field_cloud_pct) ? (
                    <Pill
                      tone={
                        selectedActive.field_cloud_pct > 50
                          ? "danger"
                          : selectedActive.field_cloud_pct > 15
                            ? "warn"
                            : "ok"
                      }
                      style={{
                        textTransform: "none",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Field masked {Math.round(selectedActive.field_cloud_pct)}%
                    </Pill>
                  ) : null}
                  {selectedActive &&
                  (suspectByField.get(selectedFieldId) || new Set()).has(
                    selectedActive.item_id
                  ) ? (
                    <Pill
                      tone="warn"
                      style={{
                        textTransform: "none",
                        letterSpacing: "0.06em",
                      }}
                      title="This scene's NDVI is far below its temporal neighbours — almost certainly cloud or haze that the SCL mask missed. Excluded from the cohort median and below-cohort flag list."
                    >
                      ⚠ Likely cloud-contaminated
                    </Pill>
                  ) : null}
                  {selectedYoY ? (
                    <Pill
                      tone={
                        selectedYoY.delta > 0.05
                          ? "ok"
                          : selectedYoY.delta < -0.05
                            ? "warn"
                            : "neutral"
                      }
                      style={{ textTransform: "none", letterSpacing: "0.06em" }}
                      title={`Same-week comparison vs ${fmtDate(selectedYoY.lastYearIso)} (NDVI ${selectedYoY.lastYearMean.toFixed(2)}). Press Backfill 2 years to extend history.`}
                    >
                      vs last year{" "}
                      {selectedYoY.delta >= 0 ? "+" : ""}
                      {selectedYoY.delta.toFixed(2)}
                    </Pill>
                  ) : null}
                </div>
                <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleRefresh(selectedFieldId)}
                    disabled={!selectedFieldId || refreshingId != null}
                  >
                    {refreshingId === selectedFieldId
                      ? "Queuing…"
                      : "Refresh this field"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "This deletes the cached scenes for this field and re-runs the ingest from scratch. Use after enabling cloud masking or changing the lookback. Continue?"
                        )
                      )
                        return;
                      handleRefresh(selectedFieldId, { force: true });
                    }}
                    disabled={!selectedFieldId || refreshingId != null}
                    title="Wipe cached rows and re-ingest with the current methodology (cloud masking, rescale, etc.)"
                  >
                    Force re-ingest
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      handleRefresh(selectedFieldId, {
                        lookbackDays: 730,
                      })
                    }
                    disabled={!selectedFieldId || refreshingId != null}
                    title="Re-run ingest with a 2-year lookback to backfill last year's scenes for year-over-year comparison. Existing rows are kept."
                  >
                    Backfill 2 years
                  </Button>
                </div>
                {refreshError ? (
                  <Body
                    size="sm"
                    style={{ marginTop: 6, color: brand.danger, lineHeight: 1.45 }}
                  >
                    {refreshError}
                  </Body>
                ) : null}
              </Subpanel>
            </Card>

            <Card padding={12}>
              <Subpanel
                kicker="Phenology"
                title="Season summary"
                style={{ marginBottom: 0 }}
              >
                <PhenologyCard phenology={selectedPhenology} />
              </Subpanel>
            </Card>

            <Card padding={12}>
              <Subpanel
                kicker="Flagged"
                title="Below-cohort fields"
                style={{ marginBottom: 0 }}
              >
                {flagged.length ? (
                  <div style={{ display: "grid", gap: 6 }}>
                    {flagged.map((f) => (
                      <Row
                        key={f.id}
                        onClick={() => setSelectedFieldId(f.id)}
                        style={{ padding: "7px 9px" }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              color: brand.forest,
                              fontSize: 12.5,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {f.name}
                          </span>
                          <Pill tone="warn">Δ {f.delta.toFixed(2)}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                ) : (
                  <Body size="sm">
                    Nothing meaningfully below the median for this refresh window.
                  </Body>
                )}
              </Subpanel>
            </Card>

            <Card padding={12} tone="section">
              <Kicker style={{ marginBottom: 6 }}>Data source &amp; cloud handling</Kicker>
              <Body size="sm" style={{ lineHeight: 1.55 }}>
                Sentinel-2 L2A scenes are fetched from{" "}
                <strong>Microsoft Planetary Computer</strong>. Three layers of
                cloud handling are applied. <em>(1)</em> Scenes whose tile-wide
                cloud cover exceeds 60% are filtered out at search time.{" "}
                <em>(2)</em> Within each accepted scene the per-pixel <em>SCL</em>{" "}
                band is used to keep only <strong>vegetation</strong> and{" "}
                <strong>bare-soil</strong> pixels — cloud, shadow, water, snow
                and ambiguous pixels are masked from the per-field mean and the
                raster overlay. <em>(3)</em> A temporal outlier filter compares
                each scene to its neighbours in time; scenes whose NDVI is
                wildly inconsistent (almost always cloud the SCL classifier
                missed) are flagged{" "}
                <strong style={{ color: brand.muted }}>cloud-suspect</strong>{" "}
                and excluded from the cohort median and below-cohort flag list.
              </Body>
              <Body size="sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
                Suspect scenes are still scrubbable (muted grey in the curve
                and scrubber) so you can compare a borderline reading to clean
                neighbours. If a clean scene's <em>field cloud %</em> is high,
                very few pixels survived masking — treat that scene as advisory
                and rely on neighbouring weeks instead.
              </Body>
              {summary.errorFields > 0 ? (
                <Body
                  size="sm"
                  style={{ marginTop: 6, color: brand.danger, lineHeight: 1.45 }}
                >
                  {summary.errorFields} field(s) reported an ingest error. Try
                  refreshing — most failures are transient titiler timeouts.
                </Body>
              ) : null}
            </Card>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 1250px) {
          .tilth-sat-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .tilth-sat-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
            gap: 12px !important;
            padding-bottom: 18px !important;
          }
          .tilth-sat-side {
            flex: 0 0 auto !important;
            min-height: auto !important;
            overflow: visible !important;
            padding-right: 0 !important;
          }
          .tilth-sat-side button {
            width: 100%;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

/**
 * A horizontal scrubber that lets the user click between cached scenes
 * for the active field. Cleaner than a date-week range slider because
 * Sentinel-2 revisit isn't perfectly weekly and many scenes are clouded
 * out — we want to expose the actual scenes that exist, in order.
 */
/**
 * Compact season-summary card driven by `computePhenology`. Renders a
 * small grid of metric tiles (peak / days-to-peak / days-since-peak /
 * AUC / mean) plus a one-line interpretation. Intentionally minimal —
 * heavy phenology analysis lives in the Analytics workspace, this is
 * just the at-a-glance for the satellite workspace.
 */
function PhenologyCard({ phenology }) {
  if (!phenology || !phenology.ok) {
    const reason =
      phenology?.reason === "insufficient-data"
        ? `Need ≥4 clean scenes in the past year (${phenology.sceneCount} so far).`
        : "No phenology data yet for this field.";
    return (
      <Body size="sm" style={{ color: brand.muted, lineHeight: 1.5 }}>
        {reason}
      </Body>
    );
  }
  const {
    peak,
    emergence,
    senescence,
    daysToPeak,
    daysSincePeak,
    daysSinceEmergence,
    seasonAUC,
    meanNdvi,
    latest,
  } = phenology;

  const tiles = [
    {
      label: "Peak NDVI",
      value: peak ? peak.v.toFixed(2) : "—",
      sub: peak ? fmtDate(peak.iso) : "",
      tone: "ok",
    },
    {
      label: "Days to peak",
      value: daysToPeak != null ? `${daysToPeak}d` : "—",
      sub: emergence ? `from ${fmtDate(emergence.iso)}` : "no emergence",
    },
    {
      label: "Days since peak",
      value: daysSincePeak != null ? `${daysSincePeak}d` : "—",
      sub:
        senescence != null
          ? `senesced ${fmtDate(senescence.iso)}`
          : "still vegetative",
    },
    {
      label: "Season AUC",
      value: seasonAUC != null ? seasonAUC.toFixed(0) : "—",
      sub: "NDVI · day",
      title:
        "Trapezoidal integral of NDVI over time from emergence to today (or senescence). Strong proxy for cumulative biomass / yield.",
    },
    {
      label: "Mean NDVI",
      value: meanNdvi != null ? meanNdvi.toFixed(2) : "—",
      sub: `${phenology.sceneCount} scenes`,
    },
  ];

  // Interpretation line — short, agronomy-flavoured.
  let summary = "";
  if (peak && latest && daysSincePeak != null) {
    const dropFromPeak = peak.v - latest.v;
    if (senescence) {
      summary = `Senescing — NDVI ${(latest.v).toFixed(2)} (peak ${peak.v.toFixed(2)}, ${daysSincePeak}d ago).`;
    } else if (daysSincePeak <= 14) {
      summary = `At or near peak canopy — NDVI ${latest.v.toFixed(2)}, peaked ${daysSincePeak}d ago.`;
    } else if (dropFromPeak > 0.15) {
      summary = `${dropFromPeak.toFixed(2)} below peak — possibly entering senescence or stress.`;
    } else {
      summary = `Holding canopy — ${dropFromPeak.toFixed(2)} below peak after ${daysSincePeak}d.`;
    }
  } else if (emergence && daysSinceEmergence != null) {
    summary = `${daysSinceEmergence}d into the season, peak not yet reached.`;
  } else {
    summary = "Below emergence threshold — bare/senescent or pre-season.";
  }

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(78px, 1fr))",
          gap: 6,
        }}
      >
        {tiles.map((tile) => (
          <div
            key={tile.label}
            title={tile.title || ""}
            style={{
              padding: "7px 8px",
              border: `1px solid ${brand.border}`,
              borderRadius: radius.base,
              background: brand.bgSection,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
              minHeight: 54,
            }}
          >
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 9,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: brand.muted,
              }}
            >
              {tile.label}
            </span>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 14,
                fontWeight: 600,
                color: brand.forest,
                letterSpacing: "0.04em",
              }}
            >
              {tile.value}
            </span>
            {tile.sub ? (
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 9,
                  letterSpacing: "0.06em",
                  color: brand.muted,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "100%",
                }}
              >
                {tile.sub}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <Body size="sm" style={{ marginTop: 8, lineHeight: 1.5 }}>
        {summary}
      </Body>
    </div>
  );
}

function SceneScrubber({ scenes, activeItemId, onPick, suspectIds }) {
  const suspect = suspectIds || new Set();
  const usable = useMemo(
    () => (scenes || []).filter((s) => s.status === "ok").slice().reverse(),
    [scenes]
  );
  if (!usable.length) {
    return (
      <div
        style={{
          marginTop: 8,
          padding: "8px 10px",
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.muted,
          background: brand.bgSection,
          border: `1px solid ${brand.border}`,
          borderRadius: radius.base,
        }}
      >
        No usable scenes
      </div>
    );
  }
  return (
    <div
      style={{
        marginTop: 8,
        display: "flex",
        gap: 4,
        overflowX: "auto",
        padding: "4px 2px",
      }}
      className="tilth-scrubber"
    >
      {usable.map((s) => {
        const active = s.item_id === activeItemId;
        const isSuspect = suspect.has(s.item_id);
        const cloud = Number.isFinite(s.scene_cloud_pct)
          ? `${Math.round(s.scene_cloud_pct)}%`
          : "";
        const titleParts = [
          fmtDate(s.scene_datetime),
          `NDVI ${fmtNdvi(s.ndvi_mean)}`,
        ];
        if (Number.isFinite(s.evi_mean)) titleParts.push(`EVI ${fmtNdvi(s.evi_mean)}`);
        if (Number.isFinite(s.ndwi_mean)) titleParts.push(`NDWI ${fmtNdvi(s.ndwi_mean)}`);
        if (Number.isFinite(s.ndmi_mean)) titleParts.push(`NDMI ${fmtNdvi(s.ndmi_mean)}`);
        if (Number.isFinite(s.ndre_mean)) titleParts.push(`NDRE ${fmtNdvi(s.ndre_mean)}`);
        if (Number.isFinite(s.savi_mean)) titleParts.push(`SAVI ${fmtNdvi(s.savi_mean)}`);
        if (Number.isFinite(s.nbr_mean)) titleParts.push(`NBR ${fmtNdvi(s.nbr_mean)}`);
        if (cloud) titleParts.push(`cloud ${cloud}`);
        if (isSuspect) titleParts.push("⚠ likely cloud-contaminated");
        return (
          <button
            key={s.item_id}
            type="button"
            onClick={() => onPick(s.item_id)}
            title={titleParts.join(" · ")}
            style={{
              flex: "0 0 auto",
              padding: "5px 7px",
              borderRadius: radius.base,
              border: `1px solid ${active ? "#EC9A29" : isSuspect ? "#9CA3AF" : brand.border}`,
              background: active
                ? "#FFF6E5"
                : isSuspect
                  ? "#F4F4F5"
                  : brand.white,
              cursor: "pointer",
              fontFamily: fonts.mono,
              fontSize: 10,
              letterSpacing: "0.06em",
              color: isSuspect && !active ? brand.muted : brand.forest,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              minWidth: 60,
              position: "relative",
              opacity: isSuspect && !active ? 0.7 : 1,
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 600 }}>
              {fmtDate(s.scene_datetime).split(" ").slice(0, 2).join(" ")}
            </span>
            <span
              style={{
                width: 14,
                height: 6,
                borderRadius: 2,
                background: isSuspect
                  ? "repeating-linear-gradient(45deg, #D4D4D8 0 3px, #F4F4F5 3px 6px)"
                  : ndviColor(s.ndvi_mean),
                border: `1px solid ${brand.border}`,
              }}
              aria-hidden
            />
          </button>
        );
      })}
    </div>
  );
}

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
  autoRefreshStaleSarFields,
  buildSarTileUrlFn,
  triggerSarRefresh,
  useFieldSarScenes,
  useSarQueueStatus,
  SAR_BAND_DEFAULTS,
} from "../../lib/tilthSar.js";

/**
 * Sentinel-1 RTC SAR workspace — direct sibling of SatelliteWorkspace
 * but driven by `tilth_field_sar` (VV / VH backscatter) instead of NDVI.
 *
 * The radar workspace solves a problem the NDVI workspace cannot:
 * Sentinel-2 is regularly cloud-blocked over the UK during the growing
 * season. Sentinel-1 sees through cloud, so when NDVI's temporal
 * outlier filter wipes out a contaminated week, you can switch over
 * here for a clean reading of the same week.
 *
 * Visualisations:
 *   - Field choropleth coloured by mean VH (dB)
 *   - Per-field VH dB curve over the lookback window
 *   - Per-field VH/VV ratio (dB) curve as a vegetation-structure proxy
 *   - Optional VH / VV / ratio raster tile overlay (ramps tuned for UK arable)
 *   - Active-scene pills showing orbit state + relative orbit (matters
 *     because asc / desc geometries shift backscatter by 1-3 dB)
 */

// dB ranges for the VH choropleth ramp. Tuned for UK arable: -22 dB ≈
// open water / ploughed wet ground, -10 dB ≈ established cereal / OSR
// canopy. Values get clipped, so a freak -25 dB lake reads identically
// to -22 dB.
const VH_DB_MIN = -22;
const VH_DB_MAX = -8;

const VH_RAMP_STOPS = [
  { t: 0.0, rgb: [44, 54, 90] }, // dark indigo — bare / wet
  { t: 0.5, rgb: [78, 124, 138] }, // teal — sparse cover
  { t: 1.0, rgb: [212, 219, 117] }, // light yellow-green — dense canopy
];

function vhColor(dB) {
  if (!Number.isFinite(dB)) return "#cfd9cf";
  const t = Math.max(0, Math.min(1, (dB - VH_DB_MIN) / (VH_DB_MAX - VH_DB_MIN)));
  let lo = VH_RAMP_STOPS[0];
  let hi = VH_RAMP_STOPS[VH_RAMP_STOPS.length - 1];
  for (let i = 0; i < VH_RAMP_STOPS.length - 1; i++) {
    if (t >= VH_RAMP_STOPS[i].t && t <= VH_RAMP_STOPS[i + 1].t) {
      lo = VH_RAMP_STOPS[i];
      hi = VH_RAMP_STOPS[i + 1];
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

function fmtDb(v) {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "—";
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

/**
 * Two-track SAR curve. Renders VH dB as the primary line and VH/VV
 * ratio dB as a secondary line on a separate y-axis. Both signals
 * track vegetation but VH is sensitive to total biomass while the
 * ratio is sensitive to structure independent of total backscatter,
 * so they make a useful pair when reading a field's phenology under
 * cloud cover.
 */
function SarCurve({ scenes, activeItemId }) {
  const points = useMemo(() => {
    const arr = (scenes || [])
      .filter(
        (s) =>
          s.status === "ok" &&
          (s.valid_pixel_count ?? 0) > 0 &&
          Number.isFinite(s.vh_mean_db)
      )
      .map((s) => ({
        t: new Date(s.scene_datetime).getTime(),
        vh: s.vh_mean_db,
        ratio: Number.isFinite(s.vh_vv_ratio_mean_db)
          ? s.vh_vv_ratio_mean_db
          : null,
        iso: s.scene_datetime,
        id: s.item_id,
        orbit: s.orbit_state || null,
      }))
      .sort((a, b) => a.t - b.t);
    return arr;
  }, [scenes]);

  const w = 560;
  const h = 130;
  const padX = 14;
  const padY = 12;

  if (points.length === 0) {
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
        No SAR scenes yet
      </div>
    );
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const xFor = (t) => padX + ((t - t0) / span) * (w - padX * 2);
  // VH axis: -25..-5 dB
  const yForVh = (v) =>
    h - padY - ((v - -25) / (-5 - -25)) * (h - padY * 2);
  // Ratio axis: -15..-3 dB. Drawn dashed.
  const yForRatio = (v) =>
    h - padY - ((v - -15) / (-3 - -15)) * (h - padY * 2);

  const vhPath = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xFor(p.t).toFixed(1)},${yForVh(p.vh).toFixed(1)}`
    )
    .join(" ");
  const ratioPoints = points.filter((p) => p.ratio != null);
  const ratioPath = ratioPoints
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xFor(p.t).toFixed(1)},${yForRatio(p.ratio).toFixed(1)}`
    )
    .join(" ");
  const activePoint = activeItemId
    ? points.find((p) => p.id === activeItemId) || null
    : null;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ display: "block", borderRadius: radius.base }}
      aria-hidden
    >
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
      {ratioPath ? (
        <path
          d={ratioPath}
          fill="none"
          stroke="#A04E89"
          strokeWidth="1.25"
          strokeDasharray="4,3"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.85}
        />
      ) : null}
      {ratioPoints.map((p) => (
        <circle
          key={`ratio-${p.iso}`}
          cx={xFor(p.t)}
          cy={yForRatio(p.ratio)}
          r={1.5}
          fill="#A04E89"
          opacity={0.7}
        />
      ))}
      <path
        d={vhPath}
        fill="none"
        stroke="#2F6077"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((p) => (
        <circle
          key={`vh-${p.iso}`}
          cx={xFor(p.t)}
          cy={yForVh(p.vh)}
          r={1.9}
          fill={p.orbit === "descending" ? "#2F6077" : "#3F7A8A"}
          opacity={0.7}
        >
          <title>
            {p.iso} · VH {p.vh.toFixed(1)} dB
            {p.orbit ? ` · ${p.orbit}` : ""}
          </title>
        </circle>
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
            cy={yForVh(activePoint.vh)}
            r={3.5}
            fill="#EC9A29"
          />
        </>
      ) : null}
      <text
        x={padX + 2}
        y={padY + 8}
        fontFamily={fonts.mono}
        fontSize={9}
        fill="#2F6077"
        opacity={0.85}
      >
        VH dB
      </text>
      <text
        x={w - padX - 2}
        y={padY + 8}
        fontFamily={fonts.mono}
        fontSize={9}
        fill="#A04E89"
        textAnchor="end"
        opacity={0.85}
      >
        VH/VV dB
      </text>
    </svg>
  );
}

/**
 * Compact horizontal scrubber — one tile per cached scene, click to
 * make active. Tiles are coloured by VH dB so the user can see at a
 * glance how a season is shaping up just from the strip.
 */
function SarScrubber({ scenes, activeItemId, onPick }) {
  const items = useMemo(
    () =>
      (scenes || [])
        .filter((s) => s.status === "ok" && Number.isFinite(s.vh_mean_db))
        .slice()
        .sort(
          (a, b) =>
            new Date(a.scene_datetime).getTime() -
            new Date(b.scene_datetime).getTime()
        ),
    [scenes]
  );
  if (!items.length) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        marginTop: 10,
        overflowX: "auto",
        paddingBottom: 4,
      }}
      className="tilth-scroll"
    >
      {items.map((s) => {
        const isActive = s.item_id === activeItemId;
        return (
          <button
            key={s.item_id}
            type="button"
            onClick={() => onPick(s.item_id)}
            title={[
              fmtDate(s.scene_datetime),
              `VH ${fmtDb(s.vh_mean_db)}`,
              s.orbit_state ? `Orbit: ${s.orbit_state}` : null,
              Number.isFinite(s.vh_vv_ratio_mean_db)
                ? `VH/VV ${fmtDb(s.vh_vv_ratio_mean_db)}`
                : null,
            ]
              .filter(Boolean)
              .join("\n")}
            style={{
              flex: "0 0 auto",
              background: vhColor(s.vh_mean_db),
              border: `1px solid ${isActive ? brand.orange : brand.border}`,
              outline: isActive ? `1px solid ${brand.orange}` : "none",
              padding: "5px 6px",
              borderRadius: radius.base,
              cursor: "pointer",
              minWidth: 50,
              fontFamily: fonts.mono,
              fontSize: 9.5,
              letterSpacing: "0.04em",
              color: brand.white,
              textShadow: "0 1px 1px rgba(0,0,0,0.45)",
              lineHeight: 1.25,
            }}
          >
            {fmtDate(s.scene_datetime).split(" ").slice(0, 2).join(" ")}
            <br />
            {s.vh_mean_db.toFixed(1)}
          </button>
        );
      })}
    </div>
  );
}

function LegendSwatch({ color, label }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: brand.forest,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{ width: 10, height: 10, background: color, borderRadius: 2 }}
      />
      {label}
    </div>
  );
}

export function SarWorkspace({ fields }) {
  const withRings = useMemo(
    () =>
      (fields || []).filter(
        (f) => Array.isArray(f.boundary) && f.boundary.length >= 3
      ),
    [fields]
  );

  const fieldIds = useMemo(() => withRings.map((f) => f.id), [withRings]);
  const { scenes, latest, status } = useFieldSarScenes(fieldIds);
  const queueStatus = useSarQueueStatus({ pollMs: 3000 });

  // Mount-time auto-refresh: as soon as the initial snapshot is in,
  // silently kick off ingest for any field whose newest SAR scene is
  // stale or missing. Same belt-and-braces pattern as the Satellite
  // workspace.
  const sarAutoRefreshedRef = useRef(false);
  useEffect(() => {
    if (sarAutoRefreshedRef.current) return;
    if (status !== "ready") return;
    if (!fieldIds.length) return;
    sarAutoRefreshedRef.current = true;
    autoRefreshStaleSarFields(fieldIds, scenes).catch(() => {
      /* surfaced via console */
    });
  }, [status, fieldIds, scenes]);

  const [selectedFieldId, setSelectedFieldId] = useState(null);
  const [activeByField, setActiveByField] = useState(new Map());
  const [showRaster, setShowRaster] = useState(false);
  const [rasterBand, setRasterBand] = useState("vh"); // vh | vv | ratio
  const [rasterOpacity, setRasterOpacity] = useState(0.7);
  const [refreshingId, setRefreshingId] = useState(null);
  const [refreshError, setRefreshError] = useState(null);

  useEffect(() => {
    if (selectedFieldId && fieldIds.includes(selectedFieldId)) return;
    setSelectedFieldId(fieldIds[0] || null);
  }, [fieldIds, selectedFieldId]);

  // Default each field's active scene to its newest OK row when
  // unset. Same pattern as SatelliteWorkspace.
  useEffect(() => {
    setActiveByField((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const fieldId of fieldIds) {
        if (next.has(fieldId)) continue;
        const rec = latest.get(fieldId);
        if (rec) {
          next.set(fieldId, rec.item_id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [fieldIds, latest]);

  const activeScenesByField = useMemo(() => {
    const out = new Map();
    for (const fieldId of fieldIds) {
      const arr = scenes.get(fieldId) || [];
      const id = activeByField.get(fieldId);
      const found = id ? arr.find((s) => s.item_id === id) : null;
      out.set(fieldId, found || latest.get(fieldId) || null);
    }
    return out;
  }, [fieldIds, scenes, activeByField, latest]);

  const selectedScenes = scenes.get(selectedFieldId) || [];
  const selectedActive = activeScenesByField.get(selectedFieldId) || null;
  const selectedField =
    withRings.find((f) => f.id === selectedFieldId) || null;

  // Choropleth — colour each field polygon by its active scene's VH dB.
  const choropleth = useMemo(() => {
    const out = {};
    for (const f of withRings) {
      const rec = activeScenesByField.get(f.id);
      if (rec && Number.isFinite(rec.vh_mean_db) && rec.status === "ok") {
        out[f.id] = {
          value: `${rec.vh_mean_db.toFixed(1)} dB`,
          color: vhColor(rec.vh_mean_db),
        };
      }
    }
    return out;
  }, [withRings, activeScenesByField]);

  const mapCenter = useMemo(() => {
    const target = selectedField || withRings[0];
    if (!target) return { lat: 54, lng: -2, zoom: 6 };
    const c = ringCentroid(target.boundary);
    return { lat: c.lat, lng: c.lng, zoom: 14 };
  }, [selectedField, withRings]);

  const rasterOverlay = useMemo(() => {
    if (
      !showRaster ||
      !selectedActive?.item_id ||
      selectedActive.status !== "ok"
    )
      return null;
    const bandDef = SAR_BAND_DEFAULTS[rasterBand] || SAR_BAND_DEFAULTS.vh;
    const url = buildSarTileUrlFn({
      itemId: selectedActive.item_id,
      collection: selectedActive.collection || "sentinel-1-rtc",
      band: rasterBand,
      rescale: bandDef.rescale,
      colormap: bandDef.colormap,
    });
    if (!url) return null;
    return [
      {
        id: `sar-${rasterBand}-${selectedActive.item_id}`,
        opacity: rasterOpacity,
        minZoom: 8,
        maxZoom: 19,
        url,
      },
    ];
  }, [showRaster, rasterBand, selectedActive, rasterOpacity]);

  // Cohort summary across fields. SAR has no cloud-suspect concept,
  // so the median is straight off the latest OK row per field.
  const summary = useMemo(() => {
    let okFields = 0;
    let pendingFields = 0;
    let errorFields = 0;
    let mostRecent = null;
    let medianAcc = 0;
    let medianN = 0;
    for (const f of withRings) {
      const rec = latest.get(f.id);
      if (!rec) {
        const arr = scenes.get(f.id) || [];
        if (arr.some((r) => r.status === "pending")) pendingFields += 1;
        else if (arr.some((r) => r.status === "error")) errorFields += 1;
        continue;
      }
      okFields += 1;
      if (Number.isFinite(rec.vh_mean_db)) {
        medianAcc += rec.vh_mean_db;
        medianN += 1;
      }
      const t = new Date(rec.scene_datetime).getTime();
      if (Number.isFinite(t) && (mostRecent == null || t > mostRecent))
        mostRecent = t;
    }
    return {
      okFields,
      pendingFields,
      errorFields,
      median: medianN > 0 ? `${(medianAcc / medianN).toFixed(1)} dB` : "—",
      mostRecent: mostRecent ? new Date(mostRecent).toISOString() : null,
    };
  }, [withRings, latest, scenes]);

  // Anomaly flag list — fields whose latest VH is meaningfully below
  // the cohort median. Threshold of 2 dB is roughly 1.5σ for a
  // healthy UK arable cohort.
  const flagged = useMemo(() => {
    if (!Number.isFinite(parseFloat(summary.median))) return [];
    const baseline = parseFloat(summary.median);
    const arr = [];
    for (const f of withRings) {
      const rec = latest.get(f.id);
      if (!rec || !Number.isFinite(rec.vh_mean_db)) continue;
      const delta = rec.vh_mean_db - baseline;
      if (delta < -2) {
        arr.push({
          id: f.id,
          name: f.name || "Unnamed field",
          vh: rec.vh_mean_db,
          delta,
        });
      }
    }
    return arr.sort((a, b) => a.delta - b.delta).slice(0, 4);
  }, [withRings, latest, summary]);

  const handleRefresh = useCallback(
    async (fieldId, { force = false, lookbackDays } = {}) => {
      if (!fieldId) return;
      setRefreshingId(fieldId);
      setRefreshError(null);
      const result = await triggerSarRefresh(fieldId, { force, lookbackDays });
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
        const r = await triggerSarRefresh(f.id, { force });
        if (!r.ok) lastErr = r.error || "Refresh failed";
      }
      setRefreshingId(null);
      if (lastErr) setRefreshError(lastErr);
    },
    [withRings]
  );

  const hasFields = withRings.length > 0;
  const hasAnyData = useMemo(
    () => Array.from(scenes.values()).some((arr) => arr && arr.length > 0),
    [scenes]
  );

  const headerPill = useMemo(() => {
    if (status === "no-supabase")
      return <Pill tone="warn">Sign in to load SAR</Pill>;
    if (status === "error") return <Pill tone="warn">Connection issue</Pill>;
    if (summary.pendingFields > 0) {
      return (
        <Pill tone="info">Ingesting · {summary.pendingFields} field(s)</Pill>
      );
    }
    if (summary.okFields === 0 && hasFields) {
      return <Pill tone="warn">No scenes yet · click Refresh</Pill>;
    }
    if (summary.mostRecent) {
      return (
        <Pill tone="ok">Latest scene · {fmtRelative(summary.mostRecent)}</Pill>
      );
    }
    return null;
  }, [status, summary, hasFields]);

  const queueBusy =
    queueStatus &&
    (Number(queueStatus.queued || 0) > 0 ||
      Number(queueStatus.inflight || 0) > 0);

  const headerActions = (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
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
      <Button
        variant="secondary"
        size="sm"
        onClick={() => handleRefreshAll({ force: false })}
        disabled={!hasFields || refreshingId != null}
      >
        {refreshingId ? "Refreshing…" : "Refresh all from Sentinel-1"}
      </Button>
    </div>
  );

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Remote sensing"
          title="Sentinel-1 SAR backscatter"
          description="Cloud-piercing radar from Sentinel-1. VH dB correlates with vegetation volume; VH/VV ratio tracks canopy structure. On cloudy weeks when NDVI is flagged, SAR gives you a clean reading."
          actions={headerActions}
        />
      }
    >
      {!hasFields ? (
        <Card padding={24}>
          <EmptyState
            kicker="No fields"
            title="Map boundaries to unlock radar"
            description="SAR ingests against your stored field boundaries. Map at least one field, then come back here."
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
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              gap: 8,
            }}
          >
            <div style={{ flex: "1 1 auto", minHeight: 0 }}>
              <FieldMapThree2D
                key={`sar-${mapCenter.lat}-${mapCenter.lng}`}
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
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  flex: "0 0 auto",
                }}
              >
                <LegendSwatch color={vhColor(VH_DB_MIN + 1)} label="Bare / wet" />
                <LegendSwatch color={vhColor((VH_DB_MIN + VH_DB_MAX) / 2)} label="Mid" />
                <LegendSwatch color={vhColor(VH_DB_MAX - 1)} label="Canopy" />
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
                SAR raster
              </label>
              {showRaster && selectedActive ? (
                <>
                  <select
                    value={rasterBand}
                    onChange={(e) => setRasterBand(e.target.value)}
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      padding: "4px 6px",
                      border: `1px solid ${brand.border}`,
                      borderRadius: radius.base,
                      background: brand.white,
                      color: brand.forest,
                      letterSpacing: "0.04em",
                    }}
                    title="Polarisation: VH (vegetation volume), VV (surface / soil), VH/VV ratio (canopy structure)."
                  >
                    <option value="vh">VH (veg volume)</option>
                    <option value="vv">VV (surface)</option>
                    <option value="ratio">VH/VV (structure)</option>
                  </select>
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
                      onChange={(e) =>
                        setRasterOpacity(parseFloat(e.target.value))
                      }
                      style={{ width: 100, accentColor: brand.forest }}
                    />
                  </div>
                </>
              ) : null}
              <Pill tone="info">Median VH {summary.median}</Pill>
              {summary.pendingFields > 0 ? (
                <Pill tone="warn">{summary.pendingFields} pending</Pill>
              ) : null}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 0,
              overflowY: "auto",
              paddingRight: 4,
            }}
            className="tilth-scroll"
          >
            {!hasAnyData ? (
              <Card padding={14}>
                <Kicker style={{ marginBottom: 6 }}>Getting started</Kicker>
                <Body size="sm" style={{ lineHeight: 1.55 }}>
                  No Sentinel-1 scenes are cached yet. Click{" "}
                  <strong>Refresh all from Sentinel-1</strong> in the header to
                  pull the past year of radar scenes for every mapped field —
                  this is the first time so it may take a couple of minutes.
                  Subsequent refreshes are incremental.
                </Body>
              </Card>
            ) : null}

            <Card padding={12}>
              <Subpanel
                kicker={selectedField ? "Selected field" : "Pick a field"}
                title={selectedField?.name || "—"}
                actions={
                  selectedActive ? (
                    <Pill tone="neutral">
                      VH {fmtDb(selectedActive.vh_mean_db)}
                    </Pill>
                  ) : null
                }
                style={{ marginBottom: 0 }}
              >
                <SarCurve
                  scenes={selectedScenes}
                  activeItemId={selectedActive?.item_id || null}
                />
                <SarScrubber
                  scenes={selectedScenes}
                  activeItemId={selectedActive?.item_id || null}
                  onPick={(itemId) => {
                    if (!selectedFieldId) return;
                    setActiveByField((prev) => {
                      const next = new Map(prev);
                      next.set(selectedFieldId, itemId);
                      return next;
                    });
                  }}
                />
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  <Pill tone="neutral">
                    {selectedScenes.filter((s) => s.status === "ok").length}{" "}
                    usable scenes
                  </Pill>
                  <Pill tone="info">Sentinel-1 RTC</Pill>
                  {selectedActive ? (
                    <Pill tone="neutral">
                      {fmtDate(selectedActive.scene_datetime)}
                    </Pill>
                  ) : null}
                  {selectedActive?.orbit_state ? (
                    <Pill
                      tone="neutral"
                      style={{
                        textTransform: "none",
                        letterSpacing: "0.06em",
                      }}
                      title="Sentinel-1 orbit direction. Ascending (~6pm UTC) and descending (~6am UTC) scenes have different incidence angles, so absolute backscatter shifts by 1-3 dB between them. Compare scenes within a single direction for the cleanest time series."
                    >
                      {selectedActive.orbit_state}
                      {Number.isFinite(selectedActive.relative_orbit)
                        ? ` · orbit ${selectedActive.relative_orbit}`
                        : ""}
                    </Pill>
                  ) : null}
                  {selectedActive &&
                  Number.isFinite(selectedActive.vv_mean_db) ? (
                    <Pill
                      tone="neutral"
                      style={{
                        textTransform: "none",
                        letterSpacing: "0.06em",
                      }}
                    >
                      VV {fmtDb(selectedActive.vv_mean_db)}
                    </Pill>
                  ) : null}
                  {selectedActive &&
                  Number.isFinite(selectedActive.vh_vv_ratio_mean_db) ? (
                    <Pill
                      tone="neutral"
                      style={{
                        textTransform: "none",
                        letterSpacing: "0.06em",
                      }}
                      title="VH / VV ratio in dB. Higher = more vegetation volume relative to surface scattering. Useful for canopy-development tracking through cloud."
                    >
                      VH/VV {fmtDb(selectedActive.vh_vv_ratio_mean_db)}
                    </Pill>
                  ) : null}
                </div>
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
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
                          "This deletes the cached SAR scenes for this field and re-runs the ingest from scratch. Continue?"
                        )
                      )
                        return;
                      handleRefresh(selectedFieldId, { force: true });
                    }}
                    disabled={!selectedFieldId || refreshingId != null}
                    title="Wipe cached SAR rows and re-ingest with the current methodology."
                  >
                    Force re-ingest
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      handleRefresh(selectedFieldId, { lookbackDays: 730 })
                    }
                    disabled={!selectedFieldId || refreshingId != null}
                    title="Re-run SAR ingest with a 2-year lookback. Existing rows are kept."
                  >
                    Backfill 2 years
                  </Button>
                </div>
                {refreshError ? (
                  <Body
                    size="sm"
                    style={{
                      marginTop: 6,
                      color: brand.danger,
                      lineHeight: 1.45,
                    }}
                  >
                    {refreshError}
                  </Body>
                ) : null}
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
                          <Pill tone="warn">Δ {f.delta.toFixed(1)} dB</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                ) : (
                  <Body size="sm">
                    Nothing meaningfully below the cohort median for this
                    refresh window.
                  </Body>
                )}
              </Subpanel>
            </Card>

            <Card padding={12} tone="section">
              <Kicker style={{ marginBottom: 6 }}>How to read SAR</Kicker>
              <Body size="sm" style={{ lineHeight: 1.55 }}>
                <strong>VH</strong> (cross-pol) is the headline biomass band:
                higher dB ≈ more vegetation volume. UK arable typically lives
                between <strong>−18 dB</strong> (bare seedbed) and{" "}
                <strong>−10 dB</strong> (peak canopy). <strong>VV</strong>{" "}
                (co-pol) is sensitive to surface roughness and soil moisture
                rather than vegetation, so it spikes after rain. The{" "}
                <strong>VH/VV ratio</strong> in dB cancels out total
                backscatter intensity, isolating canopy structure — handy for
                tracking phenology through cloud.
              </Body>
              <Body size="sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
                <strong>Orbit direction matters.</strong> Ascending (evening
                pass) and descending (morning) scenes look at the same field
                from different incidence angles, so absolute backscatter can
                shift by 1–3 dB. The pill on each scene records the orbit;
                cleanest time-series come from comparing only same-orbit
                scenes if you're chasing small changes.
              </Body>
              {summary.errorFields > 0 ? (
                <Body
                  size="sm"
                  style={{
                    marginTop: 6,
                    color: brand.danger,
                    lineHeight: 1.45,
                  }}
                >
                  {summary.errorFields} field(s) reported a SAR ingest error.
                  Try refreshing — most failures are transient titiler
                  timeouts.
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
      `}</style>
    </WorkspaceFrame>
  );
}

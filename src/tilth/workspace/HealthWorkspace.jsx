import { useEffect, useMemo, useState } from "react";

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
  Stat,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { FieldMapThree2D } from "../FieldMapThree2D.jsx";
import { ringCentroid } from "../geoPointInPolygon.js";
import {
  FLAG_LABELS,
  STAGE_LABELS,
  scoreColor,
  scoreTone,
} from "../../lib/cropHealth.js";
import {
  SPECTRAL_INDEX_LIST,
  formatSpectralValue,
  spectralTone,
} from "../../lib/spectralIndices.js";

/**
 * Crop health workspace — the "what should I do today" view of the
 * farm. One row per field, sorted worst-first, plus a farm-wide map
 * coloured by health score. Click a row → drill through to Satellite
 * (or Radar if the field is cloud-blocked) for the underlying signal.
 *
 * No raw NDVI numbers shown unless they're directly load-bearing for
 * the read. The summary line is the headline; the pills are decoration.
 */

function fmtRelative(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffDays = Math.round((Date.now() - t) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 56) return `${Math.round(diffDays / 7)}w ago`;
  return `${Math.round(diffDays / 30)}mo ago`;
}

function TrendIcon({ trend }) {
  const map = {
    improving: { glyph: "↗", color: brand.ok },
    stable: { glyph: "→", color: brand.muted },
    declining: { glyph: "↘", color: brand.danger },
    unknown: { glyph: "·", color: brand.muted },
  };
  const m = map[trend] || map.unknown;
  return (
    <span
      title={`Trend: ${trend}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        fontFamily: fonts.mono,
        fontSize: 14,
        fontWeight: 600,
        color: m.color,
        flex: "0 0 auto",
      }}
    >
      {m.glyph}
    </span>
  );
}

function StagePill({ stage }) {
  return (
    <Pill
      tone="neutral"
      style={{
        textTransform: "none",
        letterSpacing: "0.06em",
        fontSize: 10,
      }}
    >
      {STAGE_LABELS[stage] || stage}
    </Pill>
  );
}

function ScoreBadge({ score }) {
  const tone = scoreTone(score);
  const color = scoreColor(score);
  const ok = tone === "ok";
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flex: "0 0 auto",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: color,
          boxShadow: ok ? "none" : "0 0 0 2px rgba(0,0,0,0.04)",
        }}
      />
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: brand.forest,
          fontWeight: 600,
          letterSpacing: "0.04em",
          minWidth: 22,
          textAlign: "right",
        }}
      >
        {Number.isFinite(score) ? score : "—"}
      </span>
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

function signalNarrative(rec) {
  if (!rec?.metrics) return [];
  const spectral = rec.metrics.spectral || {};
  const out = [];
  const ndvi = spectral.ndvi ?? rec.metrics.ndviMean;
  const evi = spectral.evi ?? rec.metrics.eviMean;
  const ndmi = spectral.ndmi ?? rec.metrics.ndmiMean;
  const ndwi = spectral.ndwi ?? rec.metrics.ndwiMean;
  const ndre = spectral.ndre ?? rec.metrics.ndreMean;
  const savi = spectral.savi ?? rec.metrics.saviMean;
  const nbr = spectral.nbr ?? rec.metrics.nbrMean;
  if (Number.isFinite(ndvi)) {
    out.push(`NDVI ${formatSpectralValue(ndvi)} sets the broad canopy baseline.`);
  }
  if (Number.isFinite(evi)) {
    out.push(`EVI ${formatSpectralValue(evi)} checks dense-canopy vigour where NDVI can saturate${rec.flags?.includes("dense_canopy_decline") ? " and is currently declining" : ""}.`);
  }
  if (Number.isFinite(ndre)) {
    out.push(`NDRE ${formatSpectralValue(ndre)} reads chlorophyll/nitrogen status${rec.flags?.includes("chlorophyll_stress") ? " and is flagging stress" : ""}.`);
  }
  if (Number.isFinite(savi)) {
    out.push(`SAVI ${formatSpectralValue(savi)} adjusts for bare-soil influence${rec.flags?.includes("thin_canopy") ? " and suggests thin canopy" : ""}.`);
  }
  if (Number.isFinite(ndmi)) {
    out.push(`NDMI ${formatSpectralValue(ndmi)} reads canopy moisture${rec.flags?.includes("water_stress") || rec.flags?.includes("moisture_decline") ? " and is part of the moisture warning" : ""}.`);
  }
  if (Number.isFinite(ndwi)) {
    out.push(`NDWI ${formatSpectralValue(ndwi)} adds surface wetness context${rec.flags?.includes("surface_wetness") ? " and may indicate wet ground" : ""}.`);
  }
  if (Number.isFinite(nbr)) {
    out.push(`NBR ${formatSpectralValue(nbr)} adds residue/exposed-soil or disturbance context${rec.flags?.includes("disturbance_or_exposed_soil") ? " and is flagged for follow-up" : ""}.`);
  }
  return out;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMetric(value, digits = 3) {
  const number = finiteNumber(value);
  return number == null ? null : Number(number.toFixed(digits));
}

function rowMetric(row, id) {
  if (!row) return null;
  const snakeKey = `${id}_mean`;
  const camelKey = `${id}Mean`;
  const value =
    row[snakeKey] ??
    row[camelKey] ??
    row[id] ??
    row.metrics?.spectral?.[id] ??
    row.spectral?.[id];
  return roundMetric(value);
}

function compactScene(row) {
  if (!row) return null;
  return {
    date: String(row.scene_datetime || row.scene_date || "").slice(0, 10),
    status: row.status,
    ...Object.fromEntries(SPECTRAL_INDEX_LIST.map((idx) => [idx.id, rowMetric(row, idx.id)])),
    cloudPct: roundMetric(row.scene_cloud_pct ?? row.sceneCloudPct ?? row.field_cloud_pct ?? row.fieldCloudPct, 1),
    validPixels: finiteNumber(row.valid_pixel_count ?? row.validPixelCount),
    vhDb: roundMetric(row.vh_mean_db ?? row.vhMeanDb ?? row.vh_mean ?? row.vhMean),
    vvDb: roundMetric(row.vv_mean_db ?? row.vvMeanDb ?? row.vv_mean ?? row.vvMean),
    vhVvRatio: roundMetric(row.vh_vv_ratio_mean_db ?? row.vhVvRatioMeanDb ?? row.vh_vv_ratio_mean ?? row.vhVvRatioMean ?? row.vh_vv_ratio),
  };
}

function average(values) {
  const valid = values.map(finiteNumber).filter((value) => value != null);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function trendDirection(change) {
  if (change == null) return "unknown";
  if (Math.abs(change) < 0.02) return "stable";
  return change > 0 ? "improving" : "declining";
}

function buildSpectralTimeSeriesSummary(scenes) {
  const rows = (scenes || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const byIndex = Object.fromEntries(SPECTRAL_INDEX_LIST.map((idx) => {
    const points = rows
      .map((row) => ({ date: row.date, value: finiteNumber(row[idx.id]) }))
      .filter((point) => point.date && point.value != null);
    const first = points[0] || null;
    const latest = points.at(-1) || null;
    const previous = points.at(-2) || null;
    const changeFromFirst = first && latest ? latest.value - first.value : null;
    const recentChange = previous && latest ? latest.value - previous.value : null;
    return [idx.id, {
      label: idx.label,
      observations: points.length,
      firstDate: first?.date || null,
      latestDate: latest?.date || null,
      firstValue: roundMetric(first?.value),
      latestValue: roundMetric(latest?.value),
      average: roundMetric(average(points.map((point) => point.value))),
      changeFromFirst: roundMetric(changeFromFirst),
      recentChange: roundMetric(recentChange),
      direction: trendDirection(changeFromFirst),
      recentPoints: points.slice(-8).map((point) => ({
        date: point.date,
        value: roundMetric(point.value),
      })),
    }];
  }));

  return {
    sceneCount: rows.length,
    dateRange: rows.length ? {
      first: rows[0].date,
      latest: rows.at(-1).date,
    } : null,
    byIndex,
  };
}

export function HealthWorkspace({ farm, fields, farmHealth, onNavigate }) {
  const farmId = farm?.id || null;
  const withRings = useMemo(
    () =>
      (fields || []).filter(
        (f) => Array.isArray(f.boundary) && f.boundary.length >= 3
      ),
    [fields]
  );

  const { health, cohort, status } = farmHealth;

  // Sortable rows derived from the health map. Worst-first is the
  // useful default — that's the row the user should look at.
  const [sortMode, setSortMode] = useState("score-asc"); // score-asc | name | recent
  const [selectedFieldId, setSelectedFieldId] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const isMobileView = useNarrowViewport();

  useEffect(() => {
    if (isMobileView) {
      setMapReady(false);
      return undefined;
    }
    setMapReady(false);
    const id = window.setTimeout(() => setMapReady(true), 120);
    return () => window.clearTimeout(id);
  }, [isMobileView, withRings.length]);

  const rows = useMemo(() => {
    const arr = withRings.map((f) => {
      const rec = health.get(f.id) || null;
      return {
        id: f.id,
        name: f.name || "Unnamed field",
        field: f,
        rec,
      };
    });
    if (sortMode === "score-asc") {
      arr.sort((a, b) => {
        const sa = Number.isFinite(a.rec?.score) ? a.rec.score : 999;
        const sb = Number.isFinite(b.rec?.score) ? b.rec.score : 999;
        return sa - sb;
      });
    } else if (sortMode === "name") {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "recent") {
      arr.sort(
        (a, b) =>
          (b.rec?.latest?.scene_datetime
            ? new Date(b.rec.latest.scene_datetime).getTime()
            : 0) -
          (a.rec?.latest?.scene_datetime
            ? new Date(a.rec.latest.scene_datetime).getTime()
            : 0)
      );
    }
    return arr;
  }, [withRings, health, sortMode]);

  // Choropleth — colour each field by health score so the farm map
  // doubles as a status board.
  const choropleth = useMemo(() => {
    const out = {};
    for (const f of withRings) {
      const rec = health.get(f.id);
      if (rec && Number.isFinite(rec.score)) {
        out[f.id] = {
          value: String(rec.score),
          color: scoreColor(rec.score),
        };
      }
    }
    return out;
  }, [withRings, health]);

  const mapCenter = useMemo(() => {
    const target =
      withRings.find((f) => f.id === selectedFieldId) || withRings[0];
    if (!target) return { lat: 54, lng: -2, zoom: 6 };
    const c = ringCentroid(target.boundary);
    return { lat: c.lat, lng: c.lng, zoom: selectedFieldId ? 14 : 12 };
  }, [selectedFieldId, withRings]);

  const askAssistantForField = async (field, rec) => {
    if (!field?.id || !rec || !farmId) return;
    const ndviScenes = (farmHealth.ndvi?.scenes?.get(field.id) || []).slice(0, 12).map(compactScene);
    const sarScenes = (farmHealth.sar?.scenes?.get(field.id) || []).slice(0, 8).map(compactScene);
    const spectralTimeSeries = buildSpectralTimeSeriesSummary(ndviScenes);
    const payload = {
      field: {
        id: field.id,
        name: field.name || "Unnamed field",
        areaHa: field.areaHa ?? field.area_ha ?? null,
      },
      health: {
        score: rec.score,
        trend: rec.trend,
        stage: STAGE_LABELS[rec.stage] || rec.stage,
        confidence: rec.confidence,
        summary: rec.summary,
        flags: (rec.flags || []).map((flag) => FLAG_LABELS[flag] || flag),
        warnings: rec.warnings || [],
      },
      currentSpectralMeans: SPECTRAL_INDEX_LIST.reduce((acc, idx) => {
        const value = finiteNumber(rec.metrics?.spectral?.[idx.id] ?? rec.metrics?.[`${idx.id}Mean`]);
        if (value != null) acc[idx.id] = Number(value.toFixed(4));
        return acc;
      }, {}),
      spectralInterpretationNotes: signalNarrative(rec),
      spectralTimeSeries,
      recentSentinel2Scenes: ndviScenes,
      recentSentinel1Scenes: sarScenes,
      cohort: {
        medianNdvi: Number.isFinite(cohort.median) ? Number(cohort.median.toFixed(4)) : null,
        stdevNdvi: Number.isFinite(cohort.stdev) ? Number(cohort.stdev.toFixed(4)) : null,
      },
    };

    const prompt = [
      `Produce a short crop-health report for "${payload.field.name}" in its current state.`,
      "Use all available evidence, not just NDVI: NDVI, EVI, NDWI, NDMI, NDRE, SAVI, NBR, Sentinel-1 radar if present, warnings, stage, confidence, and recent trends.",
      "Use the spectralTimeSeries object to discuss movement over time. Compare latest values with first values, recent changes, direction and recentPoints for each index rather than only describing the current snapshot.",
      "If a time-series has too few observations for an index, say that clearly and avoid over-interpreting it.",
      "Explain what the results probably mean, any uncertainty or data gaps, and give practical next-step suggestions for a farm manager.",
      "Keep it concise with headings: Current read, What the indices are saying, Suggested checks/actions.",
      "Write the report only. Do not create suggested actions, confirmation tasks, or records.",
      "",
      "Field data summary JSON:",
      JSON.stringify(payload),
    ].join("\n");

    window.dispatchEvent(new CustomEvent("tilth:assistant-request", {
      detail: {
        mode: "chat",
        scope: "fields_satellite",
        allowActions: false,
        displayMessage: `Interpret crop health for ${payload.field.name}`,
        message: prompt,
      },
    }));
  };

  // Whole-farm summary numbers for the header strip.
  const summary = useMemo(() => {
    let attention = 0;
    let critical = 0;
    let healthy = 0;
    let inSeason = 0;
    let mostRecent = 0;
    for (const rec of health.values()) {
      if (!rec) continue;
      const t = rec.latest?.scene_datetime
        ? new Date(rec.latest.scene_datetime).getTime()
        : 0;
      if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
      const tone = scoreTone(rec.score);
      if (tone === "danger") critical += 1;
      else if (tone === "warn") attention += 1;
      else if (tone === "ok") healthy += 1;
      if (rec.stage !== "bare" && rec.stage !== "harvested" && rec.stage !== "unknown") {
        inSeason += 1;
      }
    }
    return {
      attention,
      critical,
      healthy,
      total: rows.length,
      inSeason,
      mostRecent: mostRecent ? new Date(mostRecent).toISOString() : null,
    };
  }, [health, rows.length]);

  const headerActions = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {summary.mostRecent ? (
        <Pill tone="info" style={{ textTransform: "none", letterSpacing: "0.06em" }}>
          Most recent scene · {fmtRelative(summary.mostRecent)}
        </Pill>
      ) : status === "loading" ? (
        <Pill tone="neutral">Loading farm…</Pill>
      ) : null}
      {Number.isFinite(cohort.median) ? (
        <Pill tone="neutral" style={{ textTransform: "none", letterSpacing: "0.06em" }}>
          Cohort median NDVI {cohort.median.toFixed(2)}
        </Pill>
      ) : null}
    </div>
  );

  if (!withRings.length) {
    return (
      <WorkspaceFrame
        header={
          <SectionHeader
            kicker="Insights"
            title="Crop health"
            description="Per-field status calls. Sorted worst-first so you see what needs attention immediately."
          />
        }
      >
        <Card padding={24}>
          <EmptyState
            kicker="No fields"
            title="Map boundaries to unlock crop health"
            description="Health derives from satellite NDVI and Sentinel-1 SAR over your stored field boundaries. Map at least one field, then come back here."
          />
        </Card>
      </WorkspaceFrame>
    );
  }

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Insights"
          title="Crop health"
          description="Per-field health score blending satellite vegetation and radar data. Sorted worst-first — fields that need attention are always at the top. Data refreshes automatically."
          actions={headerActions}
        />
      }
    >
      <div
        className="tilth-health-layout"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 420px)",
          gap: 12,
          overflow: "hidden",
        }}
      >
        <div
          className="tilth-health-map-column"
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            gap: 10,
          }}
        >
          <div
            className="tilth-health-stats"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 8,
              flex: "0 0 auto",
            }}
          >
            <Stat
              kicker="Total"
              value={String(summary.total)}
              sub={`${summary.inSeason} in season`}
              tone="forest"
            />
            <Stat
              kicker="Healthy"
              value={String(summary.healthy)}
              sub={
                summary.total > 0
                  ? `${Math.round((summary.healthy / summary.total) * 100)}% of farm`
                  : "—"
              }
            />
            <Stat
              kicker="Attention"
              value={String(summary.attention)}
              sub={summary.attention > 0 ? "Worth a walk-over" : "All quiet"}
            />
            <Stat
              kicker="Critical"
              value={String(summary.critical)}
              sub={summary.critical > 0 ? "Urgent" : "—"}
            />
          </div>

          {!isMobileView ? (
            <Card
              className="tilth-health-map-card"
              padding={0}
              style={{
                flex: "1 1 auto",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {mapReady ? (
                <FieldMapThree2D
                  center={[mapCenter.lat, mapCenter.lng]}
                  zoom={mapCenter.zoom}
                  savedFields={withRings}
                  draftRing={[]}
                  mapMode="pan"
                  basemap="satellite"
                  choropleth={choropleth}
                  selectedFieldId={selectedFieldId}
                  onSelectField={setSelectedFieldId}
                  height="100%"
                />
              ) : (
                <div
                  style={{
                    flex: "1 1 auto",
                    display: "grid",
                    placeItems: "center",
                    minHeight: 240,
                    color: brand.muted,
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  Loading map…
                </div>
              )}
            </Card>
          ) : null}

          {!isMobileView ? (
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
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: brand.muted,
                }}
              >
                Health legend
              </span>
              <LegendDot color={scoreColor(85)} label="Healthy >= 70" />
              <LegendDot color={scoreColor(55)} label="Attention 45-69" />
              <LegendDot color={scoreColor(20)} label="Critical < 45" />
            </div>
          ) : null}
        </div>

        <div
          className="tilth-health-side"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Card
            className="tilth-health-list-card"
            padding={12}
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <Kicker>Field-by-field · {rows.length}</Kicker>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value)}
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10.5,
                  padding: "4px 6px",
                  border: `1px solid ${brand.border}`,
                  borderRadius: radius.base,
                  background: brand.white,
                  color: brand.forest,
                  letterSpacing: "0.04em",
                }}
              >
                <option value="score-asc">Worst first</option>
                <option value="name">A–Z</option>
                <option value="recent">Most recent</option>
              </select>
            </div>
            <div
              className="tilth-health-rows tilth-scroll"
              style={{
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
                paddingRight: 4,
                display: "grid",
                gap: 6,
                alignContent: "start",
              }}
            >
              {rows.map(({ id, name, field, rec }) => (
                <Row
                  key={id}
                  onClick={() => setSelectedFieldId(id)}
                  active={selectedFieldId === id}
                  style={{ padding: "10px 12px" }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        color: brand.forest,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: "1 1 auto",
                        minWidth: 0,
                      }}
                    >
                      {name}
                    </span>
                    <TrendIcon trend={rec?.trend || "unknown"} />
                    <ScoreBadge score={rec?.score} />
                  </div>
                  <Body
                    size="sm"
                    style={{
                      lineHeight: 1.45,
                      marginBottom: 6,
                      color: brand.bodySoft,
                    }}
                  >
                    {rec?.summary || "Loading…"}
                  </Body>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    {rec ? <StagePill stage={rec.stage} /> : null}
                    {rec?.flags?.slice(0, 3).map((flag) => (
                      <Pill
                        key={flag}
                        tone={
                          flag === "late_emergence" || flag === "stuck"
                            ? "danger"
                            : "warn"
                        }
                        style={{
                          textTransform: "none",
                          letterSpacing: "0.06em",
                          fontSize: 10,
                        }}
                      >
                        {FLAG_LABELS[flag] || flag}
                      </Pill>
                    ))}
                    {rec?.confidence === "low" ? (
                      <Pill
                        tone="neutral"
                        style={{
                          textTransform: "none",
                          letterSpacing: "0.06em",
                          fontSize: 10,
                        }}
                        title="Health score has low confidence — too few clean scenes or stale data."
                      >
                        Low confidence
                      </Pill>
                    ) : null}
                    {rec?.latest?.scene_datetime ? (
                      <span
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 9.5,
                          color: brand.muted,
                          letterSpacing: "0.06em",
                          marginLeft: "auto",
                        }}
                      >
                        {fmtRelative(rec.latest.scene_datetime)}
                      </span>
                    ) : null}
                  </div>
                  {selectedFieldId === id ? (
                    <div
                      style={{
                        marginTop: 8,
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      {rec?.warnings?.length ? (
                        <div
                          style={{
                            padding: "8px 10px",
                            border: `1px solid ${scoreColor(rec.score)}33`,
                            background: brand.bgSection,
                            borderRadius: radius.base,
                            display: "grid",
                            gap: 3,
                          }}
                        >
                          <div
                            style={{
                              fontFamily: fonts.sans,
                              fontSize: 12,
                              fontWeight: 600,
                              color: brand.forest,
                            }}
                          >
                            {rec.warnings[0].title}
                          </div>
                          <Body size="sm" color={brand.bodySoft}>
                            {rec.warnings[0].detail}
                          </Body>
                          <Body size="sm" color={brand.muted}>
                            Next check: {rec.warnings[0].action}
                          </Body>
                        </div>
                      ) : null}
                      {rec?.metrics ? (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                          }}
                        >
                          {SPECTRAL_INDEX_LIST.map((idx) => {
                            const value = rec.metrics.spectral?.[idx.id] ?? rec.metrics[`${idx.id}Mean`];
                            return Number.isFinite(value) ? (
                            <Pill
                              key={idx.id}
                              tone={spectralTone(value, idx.id)}
                              style={{ textTransform: "none", letterSpacing: "0.04em", fontSize: 9 }}
                              title={idx.interpretation}
                            >
                              {idx.label} {formatSpectralValue(value)}
                            </Pill>
                            ) : null;
                          })}
                        </div>
                      ) : null}
                      {signalNarrative(rec).length ? (
                        <div
                          style={{
                            padding: "8px 10px",
                            background: brand.bgSection,
                            border: `1px solid ${brand.border}`,
                            borderRadius: radius.base,
                            display: "grid",
                            gap: 4,
                          }}
                        >
                          <Kicker>Spectral interpretation</Kicker>
                          {signalNarrative(rec).slice(0, 5).map((line) => (
                            <Body key={line} size="sm" color={brand.bodySoft}>
                              {line}
                            </Body>
                          ))}
                        </div>
                      ) : null}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={!rec || !farmId}
                          onClick={(e) => {
                            e.stopPropagation();
                            askAssistantForField(field, rec);
                          }}
                          style={{ minHeight: 32, padding: "6px 9px", fontSize: 10 }}
                        >
                          Ask assistant
                        </Button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigate?.("sensing");
                          }}
                          style={navButtonStyle}
                        >
                          Open remote sensing →
                        </button>
                      </div>
                    </div>
                  ) : null}
                </Row>
              ))}
            </div>
          </Card>

          <Card padding={12} tone="section" style={{ flex: "0 0 auto" }}>
            <Kicker style={{ marginBottom: 6 }}>What does the score mean?</Kicker>
            <Body size="sm" style={{ lineHeight: 1.55 }}>
              The score blends the full Sentinel-2 spectral stack with radar
              context: NDVI for canopy cover, EVI for dense-canopy vigour,
              NDRE for chlorophyll, SAVI for soil-adjusted canopy, NDMI/NDWI
              for moisture and wetness, and NBR for disturbance or exposed
              soil context. Stage, trend, farm cohort position, data freshness,
              cloud/radar disagreement, and anomaly flags adjust the score.
              Scores ≥ 70 are healthy; 45–69 is worth a closer look; under 45
              is critical.
            </Body>
          </Card>
        </div>
      </div>

      <style>{`
        @media (max-width: 1180px) {
          .tilth-health-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .tilth-health-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
            gap: 12px !important;
            padding-bottom: 18px !important;
          }
          .tilth-health-map-column,
          .tilth-health-side,
          .tilth-health-list-card {
            flex: 0 0 auto !important;
            min-height: auto !important;
            overflow: visible !important;
          }
          .tilth-health-stats {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .tilth-health-map-card {
            flex: 0 0 auto !important;
            height: min(48dvh, 360px) !important;
            min-height: 260px !important;
          }
          .tilth-health-rows {
            flex: 0 0 auto !important;
            min-height: auto !important;
            overflow: visible !important;
            padding-right: 0 !important;
          }
          .tilth-health-rows > * {
            min-width: 0;
          }
        }
        @media (max-width: 430px) {
          .tilth-health-stats {
            grid-template-columns: 1fr !important;
          }
          .tilth-health-map-card {
            height: 42dvh !important;
            min-height: 240px !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

const navButtonStyle = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: brand.forest,
  background: brand.white,
  border: `1px solid ${brand.border}`,
  padding: "5px 8px",
  borderRadius: radius.base,
  cursor: "pointer",
};

function LegendDot({ color, label }) {
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
        style={{ width: 10, height: 10, background: color, borderRadius: 999 }}
      />
      {label}
    </div>
  );
}

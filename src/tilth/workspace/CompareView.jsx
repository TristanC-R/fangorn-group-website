import { useState, useMemo } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Card,
  Kicker,
  Pill,
  Body,
  EmptyState,
} from "../ui/primitives.jsx";
import { tilthStore } from "../state/localStore.js";
import {
  daysSincePlanting,
  expectedStage,
  cropTimeline,
} from "../../lib/cropPhenology.js";
import {
  STAGE_LABELS,
  FLAG_LABELS,
  scoreTone,
  scoreColor,
  useFarmHealth,
} from "../../lib/cropHealth.js";
import { ringAreaSqDeg } from "../geoPointInPolygon.js";

const MAX_SELECTED = 4;
const SPARKLINE_W = 200;
const SPARKLINE_H = 40;
const SPARKLINE_SCENES = 20;
const COL_MIN = 250;

const TREND_ARROW = { improving: "\u2197", stable: "\u2192", declining: "\u2198", unknown: "\u2014" };

function fieldName(f) {
  return f?.name || f?.id?.slice(0, 8) || "Field";
}

function fmt(n, dp = 2) {
  if (!Number.isFinite(n)) return "\u2014";
  return n.toFixed(dp);
}

function fmtDate(iso) {
  if (!iso) return "\u2014";
  try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
}

function NdviSparkline({ scenes, yMin, yMax, warn }) {
  if (!scenes || !scenes.length) {
    return (
      <div style={{ width: SPARKLINE_W, height: SPARKLINE_H, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Body size="sm" color={brand.muted}>No data</Body>
      </div>
    );
  }
  const range = yMax - yMin || 1;
  const gap = SPARKLINE_W / Math.max(scenes.length - 1, 1);
  const pts = scenes.map((v, i) => {
    const x = i * gap;
    const y = SPARKLINE_H - ((v - yMin) / range) * SPARKLINE_H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const polyline = pts.join(" ");
  const fill = pts.concat([
    `${((scenes.length - 1) * gap).toFixed(1)},${SPARKLINE_H}`,
    `0,${SPARKLINE_H}`,
  ]).join(" ");

  return (
    <div style={{ background: warn ? brand.warnSoft : "transparent", borderRadius: radius.base, padding: 4 }}>
      <svg width={SPARKLINE_W} height={SPARKLINE_H} viewBox={`0 0 ${SPARKLINE_W} ${SPARKLINE_H}`} style={{ display: "block" }}>
        <polygon points={fill} fill={warn ? "rgba(192,124,18,0.12)" : "rgba(16,78,63,0.08)"} />
        <polyline points={polyline} fill="none" stroke={warn ? brand.warn : brand.forest} strokeWidth={1.5} strokeLinejoin="round" />
        {scenes.length > 0 && (
          <circle
            cx={((scenes.length - 1) * gap).toFixed(1)}
            cy={(SPARKLINE_H - ((scenes[scenes.length - 1] - yMin) / range) * SPARKLINE_H).toFixed(1)}
            r={3}
            fill={warn ? brand.warn : brand.forest}
          />
        )}
      </svg>
    </div>
  );
}

function ScoreCircle({ score }) {
  const color = scoreColor(score);
  return (
    <div style={{
      width: 32, height: 32, borderRadius: "50%", background: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, color: brand.white,
    }}>
      {Number.isFinite(score) ? score : "?"}
    </div>
  );
}

function StageBar({ stages, currentIndex, progress }) {
  if (!stages || !stages.length) return null;
  return (
    <div style={{ display: "flex", gap: 1, height: 8, borderRadius: radius.base, overflow: "hidden" }}>
      {stages.map((s, i) => {
        const isCurrent = i === currentIndex;
        const isPast = i < currentIndex;
        let bg = brand.bgSection;
        if (isPast) bg = brand.moss;
        else if (isCurrent) bg = brand.forest;

        const span = s.endDay - s.startDay;
        return (
          <div
            key={s.name}
            title={s.name}
            style={{
              flex: `${span} 0 0`,
              background: isCurrent
                ? `linear-gradient(to right, ${brand.forest} ${(progress * 100).toFixed(0)}%, ${brand.border} ${(progress * 100).toFixed(0)}%)`
                : bg,
              minWidth: 2,
            }}
          />
        );
      })}
    </div>
  );
}

function DeltaArrow({ a, b, unit, invert }) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = a - b;
  if (Math.abs(diff) < 0.005) return null;
  const positive = invert ? diff < 0 : diff > 0;
  return (
    <span style={{
      fontFamily: fonts.mono, fontSize: 10,
      color: positive ? brand.ok : brand.danger,
    }}>
      {diff > 0 ? "+" : ""}{fmt(diff)}{unit || ""}
    </span>
  );
}

function SectionRow({ label, children }) {
  return (
    <Card padding={14} style={{ marginBottom: 8 }}>
      <Kicker style={{ marginBottom: 10 }}>{label}</Kicker>
      <div className="tilth-compare-row" style={{ display: "flex", gap: 12 }}>
        {children}
      </div>
    </Card>
  );
}

function FieldCol({ children, style }) {
  return (
    <div className="tilth-compare-col" style={{ flex: `1 0 ${COL_MIN}px`, minWidth: COL_MIN, maxWidth: 320, ...style }}>
      {children}
    </div>
  );
}

export function CompareView({ fields, farmId }) {
  const [selected, setSelected] = useState([]);

  const plantingsMap = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);
  const farmHealth = useFarmHealth(fields, plantingsMap);

  const toggle = (id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SELECTED) return prev;
      return [...prev, id];
    });
  };

  const fieldMap = useMemo(() => {
    const m = new Map();
    for (const f of fields || []) if (f?.id) m.set(f.id, f);
    return m;
  }, [fields]);

  const healthMap = farmHealth?.health;
  const ndviScenesMap = farmHealth?.ndvi?.scenes;

  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const yieldData = useMemo(() => tilthStore.loadYield(farmId), [farmId]);
  const fieldAttrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);
  const plantings = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);

  const chosen = selected.map((id) => fieldMap.get(id)).filter(Boolean);

  const ndviMeans = useMemo(() => {
    const out = {};
    for (const f of chosen) {
      const h = healthMap?.get(f.id);
      out[f.id] = h?.metrics?.ndviMean ?? null;
    }
    return out;
  }, [chosen, healthMap]);

  const globalNdviRange = useMemo(() => {
    let lo = 1, hi = 0;
    for (const f of chosen) {
      const raw = ndviScenesMap?.get(f.id);
      if (!raw) continue;
      const clean = raw.filter((s) => s?.status === "ok" && Number.isFinite(s.ndvi_mean));
      const sorted = clean.slice().sort((a, b) => new Date(a.scene_datetime) - new Date(b.scene_datetime));
      const last = sorted.slice(-SPARKLINE_SCENES);
      for (const s of last) {
        if (s.ndvi_mean < lo) lo = s.ndvi_mean;
        if (s.ndvi_mean > hi) hi = s.ndvi_mean;
      }
    }
    if (lo > hi) return { lo: 0, hi: 1 };
    const pad = (hi - lo) * 0.1 || 0.05;
    return { lo: Math.max(0, lo - pad), hi: Math.min(1, hi + pad) };
  }, [chosen, ndviScenesMap]);

  const sparklines = useMemo(() => {
    const out = {};
    for (const f of chosen) {
      const raw = ndviScenesMap?.get(f.id);
      if (!raw) { out[f.id] = []; continue; }
      const clean = raw.filter((s) => s?.status === "ok" && Number.isFinite(s.ndvi_mean));
      const sorted = clean.slice().sort((a, b) => new Date(a.scene_datetime) - new Date(b.scene_datetime));
      out[f.id] = sorted.slice(-SPARKLINE_SCENES).map((s) => s.ndvi_mean);
    }
    return out;
  }, [chosen, ndviScenesMap]);

  const maxNdviMean = useMemo(() => {
    let mx = -Infinity;
    for (const v of Object.values(ndviMeans)) if (Number.isFinite(v) && v > mx) mx = v;
    return Number.isFinite(mx) ? mx : null;
  }, [ndviMeans]);

  const inputSummaries = useMemo(() => {
    const out = {};
    for (const f of chosen) {
      let totalN = 0, sprays = 0, count = 0;
      for (const r of records) {
        if (r.fieldId !== f.id) continue;
        count++;
        if (r.type === "fertiliser" && Number.isFinite(r.nKgHa)) totalN += r.nKgHa;
        if (r.type === "spray") sprays++;
      }
      out[f.id] = { count, totalN, sprays };
    }
    return out;
  }, [chosen, records]);

  const currentYear = new Date().getFullYear();
  const yieldSummaries = useMemo(() => {
    const out = {};
    for (const f of chosen) {
      const fy = yieldData?.[f.id];
      if (!fy) { out[f.id] = null; continue; }
      const yearEntry = Array.isArray(fy)
        ? fy.find((y) => y.year === currentYear || y.year === String(currentYear))
        : fy.year === currentYear || fy.year === String(currentYear)
          ? fy
          : null;
      out[f.id] = yearEntry?.tHa ?? yearEntry?.tha ?? yearEntry?.yieldTHa ?? null;
    }
    return out;
  }, [chosen, yieldData, currentYear]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Field chips */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 0",
        borderBottom: `1px solid ${brand.border}`, marginBottom: 10,
      }}>
        {(fields || []).map((f) => {
          const active = selected.includes(f.id);
          const h = healthMap?.get(f.id);
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => toggle(f.id)}
              style={{
                fontFamily: fonts.sans, fontSize: 12, fontWeight: active ? 600 : 400,
                padding: "5px 10px", borderRadius: radius.pill,
                border: `2px solid ${active ? brand.forest : brand.border}`,
                background: active ? brand.bgSection : brand.white,
                color: brand.forest, cursor: "pointer",
                transition: "border-color 140ms ease, background 140ms ease",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              {h && (
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: scoreColor(h.score), display: "inline-block",
                }} />
              )}
              {fieldName(f)}
            </button>
          );
        })}
        {selected.length > 0 && selected.length < MAX_SELECTED && (
          <Body size="sm" color={brand.muted} style={{ alignSelf: "center", marginLeft: 6 }}>
            {selected.length}/{MAX_SELECTED} selected
          </Body>
        )}
      </div>

      {/* Content */}
      {chosen.length < 2 ? (
        <EmptyState
          kicker="Compare"
          title="Select 2\u20134 fields to compare"
          description="Click the field chips above to pick fields for a side-by-side comparison of health, inputs, yield and more."
        />
      ) : (
        <div className="tilth-compare-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "auto" }}>
          {/* Column headers */}
          <div className="tilth-compare-header" style={{ display: "flex", gap: 12, marginBottom: 8, position: "sticky", top: 0, zIndex: 10, background: brand.white, padding: "8px 0 6px", boxShadow: `0 1px 0 ${brand.border}` }}>
            {chosen.map((f) => (
              <FieldCol key={f.id}>
                <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: brand.forest }}>
                  {fieldName(f)}
                </div>
                {f.boundary && (
                  <Body size="sm" color={brand.muted}>
                    {(ringAreaSqDeg(f.boundary) * 12_365_000).toFixed(1)} ha (approx)
                  </Body>
                )}
              </FieldCol>
            ))}
          </div>

          {/* 1. Health summary */}
          <SectionRow label="Health summary">
            {chosen.map((f) => {
              const h = healthMap?.get(f.id);
              if (!h) return <FieldCol key={f.id}><Body size="sm" color={brand.muted}>No health data</Body></FieldCol>;
              return (
                <FieldCol key={f.id}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <ScoreCircle score={h.score} />
                    <div>
                      <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest }}>
                        {STAGE_LABELS[h.stage] || h.stage} {TREND_ARROW[h.trend] || ""}
                      </div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                        Score {h.score} &middot; {h.confidence} conf.
                      </div>
                    </div>
                  </div>
                  <Body size="sm" style={{ lineHeight: 1.45 }}>{h.summary}</Body>
                  {h.flags.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {h.flags.map((fl) => (
                        <Pill key={fl} tone={scoreTone(h.score)} style={{ fontSize: 9 }}>
                          {FLAG_LABELS[fl] || fl}
                        </Pill>
                      ))}
                    </div>
                  )}
                </FieldCol>
              );
            })}
          </SectionRow>

          {/* 2. Crop & planting */}
          <SectionRow label="Crop &amp; planting">
            {chosen.map((f) => {
              const p = plantings?.[f.id]?.[0];
              const crop = p?.crop || fieldAttrs?.[f.id]?.crop;
              const pDate = p?.plantingDate;
              const dsp = daysSincePlanting(pDate);
              const stage = crop && dsp != null ? expectedStage(crop, dsp) : null;
              const timeline = crop ? cropTimeline(crop) : null;

              return (
                <FieldCol key={f.id}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest, marginBottom: 4 }}>
                    {crop || "Unknown crop"}
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.bodySoft, marginBottom: 4 }}>
                    Planted: {fmtDate(pDate)}{dsp != null ? ` (${dsp}d ago)` : ""}
                  </div>
                  {stage && (
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest, marginBottom: 6 }}>
                      Stage: <strong>{stage.stageName}</strong>
                      {stage.isLate && <span style={{ color: brand.warn, marginLeft: 4 }}>(late)</span>}
                    </div>
                  )}
                  {timeline && stage && (
                    <StageBar stages={timeline.stages} currentIndex={stage.stageIndex} progress={stage.progress} />
                  )}
                </FieldCol>
              );
            })}
          </SectionRow>

          {/* 3. NDVI sparklines */}
          <SectionRow label="NDVI trend">
            {chosen.map((f) => {
              const vals = sparklines[f.id] || [];
              const mean = ndviMeans[f.id];
              const warnLow = Number.isFinite(mean) && Number.isFinite(maxNdviMean) && (maxNdviMean - mean) > 0.1;
              return (
                <FieldCol key={f.id}>
                  <NdviSparkline
                    scenes={vals}
                    yMin={globalNdviRange.lo}
                    yMax={globalNdviRange.hi}
                    warn={warnLow}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <span style={{ fontFamily: fonts.mono, fontSize: 11, color: brand.forest }}>
                      {fmt(mean)}
                    </span>
                    {Number.isFinite(maxNdviMean) && Number.isFinite(mean) && maxNdviMean !== mean && (
                      <DeltaArrow a={mean} b={maxNdviMean} />
                    )}
                    {warnLow && (
                      <Pill tone="warn" style={{ fontSize: 9 }}>Below others</Pill>
                    )}
                  </div>
                </FieldCol>
              );
            })}
          </SectionRow>

          {/* 4. Input summary */}
          <SectionRow label="Input summary">
            {chosen.map((f) => {
              const s = inputSummaries[f.id] || { count: 0, totalN: 0, sprays: 0 };
              return (
                <FieldCol key={f.id}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <MiniStat label="Records" value={s.count} />
                    <MiniStat label="N (kg/ha)" value={fmt(s.totalN, 1)} />
                    <MiniStat label="Sprays" value={s.sprays} />
                  </div>
                </FieldCol>
              );
            })}
          </SectionRow>

          {/* 5. Yield comparison */}
          <SectionRow label={`Yield ${currentYear}`}>
            {chosen.map((f) => {
              const y = yieldSummaries[f.id];
              return (
                <FieldCol key={f.id}>
                  <div style={{ fontFamily: fonts.serif, fontSize: 24, color: brand.forest }}>
                    {Number.isFinite(y) ? `${fmt(y, 1)} t/ha` : "\u2014"}
                  </div>
                </FieldCol>
              );
            })}
          </SectionRow>

          {/* 6. Soil & terrain */}
          <SectionRow label="Soil &amp; terrain">
            {chosen.map((f) => {
              const a = fieldAttrs?.[f.id] || {};
              return (
                <FieldCol key={f.id}>
                  <AttrRow label="Soil type" value={a.soilType || a.soil || "\u2014"} />
                  <AttrRow label="Land use" value={a.landUse || a.landuse || "\u2014"} />
                  {a.elevation != null && <AttrRow label="Elevation" value={`${a.elevation}m`} />}
                </FieldCol>
              );
            })}
          </SectionRow>
        </div>
      )}
      <style>{`
        @media (max-width: 760px) {
          .tilth-compare-scroll {
            overflow-x: auto !important;
            -webkit-overflow-scrolling: touch;
          }
          .tilth-compare-header,
          .tilth-compare-row {
            width: max-content !important;
            min-width: 100% !important;
          }
          .tilth-compare-header {
            background: ${brand.white} !important;
            border-bottom: 1px solid ${brand.border} !important;
            padding: 8px 10px 6px !important;
            margin-left: -10px !important;
            margin-right: -10px !important;
          }
          .tilth-compare-col {
            flex-basis: 210px !important;
            min-width: 210px !important;
            max-width: 240px !important;
          }
        }
      `}</style>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.muted }}>
        {label}
      </div>
      <div style={{ fontFamily: fonts.serif, fontSize: 18, color: brand.forest, lineHeight: 1.2 }}>
        {value}
      </div>
    </div>
  );
}

function AttrRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px solid ${brand.borderSoft}` }}>
      <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>
        {label}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest }}>
        {value}
      </span>
    </div>
  );
}

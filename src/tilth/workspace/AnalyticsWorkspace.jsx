import { useEffect, useMemo, useState } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  EmptyState,
  Kicker,
  Pill,
  SectionHeader,
  Stat,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { tilthStore } from "../state/localStore.js";
import { ringAreaSqDeg } from "../geoPointInPolygon.js";
import {
  scoreColor,
  STAGE_LABELS,
} from "../../lib/cropHealth.js";
import { SPECTRAL_INDEX_LIST, formatSpectralValue } from "../../lib/spectralIndices.js";

const N_FRACTIONS = {
  nitram: 0.345,
  "yara-yaramila": 0.18,
  "roundup-flex": 0,
  "atlantis-od": 0,
  "decis-forte": 0,
};

function approxHectares(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(boundary));
  const midLat = boundary.reduce((a, p) => a + p.lat, 0) / boundary.length;
  const mLat = 111_132;
  const mLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(0, (sqDeg * mLat * mLng) / 10_000);
}

function pearson(pairs) {
  const c = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (c.length < 3) return null;
  const n = c.length;
  const mx = c.reduce((a, p) => a + p[0], 0) / n;
  const my = c.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (const [x, y] of c) {
    const dx = x - mx, dy = y - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return dx2 === 0 || dy2 === 0 ? null : num / Math.sqrt(dx2 * dy2);
}

function triggerDownload(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const d = Math.round((Date.now() - t) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 7) return `${d}d ago`;
  if (d < 56) return `${Math.round(d / 7)}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

export function AnalyticsWorkspace({ farm, fields, farmHealth }) {
  const farmId = farm?.id || null;
  const [records, setRecords] = useState(() => tilthStore.loadRecords(farmId));
  const [yieldStore, setYieldStore] = useState(() => tilthStore.loadYield(farmId));
  const [attrs, setAttrs] = useState(() => tilthStore.loadFieldAttrs(farmId));
  const [assignments, setAssignments] = useState(() => tilthStore.loadAssignments(farmId));

  useEffect(() => {
    setRecords(tilthStore.loadRecords(farmId));
    setYieldStore(tilthStore.loadYield(farmId));
    setAttrs(tilthStore.loadFieldAttrs(farmId));
    setAssignments(tilthStore.loadAssignments(farmId));
  }, [farmId]);

  const mappedFields = useMemo(
    () => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3),
    [fields],
  );

  const { health, ndvi } = farmHealth;

  const years = useMemo(
    () => Object.keys(yieldStore).map(Number).filter(Number.isFinite).sort((a, b) => b - a),
    [yieldStore],
  );
  const [year, setYear] = useState(() => years[0] || new Date().getFullYear());
  useEffect(() => {
    if (years.length && !years.includes(year)) setYear(years[0]);
  }, [years.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const yieldMap = yieldStore[String(year)] || {};
    return mappedFields.map((f) => {
      const area = approxHectares(f.boundary);
      const fieldRecords = records.filter((r) => r.fieldId === f.id);
      const yearRecords = fieldRecords.filter((r) => r.date && new Date(r.date).getFullYear() === year);
      const sourceRecs = yearRecords.length ? yearRecords : fieldRecords;
      const nPerHa = sourceRecs.reduce((a, r) => a + (Number(r.rate) || 0) * (N_FRACTIONS[r.productId] || 0), 0);
      const sprays = sourceRecs.filter((r) => (N_FRACTIONS[r.productId] || 0) === 0).length;
      const yieldT = Number.isFinite(yieldMap[f.id]) ? yieldMap[f.id] : null;
      const attr = attrs[f.id] || {};
      const h = health.get(f.id) || null;
      const assign = assignments[f.id];
      const schemeCode = assign?.code && assign.code !== "—" ? assign.code : null;
      return {
        id: f.id,
        name: f.name || "Unnamed",
        soil: attr.soil || null,
        crop: attr.crop || null,
        area,
        nPerHa,
        sprays,
        yieldT,
        score: h?.score ?? null,
        stage: h?.stage || null,
        trend: h?.trend || null,
        ndviMean: h?.metrics?.ndviMean ?? null,
        spectral: h?.metrics?.spectral || {},
        ndviSlope: h?.metrics?.ndviSlope14d ?? null,
        vhDb: h?.metrics?.vhMeanDb ?? null,
        flags: h?.flags || [],
        confidence: h?.confidence || "low",
        summary: h?.summary || null,
        lastScene: h?.latest?.scene_datetime || null,
        schemeCode,
      };
    });
  }, [mappedFields, records, yieldStore, year, attrs, health, assignments]);

  /* ---------- derived aggregates ---------- */
  const agg = useMemo(() => {
    if (!rows.length) return null;
    const yields = rows.map((r) => r.yieldT).filter(Number.isFinite);
    const nvals = rows.map((r) => r.nPerHa).filter((v) => v > 0);
    const scores = rows.map((r) => r.score).filter(Number.isFinite);
    const ndvis = rows.map((r) => r.ndviMean).filter(Number.isFinite);
    const areas = rows.map((r) => r.area);
    const totalArea = areas.reduce((a, b) => a + b, 0);
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const avgNdvi = ndvis.length ? ndvis.reduce((a, b) => a + b, 0) / ndvis.length : null;
    const avgYield = yields.length ? yields.reduce((a, b) => a + b, 0) / yields.length : null;
    const avgN = nvals.length ? nvals.reduce((a, b) => a + b, 0) / nvals.length : null;
    const healthy = scores.filter((s) => s >= 70).length;
    const attention = scores.filter((s) => s >= 45 && s < 70).length;
    const critical = scores.filter((s) => s < 45).length;
    const lastScene = rows.reduce((latest, r) => {
      if (!r.lastScene) return latest;
      const t = new Date(r.lastScene).getTime();
      return Number.isFinite(t) && t > latest ? t : latest;
    }, 0);
    return {
      totalArea, avgScore, avgNdvi, avgYield, avgN,
      healthy, attention, critical,
      fieldsWithYield: yields.length,
      fieldsWithScore: scores.length,
      fieldsWithN: nvals.length,
      lastScene: lastScene ? new Date(lastScene).toISOString() : null,
    };
  }, [rows]);

  const corrNY = useMemo(() => pearson(rows.filter((r) => r.nPerHa > 0 && Number.isFinite(r.yieldT)).map((r) => [r.nPerHa, r.yieldT])), [rows]);
  const corrNdviY = useMemo(() => pearson(rows.filter((r) => Number.isFinite(r.ndviMean) && Number.isFinite(r.yieldT)).map((r) => [r.ndviMean, r.yieldT])), [rows]);
  const corrScoreY = useMemo(() => pearson(rows.filter((r) => Number.isFinite(r.score) && Number.isFinite(r.yieldT)).map((r) => [r.score, r.yieldT])), [rows]);

  /* ---------- group-by breakdowns ---------- */
  const yieldBySoil = useMemo(() => groupedAverage(rows, "soil", "yieldT"), [rows]);
  const yieldByCrop = useMemo(() => groupedAverage(rows, "crop", "yieldT"), [rows]);

  /* ---------- farm-wide NDVI time series ---------- */
  const farmNdviSeries = useMemo(() => {
    if (!ndvi?.scenes) return [];
    const allPts = [];
    for (const [fid, scenes] of ndvi.scenes.entries()) {
      for (const s of scenes) {
        if (s.status !== "ok" || !Number.isFinite(s.ndvi_mean)) continue;
        const t = new Date(s.scene_datetime).getTime();
        if (!Number.isFinite(t)) continue;
        allPts.push({ t, ndvi: s.ndvi_mean, fid });
      }
    }
    allPts.sort((a, b) => a.t - b.t);
    return allPts;
  }, [ndvi?.scenes]);

  /* ---------- auto-generated insights ---------- */
  const insights = useMemo(() => buildInsights(rows, agg, corrNY, corrNdviY, corrScoreY, yieldBySoil, yieldByCrop), [rows, agg, corrNY, corrNdviY, corrScoreY, yieldBySoil, yieldByCrop]);

  const exportCsv = () => {
    if (!rows.length) return;
    const header = ["field", "crop", "soil", "area_ha", "health_score", ...SPECTRAL_INDEX_LIST.map((idx) => `${idx.id}_latest`), "trend", "n_kg_ha", "sprays", `yield_t_ha_${year}`, "scheme", "stage", "flags"];
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
    const lines = [header.join(",")];
    for (const r of rows) {
      const spectralCells = SPECTRAL_INDEX_LIST.map((idx) => Number.isFinite(r.spectral?.[idx.id]) ? r.spectral[idx.id].toFixed(3) : "");
      lines.push([r.name, r.crop || "", r.soil || "", r.area.toFixed(2), Number.isFinite(r.score) ? r.score : "", ...spectralCells, r.trend || "", r.nPerHa.toFixed(1), r.sprays, Number.isFinite(r.yieldT) ? r.yieldT.toFixed(2) : "", r.schemeCode || "", r.stage || "", r.flags.join("; ")].map(esc).join(","));
    }
    triggerDownload(`tilth-analytics-${farmId || "farm"}-${year}.csv`, "text/csv", lines.join("\n"));
  };

  const hasAny = rows.length > 0;

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Insights"
          title="Farm analytics"
          description="Cross-field performance view — satellite health, inputs, yield, soil and scheme data joined per field."
          actions={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {years.length > 0 && (
                <select
                  value={year}
                  onChange={(e) => setYear(parseInt(e.target.value, 10))}
                  style={{ fontFamily: fonts.sans, fontSize: 12.5, padding: "6px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, color: brand.forest }}
                >
                  {years.map((y) => <option key={y} value={y}>Year {y}</option>)}
                </select>
              )}
              <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!hasAny}>Export CSV</Button>
            </div>
          }
        />
      }
    >
      {!hasAny ? (
        <Card padding={24}>
          <EmptyState kicker="Nothing to join" title="Need mapped fields" description="Cross-field analytics build on the field registry. Map a few boundaries first." />
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: "1 1 auto", minHeight: 0, overflow: "auto" }} className="tilth-scroll">

          {/* ── Summary stats ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, flex: "0 0 auto" }} className="tilth-ana-stats">
            <Stat kicker="Fields" value={`${rows.length}`} sub={`${agg?.totalArea?.toFixed(0) || "—"} ha total`} tone="forest" />
            <Stat kicker="Farm health" value={agg?.avgScore != null ? Math.round(agg.avgScore) : "—"} sub={agg?.fieldsWithScore ? `${agg.healthy} ok · ${agg.attention} attn · ${agg.critical} crit` : "No data"} tone={agg?.avgScore >= 70 ? "ok" : agg?.avgScore >= 45 ? "warn" : "danger"} />
            <Stat kicker="Avg NDVI" value={agg?.avgNdvi != null ? agg.avgNdvi.toFixed(2) : "—"} sub={agg?.lastScene ? `Scene ${fmtRelative(agg.lastScene)}` : "Awaiting data"} />
            <Stat kicker="Avg yield" value={agg?.avgYield != null ? `${agg.avgYield.toFixed(1)} t` : "—"} sub={agg?.fieldsWithYield ? `${agg.fieldsWithYield} of ${rows.length} fields` : "No yield uploaded"} />
            <Stat kicker="Avg N" value={agg?.avgN ? `${agg.avgN.toFixed(0)} kg` : "—"} sub={agg?.fieldsWithN ? `${agg.fieldsWithN} fields recorded` : "No records"} />
            <Stat kicker="NDVI→Yield" value={corrNdviY != null ? corrNdviY.toFixed(2) : "—"} sub={corrNdviY != null ? pearsonLabel(corrNdviY) : "Need both"} />
          </div>

          {/* ── Insights strip ── */}
          {insights.length > 0 && (
            <Card padding={12} style={{ flex: "0 0 auto" }}>
              <Kicker style={{ marginBottom: 6 }}>Key insights</Kicker>
              <div style={{ display: "grid", gap: 4 }}>
                {insights.map((ins, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                    <Pill tone={ins.tone} style={{ flex: "0 0 auto", textTransform: "none", letterSpacing: "0.06em", fontSize: 10 }}>{ins.tag}</Pill>
                    <Body size="sm" style={{ lineHeight: 1.45, color: brand.bodySoft }}>{ins.text}</Body>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ── Enriched field table ── */}
          <Card padding={0} style={{ flex: "0 0 auto", overflow: "hidden" }}>
            <div style={{ padding: "10px 12px 6px", borderBottom: `1px solid ${brand.border}` }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <Kicker>Field comparison · {rows.length} fields</Kicker>
                <Pill tone="neutral">year {year}</Pill>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.sans, fontSize: 12, minWidth: 860 }}>
                <thead>
                  <tr style={{ background: brand.bgSection }}>
                    {["Field", "Crop", "Soil", "ha", "Score", "Indices", "Trend", "Stage", "N kg/ha", "Sprays", "Yield", "Scheme"].map((h) => (
                      <th key={h} style={{ ...thStyle, textAlign: h === "Field" ? "left" : "center" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    return (
                      <tr key={r.id} style={{ borderTop: `1px solid ${brand.border}` }}>
                        <td style={{ ...tdStyle, fontWeight: 600, textAlign: "left", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                        <td style={tdMono}>{r.crop || "—"}</td>
                        <td style={tdMono}>{r.soil || "—"}</td>
                        <td style={tdMono}>{r.area.toFixed(1)}</td>
                        <td style={tdStyle}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                            <span style={{ width: 8, height: 8, borderRadius: 99, background: scoreColor(r.score), flex: "0 0 auto" }} />
                            <span style={{ fontFamily: fonts.mono, fontSize: 11, fontWeight: 600 }}>{Number.isFinite(r.score) ? r.score : "—"}</span>
                          </span>
                        </td>
                        <td style={{ ...tdMono, minWidth: 190 }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, justifyContent: "center" }}>
                            {SPECTRAL_INDEX_LIST.map((idx) => Number.isFinite(r.spectral?.[idx.id]) ? (
                              <span key={idx.id} title={idx.interpretation} style={{ color: idx.id === "ndvi" ? ndviColor(r.spectral[idx.id]) : brand.bodySoft }}>
                                {idx.label} {formatSpectralValue(r.spectral[idx.id])}
                              </span>
                            ) : null)}
                          </div>
                        </td>
                        <td style={{ ...tdStyle, fontSize: 14, color: trendColor(r.trend) }}>{trendGlyph(r.trend)}</td>
                        <td style={tdMono}>{r.stage ? (STAGE_LABELS[r.stage] || r.stage) : "—"}</td>
                        <td style={{ ...tdMono, color: r.nPerHa > 0 ? brand.forest : brand.muted }}>{r.nPerHa > 0 ? r.nPerHa.toFixed(0) : "—"}</td>
                        <td style={{ ...tdMono, color: r.sprays > 0 ? brand.forest : brand.muted }}>{r.sprays || "—"}</td>
                        <td style={{ ...tdMono, fontWeight: 600, color: Number.isFinite(r.yieldT) ? brand.forest : brand.muted }}>{Number.isFinite(r.yieldT) ? r.yieldT.toFixed(1) : "—"}</td>
                        <td style={{ ...tdMono, fontSize: 9.5 }}>{r.schemeCode || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── Charts row ── */}
          <div className="tilth-ana-charts" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, flex: "0 0 auto" }}>
            {/* Farm NDVI timeline */}
            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>Farm NDVI timeline</Kicker>
              <FarmNdviChart series={farmNdviSeries} fieldNames={Object.fromEntries(rows.map((r) => [r.id, r.name]))} />
            </Card>

            {/* NDVI vs yield scatter */}
            <Card padding={12}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                <Kicker>NDVI vs yield</Kicker>
                {corrNdviY != null && <Pill tone="neutral">r = {corrNdviY.toFixed(2)}</Pill>}
              </div>
              <BiScatter pairs={rows.filter((r) => Number.isFinite(r.ndviMean) && Number.isFinite(r.yieldT)).map((r) => [r.ndviMean, r.yieldT, r.name])} xLabel="Latest NDVI" yLabel="Yield (t/ha)" />
            </Card>

            {/* Yield by soil type */}
            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>Yield by soil type</Kicker>
              <GroupBar data={yieldBySoil} unit="t/ha" color={brand.forest} />
            </Card>

            {/* Yield by crop */}
            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>Yield by crop</Kicker>
              <GroupBar data={yieldByCrop} unit="t/ha" color="#3F7A4A" />
            </Card>

            {/* Health distribution */}
            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>Health distribution</Kicker>
              <HealthDistribution rows={rows} />
            </Card>

            {/* N vs yield scatter */}
            <Card padding={12}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                <Kicker>N applied vs yield</Kicker>
                {corrNY != null && <Pill tone="neutral">r = {corrNY.toFixed(2)}</Pill>}
              </div>
              <BiScatter pairs={rows.filter((r) => r.nPerHa > 0 && Number.isFinite(r.yieldT)).map((r) => [r.nPerHa, r.yieldT, r.name])} xLabel="N applied (kg/ha)" yLabel="Yield (t/ha)" />
            </Card>
          </div>

          {/* ── Data coverage ── */}
          <Card padding={12} style={{ flex: "0 0 auto" }}>
            <Kicker style={{ marginBottom: 8 }}>Data completeness</Kicker>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
              <CoverageRow label="Fields mapped" value={mappedFields.length} total={mappedFields.length} />
              <CoverageRow label="Satellite data" value={rows.filter((r) => Number.isFinite(r.ndviMean)).length} total={rows.length} />
              <CoverageRow label="Health scored" value={rows.filter((r) => Number.isFinite(r.score)).length} total={rows.length} />
              <CoverageRow label="With records" value={new Set(records.map((r) => r.fieldId)).size} total={rows.length} />
              <CoverageRow label={`Yield (${year})`} value={rows.filter((r) => Number.isFinite(r.yieldT)).length} total={rows.length} />
              <CoverageRow label="Crop + soil set" value={rows.filter((r) => r.crop && r.soil).length} total={rows.length} />
              <CoverageRow label="Scheme assigned" value={rows.filter((r) => r.schemeCode).length} total={rows.length} />
            </div>
          </Card>
        </div>
      )}

      <style>{`
        @media (max-width: 1100px) {
          .tilth-ana-stats { grid-template-columns: repeat(3, 1fr) !important; }
          .tilth-ana-charts { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 700px) {
          .tilth-ana-stats { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Helper styles
 * ═══════════════════════════════════════════════════════════════════ */

const thStyle = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: brand.muted,
  padding: "8px 8px",
  textAlign: "center",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "7px 8px",
  textAlign: "center",
  color: brand.forest,
  verticalAlign: "middle",
};

const tdMono = {
  ...tdStyle,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10.5,
  color: brand.bodySoft,
};

/* ═══════════════════════════════════════════════════════════════════════
 * Pure helpers
 * ═══════════════════════════════════════════════════════════════════ */

function trendGlyph(t) {
  if (t === "improving") return "↗";
  if (t === "declining") return "↘";
  if (t === "stable") return "→";
  return "·";
}

function trendColor(t) {
  if (t === "improving") return brand.ok || "#3F7A4A";
  if (t === "declining") return brand.danger || "#B4412E";
  return brand.muted;
}

function ndviColor(v) {
  if (!Number.isFinite(v)) return brand.muted;
  if (v >= 0.6) return "#3F7A4A";
  if (v >= 0.35) return "#C07C12";
  return "#B4412E";
}

function pearsonLabel(r) {
  const a = Math.abs(r);
  if (a > 0.7) return "Strong";
  if (a > 0.3) return "Moderate";
  return "Weak / none";
}

function groupedAverage(rows, groupKey, valueKey) {
  const map = {};
  for (const r of rows) {
    const key = r[groupKey];
    if (!key || !Number.isFinite(r[valueKey])) continue;
    if (!map[key]) map[key] = { sum: 0, n: 0 };
    map[key].sum += r[valueKey];
    map[key].n += 1;
  }
  return Object.entries(map)
    .map(([label, { sum, n }]) => ({ label, avg: sum / n, n }))
    .sort((a, b) => b.avg - a.avg);
}

/* ═══════════════════════════════════════════════════════════════════════
 * Insight builder — deterministic, no LLM — just pattern matching
 * ═══════════════════════════════════════════════════════════════════ */

function buildInsights(rows, agg, corrNY, corrNdviY, corrScoreY, yieldBySoil, yieldByCrop) {
  const out = [];
  if (!agg || !rows.length) return out;

  if (agg.critical > 0) {
    out.push({ tone: "danger", tag: "Attention", text: `${agg.critical} field${agg.critical > 1 ? "s" : ""} scored critical — consider a field walk or drone flight to investigate.` });
  }
  if (corrNdviY != null && corrNdviY > 0.5) {
    out.push({ tone: "ok", tag: "Correlation", text: `Strong positive relationship between NDVI and yield (r = ${corrNdviY.toFixed(2)}) — satellite data is a reliable proxy for performance on this farm.` });
  } else if (corrNdviY != null && corrNdviY < -0.2) {
    out.push({ tone: "warn", tag: "Anomaly", text: `NDVI and yield are negatively correlated (r = ${corrNdviY.toFixed(2)}) — this can indicate lodging in high-biomass fields or a timing mismatch between peak canopy and yield sampling.` });
  }
  if (corrNY != null && corrNY < -0.3) {
    out.push({ tone: "warn", tag: "Efficiency", text: `Higher N application is associated with lower yield (r = ${corrNY.toFixed(2)}) — review whether inputs are reaching responsive fields or if soil/drainage is the limiting factor.` });
  } else if (corrNY != null && corrNY > 0.5) {
    out.push({ tone: "ok", tag: "Responsive", text: `Nitrogen input tracks yield well (r = ${corrNY.toFixed(2)}) — push responsive fields harder and consider reducing N on non-responsive ones.` });
  }

  const declining = rows.filter((r) => r.trend === "declining" && Number.isFinite(r.score) && r.score < 60);
  if (declining.length > 0) {
    const names = declining.slice(0, 3).map((r) => r.name).join(", ");
    out.push({ tone: "warn", tag: "Declining", text: `${declining.length} field${declining.length > 1 ? "s" : ""} with declining trend and below-average health: ${names}${declining.length > 3 ? " + more" : ""}.` });
  }

  if (yieldBySoil.length >= 2) {
    const best = yieldBySoil[0];
    const worst = yieldBySoil[yieldBySoil.length - 1];
    if (best.avg - worst.avg > 0.5) {
      out.push({ tone: "info", tag: "Soil", text: `${best.label} soils yield ${best.avg.toFixed(1)} t/ha on average vs ${worst.avg.toFixed(1)} on ${worst.label} — consider soil-specific variety selection.` });
    }
  }

  if (yieldByCrop.length >= 2) {
    const best = yieldByCrop[0];
    out.push({ tone: "info", tag: "Crop", text: `Top-yielding crop: ${best.label} at ${best.avg.toFixed(1)} t/ha across ${best.n} field${best.n > 1 ? "s" : ""}.` });
  }

  const stale = rows.filter((r) => {
    if (!r.lastScene) return true;
    return Date.now() - new Date(r.lastScene).getTime() > 14 * 86_400_000;
  });
  if (stale.length > rows.length * 0.5) {
    out.push({ tone: "warn", tag: "Data gap", text: `${stale.length} of ${rows.length} fields have stale or missing satellite data (> 14 days). Cloud cover may be limiting scene availability.` });
  }

  const withScheme = rows.filter((r) => r.schemeCode);
  if (withScheme.length > 0) {
    const lowHealth = withScheme.filter((r) => Number.isFinite(r.score) && r.score < 50);
    if (lowHealth.length > 0) {
      out.push({ tone: "warn", tag: "Schemes", text: `${lowHealth.length} scheme-enrolled field${lowHealth.length > 1 ? "s" : ""} have low health scores — check compliance obligations.` });
    }
  }

  return out.slice(0, 8);
}

/* ═══════════════════════════════════════════════════════════════════════
 * Chart components (pure SVG, no deps)
 * ═══════════════════════════════════════════════════════════════════ */

function FarmNdviChart({ series }) {
  const W = 600, H = 160, PL = 38, PR = 14, PT = 8, PB = 24;
  if (!series.length) return <ChartEmpty text="No satellite data yet" />;

  const tMin = series[0].t;
  const tMax = series[series.length - 1].t;
  const yMin = 0, yMax = 1;
  const sx = (t) => PL + ((t - tMin) / (tMax - tMin || 1)) * (W - PL - PR);
  const sy = (v) => H - PB - ((v - yMin) / (yMax - yMin)) * (H - PT - PB);

  const byField = {};
  for (const p of series) {
    (byField[p.fid] ||= []).push(p);
  }

  const monthTicks = [];
  const d = new Date(tMin);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= tMax) {
    if (d.getTime() >= tMin) monthTicks.push(d.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxHeight: 180 }} aria-hidden>
      {[0.2, 0.4, 0.6, 0.8].map((v) => (
        <line key={v} x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke="#D5E5D7" strokeDasharray="2,3" />
      ))}
      {monthTicks.map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={PT} y2={H - PB} stroke="#D5E5D7" strokeDasharray="2,3" />
          <text x={sx(t)} y={H - 6} textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="#54695F">
            {new Date(t).toLocaleString("en-GB", { month: "short" })}
          </text>
        </g>
      ))}
      <line x1={PL} x2={PL} y1={PT} y2={H - PB} stroke="#104E3F" />
      <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="#104E3F" />
      {Object.entries(byField).map(([fid, pts]) => {
        if (pts.length < 2) return null;
        const d = pts.map((p) => `${sx(p.t)},${sy(p.ndvi)}`).join(" L");
        return <path key={fid} d={`M${d}`} fill="none" stroke="#104E3F" strokeWidth="1" opacity="0.3" />;
      })}
      {[0.2, 0.4, 0.6, 0.8].map((v) => (
        <text key={v} x={PL - 4} y={sy(v) + 3} textAnchor="end" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="#54695F">{v.toFixed(1)}</text>
      ))}
      <text x={W / 2} y={H - 2} textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="#54695F">Time</text>
      <text x={14} y={H / 2} textAnchor="middle" transform={`rotate(-90 14 ${H / 2})`} fontFamily="'JetBrains Mono', monospace" fontSize="8" fill="#54695F">NDVI</text>
    </svg>
  );
}

function BiScatter({ pairs, xLabel, yLabel }) {
  const W = 600, H = 160, PL = 38, PR = 14, PT = 8, PB = 24;
  if (!pairs.length) return <ChartEmpty text={`Need fields with both ${xLabel.toLowerCase()} and ${yLabel.toLowerCase()}`} />;

  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const xMin = Math.min(...xs, 0), xMax = Math.max(...xs);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys);
  const sx = (x) => PL + ((x - xMin) / (xMax - xMin || 1)) * (W - PL - PR);
  const sy = (y) => H - PB - ((y - yMin) / (yMax - yMin || 1)) * (H - PT - PB);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxHeight: 180 }} aria-hidden>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = PT + t * (H - PT - PB);
        return <line key={t} x1={PL} x2={W - PR} y1={y} y2={y} stroke="#D5E5D7" strokeDasharray="2,3" />;
      })}
      <line x1={PL} x2={PL} y1={PT} y2={H - PB} stroke="#104E3F" />
      <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="#104E3F" />
      {pairs.map((p, i) => (
        <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={5} fill="#104E3F" opacity="0.85">
          <title>{p[2] || ""}: x={typeof p[0] === "number" ? p[0].toFixed(2) : p[0]}, y={typeof p[1] === "number" ? p[1].toFixed(2) : p[1]}</title>
        </circle>
      ))}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#54695F">{xLabel}</text>
      <text x={12} y={H / 2} textAnchor="middle" transform={`rotate(-90 12 ${H / 2})`} fontFamily="'JetBrains Mono', monospace" fontSize="9" fill="#54695F">{yLabel}</text>
    </svg>
  );
}

function GroupBar({ data, unit, color }) {
  if (!data.length) return <ChartEmpty text="No data to compare" />;
  const maxVal = Math.max(...data.map((d) => d.avg), 0.1);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {data.slice(0, 8).map((d) => (
        <div key={d.label}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: fonts.mono, fontSize: 10, color: brand.bodySoft, marginBottom: 2 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
            <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{d.avg.toFixed(1)} {unit} <span style={{ fontWeight: 400 }}>(n={d.n})</span></span>
          </div>
          <div style={{ height: 6, background: brand.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(2, (d.avg / maxVal) * 100)}%`, height: "100%", background: color, borderRadius: 3, transition: "width 200ms ease" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function HealthDistribution({ rows }) {
  const scored = rows.filter((r) => Number.isFinite(r.score));
  if (!scored.length) return <ChartEmpty text="No health scores yet" />;
  const buckets = [
    { label: "Critical (< 45)", color: "#B4412E", count: scored.filter((r) => r.score < 45).length },
    { label: "Attention (45–69)", color: "#C07C12", count: scored.filter((r) => r.score >= 45 && r.score < 70).length },
    { label: "Healthy (≥ 70)", color: "#3F7A4A", count: scored.filter((r) => r.score >= 70).length },
  ];
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {buckets.map((b) => (
        <div key={b.label}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: fonts.mono, fontSize: 10, color: brand.bodySoft, marginBottom: 2 }}>
            <span>{b.label}</span>
            <span style={{ fontWeight: 600 }}>{b.count}</span>
          </div>
          <div style={{ height: 6, background: brand.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(2, (b.count / max) * 100)}%`, height: "100%", background: b.color, borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CoverageRow({ label, value, total }) {
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: brand.muted, marginBottom: 4 }}>
        <span>{label}</span>
        <span>{value}/{total || 0}</span>
      </div>
      <div style={{ height: 4, background: brand.border, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: brand.forest, transition: "width 200ms ease" }} />
      </div>
    </div>
  );
}

function ChartEmpty({ text }) {
  return (
    <div style={{ padding: 16, textAlign: "center", fontFamily: fonts.mono, fontSize: 10, color: brand.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
      {text}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  Divider,
  Headline,
  Kicker,
  Pill,
  SectionHeader,
  Subpanel,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { tilthStore } from "../state/localStore.js";
import { ringAreaSqDeg } from "../geoPointInPolygon.js";
import { useFarmHealth } from "../../lib/cropHealth.js";
import { useFieldElevation } from "../../lib/tilthElevation.js";
import { evaluateField, eligibleCount } from "../../lib/schemeEligibility.js";
import {
  analyseFieldPeriod,
  periodComparison,
  farmRankings,
  generateRecommendations,
  sparklineSvg,
  operationsCorrelation,
} from "../../lib/reportAnalytics.js";

// ─── Helpers ─────────────────────────────────────────────────────────

const N_FRACTIONS = { nitram: 0.345, "yara-yaramila": 0.18, "roundup-flex": 0, "atlantis-od": 0, "decis-forte": 0 };

function approxHectares(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(boundary));
  const midLat = boundary.reduce((a, p) => a + p.lat, 0) / boundary.length;
  return Math.max(0, (sqDeg * 111_132 * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 10_000);
}

function esc(s) { return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function fmtDate(iso) { if (!iso) return "—"; try { return new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }); } catch { return iso; } }

// ─── Cadences ────────────────────────────────────────────────────────

const CADENCE = {
  weekly:    { label: "Weekly",    days: 7,  defaults: { overview: true, timeSeries: true, recommendations: true, operations: true, rankings: true, popComparison: true, fields: false, schemes: false, elevation: false } },
  monthly:   { label: "Monthly",   days: 30, defaults: { overview: true, timeSeries: true, recommendations: true, operations: true, rankings: true, popComparison: true, fields: true, schemes: true, elevation: false } },
  quarterly: { label: "Quarterly", days: 91, defaults: { overview: true, timeSeries: true, recommendations: true, operations: true, rankings: true, popComparison: true, fields: true, schemes: true, elevation: true } },
};

function dateRange(cadence) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (CADENCE[cadence]?.days || 30));
  return { start, end };
}

function prettyRange(s, e) { const o = { day: "numeric", month: "short", year: "numeric" }; return `${s.toLocaleDateString(undefined, o)} – ${e.toLocaleDateString(undefined, o)}`; }
function isoDay(d) { return d.toISOString().slice(0, 10); }

const ALL_SECTIONS = [
  { key: "overview",        label: "Farm overview" },
  { key: "timeSeries",      label: "NDVI time-series analysis" },
  { key: "recommendations", label: "Recommendations & alerts" },
  { key: "popComparison",   label: "Period-over-period comparison" },
  { key: "rankings",        label: "Field performance rankings" },
  { key: "operations",      label: "Operations & input impact" },
  { key: "fields",          label: "Field registry" },
  { key: "schemes",         label: "Scheme eligibility" },
  { key: "elevation",       label: "Topography" },
];

// ─── UI pieces ───────────────────────────────────────────────────────

function SectionToggle({ label, on, onToggle }) {
  return (
    <button type="button" onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: `1px solid ${on ? brand.forest : brand.border}`, background: on ? brand.bgSection : brand.white, borderRadius: radius.base, cursor: "pointer", fontFamily: fonts.sans, fontSize: 11.5, color: brand.forest, textAlign: "left" }}>
      <span aria-hidden style={{ width: 12, height: 12, borderRadius: 2, border: `1px solid ${on ? brand.forest : brand.border}`, background: on ? brand.forest : brand.white, display: "inline-flex", alignItems: "center", justifyContent: "center", color: brand.white, fontSize: 8 }}>{on ? "✓" : ""}</span>
      {label}
    </button>
  );
}

function MiniKv({ label, value }) {
  return (
    <div style={{ padding: "8px 10px", border: `1px solid ${brand.border}`, background: brand.white, borderRadius: radius.base }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.muted }}>{label}</div>
      <div style={{ marginTop: 2, fontFamily: fonts.serif, fontSize: 20, color: brand.forest, letterSpacing: "-0.01em" }}>{value}</div>
    </div>
  );
}

function CadenceTab({ label, active, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: active ? 700 : 400, padding: "8px 14px", border: `1px solid ${active ? brand.forest : brand.border}`, background: active ? brand.forest : brand.white, color: active ? brand.white : brand.forest, borderRadius: radius.base, cursor: "pointer", letterSpacing: "0.08em", textTransform: "uppercase" }}>
      {label}
    </button>
  );
}

// ─── Main ────────────────────────────────────────────────────────────

export function ReportsWorkspace({ farm, fields }) {
  const farmId = farm?.id || null;
  const [cadence, setCadence] = useState("monthly");
  const range = useMemo(() => dateRange(cadence), [cadence]);
  const [sections, setSections] = useState(() => ({ ...CADENCE.monthly.defaults }));
  useEffect(() => { setSections({ ...CADENCE[cadence].defaults }); }, [cadence]);

  // Data sources
  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const yieldStore = useMemo(() => tilthStore.loadYield(farmId), [farmId]);
  const assignments = useMemo(() => tilthStore.loadAssignments(farmId), [farmId]);
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);
  const plantingsMap = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);

  const mappedFields = useMemo(() => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3), [fields]);
  const fieldIds = useMemo(() => mappedFields.map((f) => f.id), [mappedFields]);
  const areas = useMemo(() => { const m = {}; for (const f of mappedFields) m[f.id] = approxHectares(f.boundary); return m; }, [mappedFields]);
  const totalHa = useMemo(() => Object.values(areas).reduce((a, v) => a + v, 0), [areas]);

  const farmHealth = useFarmHealth(mappedFields, plantingsMap);
  const { data: elevData } = useFieldElevation(fieldIds);

  // Scheme results
  const schemeResults = useMemo(() => {
    try {
      const farmData = { totalHa, fieldCount: mappedFields.length };
      return mappedFields.map((f) => {
        const fa = attrs[f.id] || {};
        const elev = elevData.get(f.id);
        const planting = plantingsMap[f.id]?.[0] || null;
        const fd = { landUse: fa.landUse || "arable", soil: fa.soil || null, crop: fa.crop || null, areaHa: areas[f.id] || null, elevation: elev?.status === "ok" ? { mean: elev.elevation_mean, slope_mean_deg: elev.slope_mean_deg } : null, ndviMean: null, isOrganic: fa.organic === true, currentPlanting: planting };
        return { fieldId: f.id, fieldName: f.name, areaHa: areas[f.id], results: evaluateField(fd, farmData) };
      });
    } catch { return []; }
  }, [mappedFields, attrs, elevData, areas, totalHa, plantingsMap]);

  const year = new Date().getFullYear();

  // Records in range
  const rangeRecords = useMemo(() => {
    const s = range.start.getTime(), e = range.end.getTime();
    return records.filter((r) => { if (!r.date) return false; const t = new Date(r.date).getTime(); return t >= s && t <= e; });
  }, [records, range]);

  // ── Time-series analytics ──────────────────────────────────────────

  const ndviScenes = farmHealth.ndvi?.scenes;
  const fieldAnalyses = useMemo(() => {
    const scenesMap = ndviScenes || new Map();
    return mappedFields.map((f) => {
      const scenes = scenesMap.get(f.id) || [];
      try {
        const analysis = analyseFieldPeriod(scenes, range.start, range.end);
        const comparison = periodComparison(scenes, range.start, range.end);
        const inputCorrelation = operationsCorrelation(records, scenes, f.id, range.start, range.end);
        return { fieldId: f.id, name: f.name || "Unnamed", areaHa: areas[f.id] || 0, analysis, comparison, inputCorrelation };
      } catch {
        return { fieldId: f.id, name: f.name || "Unnamed", areaHa: areas[f.id] || 0, analysis: null, comparison: null, inputCorrelation: null };
      }
    });
  }, [mappedFields, ndviScenes, range, records, areas]);

  const rankings = useMemo(() => { try { return farmRankings(fieldAnalyses); } catch { return { top: [], bottom: [], mostImproved: [], mostDeclined: [] }; } }, [fieldAnalyses]);
  const recommendations = useMemo(() => { try { return generateRecommendations(fieldAnalyses, farmHealth.health, cadence, plantingsMap); } catch { return []; } }, [fieldAnalyses, farmHealth.health, cadence, plantingsMap]);

  // Farm-level aggregates
  const farmNdviSummary = useMemo(() => {
    try {
      const withData = fieldAnalyses.filter((f) => f.analysis);
      if (!withData.length) return null;
      const farmMean = withData.reduce((a, f) => a + (f.analysis.mean || 0), 0) / withData.length;
      const improving = withData.filter((f) => (f.analysis.slopePerDay || 0) > 0.003).length;
      const declining = withData.filter((f) => (f.analysis.slopePerDay || 0) < -0.003).length;
      const stable = withData.length - improving - declining;
      const totalScenes = withData.reduce((a, f) => a + (f.analysis.sceneCount || 0), 0);
      return { farmMean: farmMean.toFixed(3), improving, declining, stable, totalScenes, fieldsWithData: withData.length };
    } catch { return null; }
  }, [fieldAnalyses]);

  const totals = useMemo(() => {
    try {
      const withYield = Object.keys(yieldStore[String(year)] || {}).length;
      const assignedCount = Object.keys(assignments).filter((k) => { const v = assignments[k]; return v && (Array.isArray(v.codes) ? v.codes.length > 0 : v.code && v.code !== "—"); }).length;
      const totalN = rangeRecords.reduce((a, r) => a + (Number(r.rate) || 0) * (N_FRACTIONS[r.productId] || 0) * (r.area || 0), 0);
      const totalEligible = schemeResults.reduce((a, sr) => a + eligibleCount(sr.results || []), 0);
      return { fields: mappedFields.length, totalHa, records: rangeRecords.length, withYield, assignedCount, totalN, totalEligible };
    } catch { return { fields: 0, totalHa: 0, records: 0, withYield: 0, assignedCount: 0, totalN: 0, totalEligible: 0 }; }
  }, [mappedFields, rangeRecords, yieldStore, assignments, year, totalHa, schemeResults]);

  // Health summary
  const healthSummary = useMemo(() => {
    if (farmHealth.status !== "ready" || !farmHealth.health) return null;
    let healthy = 0, watch = 0, poor = 0;
    for (const f of mappedFields) { const h = farmHealth.health.get?.(f.id); if (!h?.score) continue; if (h.score >= 65) healthy++; else if (h.score >= 40) watch++; else poor++; }
    return { healthy, watch, poor };
  }, [farmHealth, mappedFields]);

  // Library
  const [library, setLibrary] = useState(() => { try { return JSON.parse(window.localStorage.getItem(`tilth:reports:${farmId || "default"}`) || "[]"); } catch { return []; } });
  const persistLibrary = (next) => { setLibrary(next); try { window.localStorage.setItem(`tilth:reports:${farmId || "default"}`, JSON.stringify(next)); } catch { /* */ } };
  const removeReport = (id) => persistLibrary(library.filter((r) => r.id !== id));

  // ── HTML builder ───────────────────────────────────────────────────

  const buildHtml = useCallback(() => {
    const selected = Object.entries(sections).filter(([, v]) => v).map(([k]) => k);
    const farmName = farm?.name || "Unnamed farm";
    const generatedAt = new Date().toLocaleString();
    const cadenceLabel = CADENCE[cadence].label;
    const rangePretty = prettyRange(range.start, range.end);

    const priCol = { high: "#C23B3B", medium: "#C27A1D", low: "#6B8A7A", info: "#3C8D50" };
    const trendArrow = (s) => s > 0.003 ? "↑" : s < -0.003 ? "↓" : "→";
    const trendColor = (s) => s > 0.003 ? "#3C8D50" : s < -0.003 ? "#C23B3B" : "#839788";
    const scoreColor = (s) => s >= 65 ? "#3C8D50" : s >= 40 ? "#C27A1D" : "#C23B3B";
    const deltaLabel = (d) => d > 0 ? `+${d}` : String(d);

    const rows = mappedFields.map((f) => {
      const ha = areas[f.id] || 0;
      const a = attrs[f.id] || {};
      const h = farmHealth.health?.get(f.id);
      const elev = elevData.get(f.id);
      const sr = schemeResults.find((s) => s.fieldId === f.id);
      const fa = fieldAnalyses.find((x) => x.fieldId === f.id);
      const yMap = yieldStore[String(year)] || {};
      return { id: f.id, name: f.name || "Unnamed", ha, crop: a.crop || "—", soil: a.soil || "—", landUse: a.landUse || "—", h, elev, eligible: sr ? eligibleCount(sr.results) : 0, fa, y: Number.isFinite(yMap[f.id]) ? yMap[f.id] : null };
    });

    const sHtml = {};

    // Overview
    sHtml.overview = `
      <section>
        <h2>Farm overview</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Fields</div><div class="val">${totals.fields}</div></div>
          <div class="cell"><div class="lab">Total area</div><div class="val">${totals.totalHa.toFixed(1)} ha</div></div>
          <div class="cell"><div class="lab">Farm NDVI (mean)</div><div class="val">${farmNdviSummary?.farmMean ?? "—"}</div></div>
          <div class="cell"><div class="lab">Clean scenes</div><div class="val">${farmNdviSummary?.totalScenes ?? 0}</div></div>
        </div>
        ${healthSummary ? `<p class="meta" style="margin-top:12px">${healthSummary.healthy} field${healthSummary.healthy !== 1 ? "s" : ""} healthy · ${healthSummary.watch} on watch · ${healthSummary.poor} poor</p>` : ""}
        ${farmNdviSummary ? `<p class="meta">${farmNdviSummary.improving} improving · ${farmNdviSummary.stable} stable · ${farmNdviSummary.declining} declining across the period</p>` : ""}
      </section>`;

    // Time-series analysis
    sHtml.timeSeries = `
      <section>
        <h2>NDVI time-series analysis · ${esc(rangePretty)}</h2>
        <p class="meta">Cloud-masked Sentinel-2 NDVI per field with trend, peak detection, and anomaly flagging. ${farmNdviSummary?.fieldsWithData ?? 0} of ${totals.fields} fields have data for this period.</p>
        <table class="tbl">
          <thead><tr><th>Field</th><th>Sparkline</th><th class="num">Start</th><th class="num">End</th><th class="num">Change</th><th class="num">Slope/day</th><th class="num">Peak</th><th class="num">Max dip</th><th class="num">σ</th></tr></thead>
          <tbody>
            ${fieldAnalyses.map((f) => {
              const a = f.analysis;
              if (!a) return `<tr><td>${esc(f.name)}</td><td colspan="8" class="empty-cell">No clean scenes in period</td></tr>`;
              return `<tr>
                <td><strong>${esc(f.name)}</strong><br><span class="meta">${f.areaHa.toFixed(1)} ha · ${a.sceneCount} scenes</span></td>
                <td>${sparklineSvg(a.sparkData, { width: 140, height: 32, color: trendColor(a.slopePerDay) })}</td>
                <td class="num">${a.startNdvi}</td>
                <td class="num">${a.endNdvi}</td>
                <td class="num" style="color:${trendColor(a.slopePerDay)};font-weight:600">${trendArrow(a.slopePerDay)} ${a.periodChange > 0 ? "+" : ""}${a.periodChange}</td>
                <td class="num" style="color:${trendColor(a.slopePerDay)}">${a.slopePerDay != null ? (a.slopePerDay > 0 ? "+" : "") + a.slopePerDay.toFixed(4) : "—"}</td>
                <td class="num">${a.peakNdvi ?? "—"}<br><span class="meta">${a.peakDate ? fmtDate(a.peakDate) : ""}</span></td>
                <td class="num" style="color:${a.maxDip >= 0.10 ? "#C23B3B" : "inherit"}">${a.maxDip > 0 ? "−" + a.maxDip : "—"}</td>
                <td class="num">${a.stddev}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
        ${fieldAnalyses.some((f) => f.analysis?.eviMean != null) ? `
        <h3>Supplementary indices (period means)</h3>
        <table class="tbl">
          <thead><tr><th>Field</th><th class="num">EVI</th><th class="num">NDWI</th><th class="num">NDMI</th></tr></thead>
          <tbody>
            ${fieldAnalyses.filter((f) => f.analysis).map((f) => `
              <tr>
                <td>${esc(f.name)}</td>
                <td class="num">${f.analysis.eviMean ?? "—"}</td>
                <td class="num">${f.analysis.ndwiMean ?? "—"}</td>
                <td class="num" style="color:${(f.analysis.ndmiMean ?? 0) < -0.1 ? "#C23B3B" : "inherit"}">${f.analysis.ndmiMean ?? "—"}</td>
              </tr>`).join("")}
          </tbody>
        </table>` : ""}
      </section>`;

    // Recommendations
    sHtml.recommendations = `
      <section>
        <h2>Recommendations & alerts</h2>
        ${recommendations.length ? `
        <div class="recs">
          ${recommendations.map((r) => `
            <div class="rec" style="border-left:3px solid ${priCol[r.priority] || priCol.low}">
              <div class="rec-head">
                <span class="pri" style="color:${priCol[r.priority]}">${r.priority.toUpperCase()}</span>
                <span class="rec-cat">${esc(r.category)}</span>
              </div>
              <div class="rec-title">${esc(r.title)}</div>
              <div class="rec-detail">${esc(r.detail)}</div>
            </div>`).join("")}
        </div>` : `<p class="empty">No recommendations — all fields are tracking well.</p>`}
      </section>`;

    // Period comparison
    sHtml.popComparison = `
      <section>
        <h2>Period-over-period comparison</h2>
        <p class="meta">Comparing current ${cadenceLabel.toLowerCase()} NDVI means against the previous ${cadenceLabel.toLowerCase()} period.</p>
        <table class="tbl">
          <thead><tr><th>Field</th><th class="num">Previous mean</th><th class="num">Current mean</th><th class="num">Δ</th><th class="num">Δ %</th><th>Direction</th></tr></thead>
          <tbody>
            ${fieldAnalyses.map((f) => {
              const c = f.comparison;
              if (!c) return `<tr><td>${esc(f.name)}</td><td colspan="5" class="empty-cell">Insufficient data</td></tr>`;
              const dir = c.improved ? "Improved" : c.declined ? "Declined" : "Stable";
              const col = c.improved ? "#3C8D50" : c.declined ? "#C23B3B" : "#839788";
              return `<tr>
                <td>${esc(f.name)}</td>
                <td class="num">${c.previous?.mean ?? "—"}</td>
                <td class="num">${c.current.mean}</td>
                <td class="num" style="color:${col};font-weight:600">${c.delta != null ? deltaLabel(c.delta) : "—"}</td>
                <td class="num" style="color:${col}">${c.deltaPct != null ? deltaLabel(c.deltaPct) + "%" : "—"}</td>
                <td style="color:${col};font-weight:600">${dir}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>`;

    // Rankings
    sHtml.rankings = `
      <section>
        <h2>Field performance rankings</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <h3>Top performers (by mean NDVI)</h3>
            ${rankings.top.length ? `<table class="tbl"><thead><tr><th>#</th><th>Field</th><th class="num">Mean NDVI</th></tr></thead><tbody>
              ${rankings.top.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td class="num good">${f.analysis.mean}</td></tr>`).join("")}
            </tbody></table>` : `<p class="empty">No data</p>`}
          </div>
          <div>
            <h3>Needs attention (lowest NDVI)</h3>
            ${rankings.bottom.length ? `<table class="tbl"><thead><tr><th>#</th><th>Field</th><th class="num">Mean NDVI</th></tr></thead><tbody>
              ${rankings.bottom.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td class="num bad">${f.analysis.mean}</td></tr>`).join("")}
            </tbody></table>` : `<p class="empty">No data</p>`}
          </div>
          <div>
            <h3>Most improved</h3>
            ${rankings.mostImproved.length ? `<table class="tbl"><thead><tr><th>#</th><th>Field</th><th class="num">NDVI change</th></tr></thead><tbody>
              ${rankings.mostImproved.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td class="num good">+${f.analysis.periodChange}</td></tr>`).join("")}
            </tbody></table>` : `<p class="empty">No improving fields</p>`}
          </div>
          <div>
            <h3>Most declined</h3>
            ${rankings.mostDeclined.length ? `<table class="tbl"><thead><tr><th>#</th><th>Field</th><th class="num">NDVI change</th></tr></thead><tbody>
              ${rankings.mostDeclined.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td class="num bad">${f.analysis.periodChange}</td></tr>`).join("")}
            </tbody></table>` : `<p class="empty">No declining fields</p>`}
          </div>
        </div>
      </section>`;

    // Operations + input impact
    sHtml.operations = `
      <section>
        <h2>Operations & input impact · ${esc(rangePretty)}</h2>
        <p class="meta">${rangeRecords.length} record${rangeRecords.length === 1 ? "" : "s"} in period · ${totals.totalN.toFixed(0)} kg N applied across farm.</p>
        ${fieldAnalyses.filter((f) => f.inputCorrelation).length ? `
        <h3>Input–NDVI correlation</h3>
        <p class="meta">NDVI measured before and up to 21 days after each application. A positive delta may indicate a growth response; negative could suggest crop stress or coincidental senescence.</p>
        <table class="tbl">
          <thead><tr><th>Field</th><th>Date</th><th>Product</th><th class="num">Rate</th><th class="num">NDVI before</th><th class="num">NDVI after</th><th class="num">Δ NDVI</th></tr></thead>
          <tbody>
            ${fieldAnalyses.filter((f) => f.inputCorrelation).flatMap((f) =>
              f.inputCorrelation.events.map((e) => `
                <tr>
                  <td>${esc(f.name)}</td>
                  <td>${esc(fmtDate(e.date))}</td>
                  <td>${esc(e.product)}</td>
                  <td class="num">${Number(e.rate || 0).toFixed(2)}</td>
                  <td class="num">${e.ndviBefore?.toFixed(3) ?? "—"}</td>
                  <td class="num">${e.ndviAfter?.toFixed(3) ?? "—"}</td>
                  <td class="num" style="color:${(e.ndviDelta ?? 0) >= 0 ? "#3C8D50" : "#C23B3B"};font-weight:600">${e.ndviDelta != null ? (e.ndviDelta > 0 ? "+" : "") + e.ndviDelta : "—"}</td>
                </tr>`)
            ).join("")}
          </tbody>
        </table>` : ""}
        ${rangeRecords.length ? `
        <h3>Full operations diary</h3>
        <table class="tbl">
          <thead><tr><th>Date</th><th>Field</th><th>Product</th><th class="num">Rate</th><th class="num">Area (ha)</th><th>Operator</th></tr></thead>
          <tbody>
            ${rangeRecords.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 60).map((r) => `
              <tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.fieldName || "—")}</td><td>${esc(r.productId || "—")}</td><td class="num">${Number(r.rate || 0).toFixed(2)}</td><td class="num">${Number(r.area || 0).toFixed(2)}</td><td>${esc(r.operator || "—")}</td></tr>`).join("")}
          </tbody>
        </table>
        ${rangeRecords.length > 60 ? `<p class="meta">60 most recent shown.</p>` : ""}` : `<p class="empty">No records in this period.</p>`}
      </section>`;

    // Fields
    sHtml.fields = `
      <section>
        <h2>Field registry</h2>
        <table class="tbl">
          <thead><tr><th>Field</th><th>Crop</th><th>Soil</th><th>Land use</th><th class="num">Area (ha)</th><th class="num">Health</th><th>Stage</th><th>Trend</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.name)}</td><td>${esc(r.crop)}</td><td>${esc(r.soil)}</td><td>${esc(r.landUse)}</td>
                <td class="num">${r.ha.toFixed(2)}</td>
                <td class="num" style="color:${r.h?.score != null ? scoreColor(r.h.score) : "inherit"};font-weight:600">${r.h?.score ?? "—"}</td>
                <td>${esc(r.h?.stage || "—")}</td>
                <td style="color:${r.h?.trend === "improving" ? "#3C8D50" : r.h?.trend === "declining" ? "#C23B3B" : "#839788"}">${esc(r.h?.trend || "—")}</td>
              </tr>`).join("")}
            <tr class="foot"><td colspan="4">Total</td><td class="num">${totals.totalHa.toFixed(2)}</td><td colspan="3"></td></tr>
          </tbody>
        </table>
      </section>`;

    // Schemes
    sHtml.schemes = `
      <section>
        <h2>Scheme eligibility snapshot</h2>
        <p class="meta">${totals.totalEligible} eligible actions across ${totals.fields} fields. ${totals.assignedCount} field${totals.assignedCount !== 1 ? "s" : ""} have assigned actions.</p>
        <table class="tbl">
          <thead><tr><th>Field</th><th>Land use</th><th class="num">Area (ha)</th><th class="num">Eligible</th><th>Assigned</th></tr></thead>
          <tbody>
            ${mappedFields.map((f) => {
              const sr = schemeResults.find((s) => s.fieldId === f.id);
              const raw = assignments[f.id];
              let codes = "—";
              if (raw?.codes?.length) codes = raw.codes.join(", ");
              else if (raw?.code && raw.code !== "—") codes = raw.code;
              return `<tr><td>${esc(f.name || "Unnamed")}</td><td>${esc(attrs[f.id]?.landUse || "—")}</td><td class="num">${(areas[f.id] || 0).toFixed(2)}</td><td class="num">${sr ? eligibleCount(sr.results) : 0}</td><td>${esc(codes)}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>`;

    // Elevation
    sHtml.elevation = `
      <section>
        <h2>Topography</h2>
        <table class="tbl">
          <thead><tr><th>Field</th><th class="num">Elev. mean (m)</th><th class="num">Slope (°)</th><th class="num">TWI</th><th>Aspect</th></tr></thead>
          <tbody>
            ${rows.map((r) => {
              const e = r.elev;
              if (!e || e.status !== "ok") return `<tr><td>${esc(r.name)}</td><td colspan="4" class="empty-cell">No data</td></tr>`;
              return `<tr><td>${esc(r.name)}</td><td class="num">${e.elevation_mean?.toFixed(1) ?? "—"}</td><td class="num">${e.slope_mean_deg?.toFixed(1) ?? "—"}</td><td class="num">${e.twi_mean?.toFixed(1) ?? "—"}</td><td>${esc(e.aspect_dominant || "—")}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>`;

    const body = selected.map((k) => sHtml[k] || "").join("\n");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(farmName)} — ${cadenceLabel} report</title>
<style>
  :root { --forest:#104E3F; --moss:#649A5C; --body:#3A4F47; --muted:#839788; --border:#D5E5D7; --bg:#EFF4F0; --ok:#3C8D50; --warn:#C27A1D; --bad:#C23B3B; }
  html,body{margin:0;padding:0;background:#fff;color:var(--body)}
  body{font-family:'DM Sans',system-ui,sans-serif;font-size:12px;line-height:1.55;padding:48px 56px}
  header.cover{border-bottom:1px solid var(--border);padding-bottom:26px;margin-bottom:28px}
  .kicker{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--moss)}
  .cadence-badge{display:inline-block;padding:4px 10px;border-radius:3px;background:var(--forest);color:#fff;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-left:8px}
  h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:38px;letter-spacing:-0.02em;color:var(--forest);margin:10px 0 6px}
  h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:22px;color:var(--forest);margin:28px 0 12px;border-bottom:1px solid var(--border);padding-bottom:6px}
  h3{font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;color:var(--forest);margin:20px 0 8px}
  p.meta{color:var(--muted);font-size:11px;margin:0 0 10px}
  p.empty{font-style:italic;color:var(--muted);border:1px dashed var(--border);padding:14px;border-radius:2px;background:var(--bg)}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:12px 0 0}
  .stats .cell{border:1px solid var(--border);padding:10px 12px;border-radius:2px}
  .stats .cell .lab{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted)}
  .stats .cell .val{font-family:'Instrument Serif',Georgia,serif;font-size:22px;color:var(--forest);margin-top:2px}
  table.tbl{width:100%;border-collapse:collapse;margin-top:6px;font-size:11px}
  table.tbl th,table.tbl td{border-top:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
  table.tbl th{background:var(--bg);font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted);font-weight:400;border-top:none}
  table.tbl td.num,table.tbl th.num{text-align:right;font-family:'JetBrains Mono',monospace}
  table.tbl tr.foot td{font-weight:600;background:var(--bg);color:var(--forest)}
  td.good,.good{color:var(--ok);font-weight:600}
  td.mid,.mid{color:var(--warn);font-weight:600}
  td.bad,.bad{color:var(--bad);font-weight:600}
  td.empty-cell{color:var(--muted);font-style:italic}
  .recs{display:grid;gap:10px}
  .rec{padding:12px 14px;border-radius:3px;background:var(--bg)}
  .rec-head{display:flex;gap:10px;align-items:center;margin-bottom:4px}
  .pri{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700}
  .rec-cat{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.10em;text-transform:uppercase;color:var(--muted)}
  .rec-title{font-weight:600;color:var(--forest);font-size:13px;margin-bottom:3px}
  .rec-detail{color:var(--body);font-size:11.5px;line-height:1.55}
  footer.fin{margin-top:40px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:10px;font-family:'JetBrains Mono',monospace;letter-spacing:0.08em;display:flex;justify-content:space-between}
  @media print{body{padding:28px 32px}h2{page-break-after:avoid}section{page-break-inside:avoid}}
</style>
</head>
<body>
  <header class="cover">
    <div class="kicker">Tilth ${cadenceLabel.toLowerCase()} report<span class="cadence-badge">${cadenceLabel}</span></div>
    <h1>${esc(farmName)}</h1>
    <p class="meta">${esc(rangePretty)} · Generated ${esc(generatedAt)}</p>
    <div class="stats">
      <div class="cell"><div class="lab">Fields</div><div class="val">${totals.fields}</div></div>
      <div class="cell"><div class="lab">Total area</div><div class="val">${totals.totalHa.toFixed(1)} ha</div></div>
      <div class="cell"><div class="lab">Farm NDVI</div><div class="val">${farmNdviSummary?.farmMean ?? "—"}</div></div>
      <div class="cell"><div class="lab">Recommendations</div><div class="val">${recommendations.length}</div></div>
    </div>
  </header>

  ${body}

  <footer class="fin">
    <span>Tilth · Fangorn</span>
    <span>${esc(generatedAt)}</span>
  </footer>
</body>
</html>`;
  }, [sections, cadence, range, farm, mappedFields, areas, rangeRecords, yieldStore, assignments, attrs, totals, healthSummary, elevData, schemeResults, year, farmHealth, fieldAnalyses, rankings, recommendations, farmNdviSummary]);

  const openReportWindow = (html, name) => {
    const w = window.open("", "_blank", "width=960,height=1000");
    if (!w) {
      alert("Allow pop-ups to open the report.");
      return null;
    }
    w.document.open();
    w.document.write(html.replace("</head>", `<script>document.title = ${JSON.stringify(name)};</script></head>`));
    w.document.close();
    return w;
  };

  const openPreview = () => {
    const h = buildHtml();
    openReportWindow(h, `${farm?.name || "Farm"} ${CADENCE[cadence].label} report`);
  };

  const downloadPdf = () => {
    const h = buildHtml();
    const slug = (farm?.name || "farm").toLowerCase().replace(/\s+/g, "-");
    const now = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const filename = `tilth-${slug}-${cadence}-${now}.pdf`;
    persistLibrary([{ id: `rep_${Date.now().toString(36)}`, title: `${CADENCE[cadence].label} report · ${prettyRange(range.start, range.end)}`, generated_at: isoDay(new Date()), cadence, sections: Object.entries(sections).filter(([, v]) => v).map(([k]) => k), filename }, ...library].slice(0, 20));
    const w = openReportWindow(h, filename);
    if (!w) return;
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch {
        /* browser blocked print */
      }
    }, 500);
  };

  const anySelected = Object.values(sections).some(Boolean);

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Reporting"
          title="Farm reports"
          description="Time-series NDVI analysis, field rankings, input-response correlation, recommendations and period comparisons. Weekly, monthly or quarterly."
          actions={<>
            <Button variant="secondary" size="sm" onClick={openPreview} disabled={!anySelected || !totals.fields}>Preview</Button>
            <Button variant="primary" size="sm" onClick={downloadPdf} disabled={!anySelected || !totals.fields}>Download PDF</Button>
          </>}
        />
      }
    >
      <div className="tilth-rep-layout" style={{ flex: "1 1 auto", minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 12, overflow: "hidden" }}>
        {/* Left */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto", paddingRight: 4 }} className="tilth-scroll">
          <Card padding={14}>
            <Kicker style={{ marginBottom: 8 }}>Report cadence</Kicker>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(CADENCE).map(([id, c]) => <CadenceTab key={id} label={c.label} active={cadence === id} onClick={() => setCadence(id)} />)}
            </div>
            <div style={{ marginTop: 8, fontFamily: fonts.sans, fontSize: 12, color: brand.muted }}>
              Covering: <strong style={{ color: brand.forest }}>{prettyRange(range.start, range.end)}</strong> ({CADENCE[cadence].days} days)
            </div>
          </Card>

          <Card padding={14} tone="section">
            <Kicker style={{ marginBottom: 6 }}>Farm snapshot</Kicker>
            <Headline size="sm">{farm?.name || "Unnamed farm"}</Headline>
            <Body size="sm" style={{ marginTop: 6 }}>{prettyRange(range.start, range.end)}</Body>
            <Divider style={{ margin: "12px 0" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              <MiniKv label="Fields" value={totals.fields} />
              <MiniKv label="Farm NDVI" value={farmNdviSummary?.farmMean ?? "—"} />
              <MiniKv label="Recs" value={recommendations.length} />
              <MiniKv label="Scenes" value={farmNdviSummary?.totalScenes ?? 0} />
            </div>
          </Card>

          <Card padding={12}>
            <Subpanel kicker="Sections" title="Include in report" actions={<Pill tone="neutral">{Object.values(sections).filter(Boolean).length} selected</Pill>} style={{ marginBottom: 0 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
                {ALL_SECTIONS.map((s) => <SectionToggle key={s.key} label={s.label} on={sections[s.key]} onToggle={() => setSections((p) => ({ ...p, [s.key]: !p[s.key] }))} />)}
              </div>
            </Subpanel>
          </Card>

          {/* Live recommendations preview */}
          {recommendations.length > 0 && (
            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>Top recommendations</Kicker>
              <div style={{ display: "grid", gap: 6 }}>
                {recommendations.slice(0, 4).map((r, i) => (
                  <div key={i} style={{ padding: "8px 10px", borderRadius: radius.base, border: `1px solid ${brand.border}`, borderLeft: `3px solid ${r.priority === "high" ? brand.danger : r.priority === "medium" ? brand.warn : brand.moss}`, background: brand.white }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                      <Pill tone={r.priority === "high" ? "danger" : r.priority === "medium" ? "warn" : "ok"}>{r.priority}</Pill>
                      <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, textTransform: "uppercase", letterSpacing: "0.10em" }}>{r.category}</span>
                    </div>
                    <div style={{ fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600, color: brand.forest }}>{r.title}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card padding={12}>
            <Kicker style={{ marginBottom: 6 }}>Data status</Kicker>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Pill tone={totals.fields ? "ok" : "warn"}>{totals.fields} fields</Pill>
              <Pill tone={farmNdviSummary ? "ok" : "neutral"}>NDVI {farmHealth.status === "ready" ? "ready" : "loading"}</Pill>
              <Pill tone={totals.records ? "ok" : "neutral"}>{totals.records} records</Pill>
              <Pill tone={totals.totalEligible ? "ok" : "neutral"}>{totals.totalEligible} eligible schemes</Pill>
            </div>
          </Card>
        </div>

        {/* Right sidebar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto", paddingRight: 4 }} className="tilth-scroll">
          <Card padding={12}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <Kicker>Library</Kicker>
              <Pill tone="neutral">{library.length}</Pill>
            </div>
            {library.length ? (
              <div style={{ display: "grid", gap: 4 }}>
                {library.map((r) => (
                  <div key={r.id} style={{ padding: "8px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: brand.forest, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginTop: 2 }}>{r.generated_at} · {r.cadence || "—"} · {(r.sections || []).length} sections</div>
                    </div>
                    <button type="button" onClick={() => removeReport(r.id)} style={{ background: "transparent", border: `1px solid ${brand.border}`, borderRadius: radius.base, width: 24, height: 24, color: brand.muted, cursor: "pointer" }}>×</button>
                  </div>
                ))}
              </div>
            ) : <Body size="sm">Download a report to start your library.</Body>}
          </Card>

          <Card padding={12}>
            <Kicker style={{ marginBottom: 6 }}>What's in each cadence</Kicker>
            <div style={{ display: "grid", gap: 6 }}>
              <CadenceInfo label="Weekly" items={["NDVI trend + sparklines", "Anomaly detection & dips", "Input–NDVI response", "Field rankings", "Actionable recommendations"]} />
              <CadenceInfo label="Monthly" items={["Everything in weekly", "Field registry with health", "Scheme eligibility status", "Period-over-period Δ"]} />
              <CadenceInfo label="Quarterly" items={["Everything in monthly", "Yield summary", "Topography analysis", "Season-level strategic view"]} />
            </div>
          </Card>

          <Card padding={12} tone="section">
            <Kicker style={{ marginBottom: 6 }}>About</Kicker>
            <Body size="sm" style={{ lineHeight: 1.55 }}>
              NDVI time-series are cloud-masked (SCL + Hampel outlier filter). Slopes are
              computed by OLS regression over the period. Input correlation uses a ±21-day
              window around each application. Use "Print → Save as PDF" for a portable copy.
            </Body>
          </Card>
        </div>
      </div>

      <style>{`@media (max-width: 1250px) { .tilth-rep-layout { grid-template-columns: 1fr !important; } }`}</style>
    </WorkspaceFrame>
  );
}

function CadenceInfo({ label, items }) {
  return (
    <div style={{ padding: "6px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white }}>
      <div style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 600, color: brand.forest, marginBottom: 3 }}>{label}</div>
      {items.map((it, i) => (
        <div key={i} style={{ fontFamily: fonts.sans, fontSize: 10.5, color: brand.muted, lineHeight: 1.6, paddingLeft: 10, position: "relative" }}>
          <span style={{ position: "absolute", left: 0 }}>·</span>{it}
        </div>
      ))}
    </div>
  );
}

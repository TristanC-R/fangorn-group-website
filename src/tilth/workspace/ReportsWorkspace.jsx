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
import { ringAreaSqDeg, ringCentroid } from "../geoPointInPolygon.js";
import { useFarmHealth } from "../../lib/cropHealth.js";
import { useFieldElevation } from "../../lib/tilthElevation.js";
import { supabase } from "../../lib/supabaseClient.js";
import { fetchTilthApi, tilthApiConfigured } from "../../lib/tilthApi.js";
import {
  computeFieldWorkOutlook,
  computeGDD,
  computeSprayWindow,
  frostRiskHours,
  useWeatherForecast,
  WEATHER_CODES,
} from "../../lib/weather.js";
import { FALLBACK_MARKET_ROWS } from "../../lib/marketData.js";
import { evaluateField, eligibleCount } from "../../lib/schemeEligibility.js";
import {
  analyseFieldPeriod,
  periodComparison,
  farmRankings,
  generateRecommendations,
  sparklineSvg,
  operationsCorrelation,
} from "../../lib/reportAnalytics.js";
import { SPECTRAL_INDEX_LIST } from "../../lib/spectralIndices.js";

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
function money(value) { const n = Number(value); return Number.isFinite(n) ? `£${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}` : "—"; }
function dateValue(value) { const t = value ? new Date(value).getTime() : NaN; return Number.isFinite(t) ? t : null; }
function inRangeDate(value, start, end) { const t = dateValue(value); return t != null && t >= start.getTime() && t <= end.getTime(); }
function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows || []) {
    const key = keyFn(row) || "other";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
function sumBy(rows, valueFn) {
  return (rows || []).reduce((sum, row) => sum + (Number(valueFn(row)) || 0), 0);
}

// ─── Cadences ────────────────────────────────────────────────────────

const CADENCE = {
  weekly:    { label: "Weekly",    days: 7,  defaults: { overview: true, operationsSnapshot: true, weather: true, finance: true, inventory: true, observations: true, compliance: true, markets: false, livestock: false, timeSeries: true, recommendations: true, operations: true, rankings: true, popComparison: true, fields: false, schemes: false, elevation: false } },
  monthly:   { label: "Monthly",   days: 30, defaults: { overview: true, operationsSnapshot: true, weather: true, finance: true, markets: true, inventory: true, observations: true, livestock: true, compliance: true, timeSeries: true, recommendations: true, operations: true, rankings: true, popComparison: true, fields: true, schemes: true, elevation: false } },
  quarterly: { label: "Quarterly", days: 91, defaults: { overview: true, operationsSnapshot: true, weather: true, finance: true, markets: true, inventory: true, observations: true, livestock: true, compliance: true, timeSeries: true, recommendations: true, operations: true, rankings: true, popComparison: true, fields: true, schemes: true, elevation: true } },
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
  { key: "operationsSnapshot", label: "Whole-farm operations snapshot" },
  { key: "weather",         label: "Weather & workability" },
  { key: "finance",         label: "Finance performance" },
  { key: "markets",         label: "Markets, sales & purchases" },
  { key: "inventory",       label: "Store & inventory" },
  { key: "observations",    label: "Field observations" },
  { key: "livestock",       label: "Livestock" },
  { key: "compliance",      label: "Compliance & audit" },
  { key: "timeSeries",      label: "Spectral time-series analysis" },
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
  const tasks = useMemo(() => tilthStore.loadTasks(farmId), [farmId]);
  const finances = useMemo(() => tilthStore.loadFinances(farmId), [farmId]);
  const inventory = useMemo(() => tilthStore.loadInventory(farmId), [farmId]);
  const observations = useMemo(() => tilthStore.loadNamespace("observations", farmId, []), [farmId]);
  const livestock = useMemo(() => tilthStore.loadNamespace("livestock", farmId, []), [farmId]);
  const livestockMovements = useMemo(() => tilthStore.loadNamespace("livestock_movements", farmId, []), [farmId]);
  const livestockMedicines = useMemo(() => tilthStore.loadNamespace("livestock_medicines", farmId, []), [farmId]);
  const livestockBreeding = useMemo(() => tilthStore.loadNamespace("livestock_breeding", farmId, []), [farmId]);
  const marketPrices = useMemo(() => tilthStore.loadNamespace("market_prices", farmId, {}), [farmId]);
  const marketSales = useMemo(() => tilthStore.loadNamespace("market_sales", farmId, []), [farmId]);
  const marketPurchases = useMemo(() => tilthStore.loadNamespace("market_purchases", farmId, []), [farmId]);
  const marketWatchlist = useMemo(() => tilthStore.loadNamespace("market_watchlist", farmId, []), [farmId]);
  const auditChecklists = useMemo(() => tilthStore.loadNamespace("audit_checklists", farmId, {}), [farmId]);
  const preharvestSafety = useMemo(() => tilthStore.loadNamespace("preharvest_safety", farmId, []), [farmId]);
  const officialSettings = useMemo(() => tilthStore.loadNamespace("official_data_settings", farmId, {}), [farmId]);

  const mappedFields = useMemo(() => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3), [fields]);
  const fieldIds = useMemo(() => mappedFields.map((f) => f.id), [mappedFields]);
  const areas = useMemo(() => { const m = {}; for (const f of mappedFields) m[f.id] = approxHectares(f.boundary); return m; }, [mappedFields]);
  const totalHa = useMemo(() => Object.values(areas).reduce((a, v) => a + v, 0), [areas]);
  const weatherCenter = useMemo(() => {
    const field = mappedFields.find((f) => f.boundary?.length >= 3);
    return field ? ringCentroid(field.boundary) : null;
  }, [mappedFields]);
  const { forecast } = useWeatherForecast(weatherCenter?.lat, weatherCenter?.lng);

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

  const rangeTasks = useMemo(() => (tasks || []).filter((t) => inRangeDate(t.dueDate || t.date || t.createdAt, range.start, range.end)), [tasks, range]);
  const rangeFinances = useMemo(() => (finances || []).filter((t) => inRangeDate(t.date, range.start, range.end)), [finances, range]);
  const rangeObservations = useMemo(() => (observations || []).filter((o) => inRangeDate(o.datetime || o.date || o.createdAt, range.start, range.end)), [observations, range]);
  const rangeMarketSales = useMemo(() => (marketSales || []).filter((s) => inRangeDate(s.date || s.contractDate || s.createdAt, range.start, range.end)), [marketSales, range]);
  const rangeMarketPurchases = useMemo(() => (marketPurchases || []).filter((p) => inRangeDate(p.date || p.purchaseDate || p.createdAt, range.start, range.end)), [marketPurchases, range]);
  const rangeLivestockMovements = useMemo(() => (livestockMovements || []).filter((m) => inRangeDate(m.date || m.movementDate || m.createdAt, range.start, range.end)), [livestockMovements, range]);
  const rangeLivestockMedicines = useMemo(() => (livestockMedicines || []).filter((m) => inRangeDate(m.date || m.treatmentDate || m.createdAt, range.start, range.end)), [livestockMedicines, range]);
  const rangeLivestockBreeding = useMemo(() => (livestockBreeding || []).filter((b) => inRangeDate(b.date || b.eventDate || b.createdAt, range.start, range.end)), [livestockBreeding, range]);

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
      const income = sumBy(rangeFinances.filter((t) => t.type === "income"), (t) => t.amount);
      const expenses = sumBy(rangeFinances.filter((t) => t.type !== "income"), (t) => t.amount);
      const inventoryValue = sumBy(inventory, (item) => (Number(item.quantity) || 0) * (Number(item.unitCost) || 0));
      const activeLivestock = (livestock || []).filter((a) => !a.status || a.status === "active").length;
      return {
        fields: mappedFields.length,
        totalHa,
        records: rangeRecords.length,
        withYield,
        assignedCount,
        totalN,
        totalEligible,
        tasks: rangeTasks.length,
        income,
        expenses,
        netMargin: income - expenses,
        inventoryItems: inventory.length,
        inventoryValue,
        observations: rangeObservations.length,
        livestock: activeLivestock,
      };
    } catch { return { fields: 0, totalHa: 0, records: 0, withYield: 0, assignedCount: 0, totalN: 0, totalEligible: 0 }; }
  }, [mappedFields, rangeRecords, yieldStore, assignments, year, totalHa, schemeResults, rangeFinances, inventory, livestock, rangeTasks, rangeObservations]);

  // Health summary
  const healthSummary = useMemo(() => {
    if (farmHealth.status !== "ready" || !farmHealth.health) return null;
    let healthy = 0, watch = 0, poor = 0;
    for (const f of mappedFields) { const h = farmHealth.health.get?.(f.id); if (!h?.score) continue; if (h.score >= 65) healthy++; else if (h.score >= 40) watch++; else poor++; }
    return { healthy, watch, poor };
  }, [farmHealth, mappedFields]);

  const weatherSummary = useMemo(() => {
    if (!forecast) return null;
    const daily = forecast.daily || [];
    const sprayWindows = forecast.hourly ? computeSprayWindow(forecast.hourly).slice(0, 8) : [];
    const fieldWork = daily.length ? computeFieldWorkOutlook(daily).slice(0, 7) : [];
    const frosts = forecast.hourly ? frostRiskHours(forecast.hourly).slice(0, 12) : [];
    const gdd = forecast.hourly ? computeGDD(forecast.hourly, 0) : null;
    const rainTotal = sumBy(daily, (d) => d.precipSum);
    return {
      location: weatherCenter ? { lat: Number(weatherCenter.lat.toFixed(4)), lng: Number(weatherCenter.lng.toFixed(4)) } : null,
      rainTotal: Number(rainTotal.toFixed(1)),
      gdd: gdd == null ? null : Math.round(gdd),
      frostRiskHours: frosts.length,
      sprayWindows,
      fieldWork,
      daily: daily.slice(0, 7).map((d) => ({
        date: d.date,
        tempMin: d.tempMin,
        tempMax: d.tempMax,
        rainMm: d.precipSum,
        windMax: d.windMax,
        weather: WEATHER_CODES[d.weatherCode]?.description || d.weather || "—",
      })),
    };
  }, [forecast, weatherCenter]);

  const financeSummary = useMemo(() => ({
    transactionCount: rangeFinances.length,
    income: totals.income || 0,
    expenses: totals.expenses || 0,
    netMargin: totals.netMargin || 0,
    byCategory: Object.entries(rangeFinances.reduce((acc, t) => {
      const key = `${t.type || "expense"}:${t.category || "other"}`;
      acc[key] = (acc[key] || 0) + (Number(t.amount) || 0);
      return acc;
    }, {})).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8),
    recent: rangeFinances.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 12),
  }), [rangeFinances, totals.income, totals.expenses, totals.netMargin]);

  const inventorySummary = useMemo(() => {
    const now = new Date();
    const expiringSoon = inventory.filter((item) => {
      const t = dateValue(item.expiryDate);
      return t != null && t >= now.getTime() && t <= now.getTime() + 45 * 86_400_000;
    });
    const expired = inventory.filter((item) => {
      const t = dateValue(item.expiryDate);
      return t != null && t < now.getTime();
    });
    const lowStock = inventory.filter((item) => item.lowStockThreshold != null && (Number(item.quantity) || 0) < Number(item.lowStockThreshold));
    return {
      itemCount: inventory.length,
      totalValue: totals.inventoryValue || 0,
      byCategory: countBy(inventory, (item) => item.category),
      expired: expired.slice(0, 10),
      expiringSoon: expiringSoon.slice(0, 10),
      lowStock: lowStock.slice(0, 10),
    };
  }, [inventory, totals.inventoryValue]);

  const marketSummary = useMemo(() => ({
    salesCount: rangeMarketSales.length,
    salesValue: sumBy(rangeMarketSales, (s) => (Number(s.qty || s.quantity) || 0) * (Number(s.pricePerUnit || s.price) || 0)),
    purchasesCount: rangeMarketPurchases.length,
    purchasesValue: sumBy(rangeMarketPurchases, (p) => (Number(p.qty || p.quantity) || 0) * (Number(p.pricePerUnit || p.price) || 0)),
    watchlist: marketWatchlist.slice(0, 10),
    prices: FALLBACK_MARKET_ROWS.slice(0, 12).map((row) => ({ ...row, localPrice: marketPrices[row.id] ?? null })),
    recentSales: rangeMarketSales.slice(-10),
    recentPurchases: rangeMarketPurchases.slice(-10),
  }), [rangeMarketSales, rangeMarketPurchases, marketWatchlist, marketPrices]);

  const livestockSummary = useMemo(() => ({
    active: (livestock || []).filter((a) => !a.status || a.status === "active").length,
    bySpecies: countBy(livestock, (animal) => animal.species),
    movements: rangeLivestockMovements.length,
    medicines: rangeLivestockMedicines.length,
    breedingEvents: rangeLivestockBreeding.length,
    recentMovements: rangeLivestockMovements.slice(-10),
    recentMedicines: rangeLivestockMedicines.slice(-10),
    recentBreeding: rangeLivestockBreeding.slice(-10),
  }), [livestock, rangeLivestockMovements, rangeLivestockMedicines, rangeLivestockBreeding]);

  const complianceSummary = useMemo(() => {
    const checklistRows = Object.entries(auditChecklists || {}).flatMap(([standard, rows]) =>
      Object.entries(rows || {}).map(([item, value]) => ({ standard, item, value }))
    );
    const completed = checklistRows.filter((row) => row.value === true || row.value?.status === "complete").length;
    const gaps = checklistRows.filter((row) => row.value === false || row.value?.status === "gap" || row.value?.status === "missing");
    return {
      sbi: officialSettings?.sbi || null,
      checklistItems: checklistRows.length,
      completed,
      gaps: gaps.slice(0, 15),
      preharvestForms: preharvestSafety.length,
      recentPreharvest: preharvestSafety.slice(-10),
      schemeEligibleActions: totals.totalEligible,
      assignedSchemeActions: totals.assignedCount,
    };
  }, [auditChecklists, officialSettings, preharvestSafety, totals.totalEligible, totals.assignedCount]);

  // Library
  const [library, setLibrary] = useState(() => { try { return JSON.parse(window.localStorage.getItem(`tilth:reports:${farmId || "default"}`) || "[]"); } catch { return []; } });
  const [reportMode, setReportMode] = useState("factual");
  const [interpretiveReports, setInterpretiveReports] = useState([]);
  const [interpretiveBusy, setInterpretiveBusy] = useState(false);
  const [interpretiveError, setInterpretiveError] = useState("");
  const persistLibrary = (next) => { setLibrary(next); try { window.localStorage.setItem(`tilth:reports:${farmId || "default"}`, JSON.stringify(next)); } catch { /* */ } };
  const removeReport = (id) => persistLibrary(library.filter((r) => r.id !== id));

  const buildReportSections = useCallback(() => {
    const selected = Object.entries(sections).filter(([, v]) => v).map(([k]) => k);
    const rows = mappedFields.map((f) => {
      const analysis = fieldAnalyses.find((x) => x.fieldId === f.id);
      const health = farmHealth.health?.get?.(f.id) || null;
      const attrsForField = attrs[f.id] || {};
      return {
        id: f.id,
        name: f.name || "Unnamed",
        areaHa: Number((areas[f.id] || 0).toFixed(2)),
        crop: attrsForField.crop || null,
        soil: attrsForField.soil || null,
        landUse: attrsForField.landUse || null,
        health: health ? {
          score: health.score ?? null,
          stage: health.stage || null,
          trend: health.trend || null,
          confidence: health.confidence || null,
          flags: health.flags || [],
          summary: health.summary || null,
        } : null,
        analysis: analysis?.analysis ? {
          sceneCount: analysis.analysis.sceneCount,
          meanNdvi: analysis.analysis.mean,
          startNdvi: analysis.analysis.startNdvi,
          endNdvi: analysis.analysis.endNdvi,
          periodChange: analysis.analysis.periodChange,
          slopePerDay: analysis.analysis.slopePerDay,
          peakNdvi: analysis.analysis.peakNdvi,
          peakDate: analysis.analysis.peakDate,
          maxDip: analysis.analysis.maxDip,
          stddev: analysis.analysis.stddev,
          spectral: analysis.analysis.spectral || null,
        } : null,
        comparison: analysis?.comparison || null,
        inputEvents: analysis?.inputCorrelation?.events?.slice(0, 8) || [],
      };
    });
    const sectionEvidence = {
      overview: { totals, farmNdviSummary, healthSummary, fieldCount: rows.length },
      operationsSnapshot: {
        totals,
        tasksByStatus: countBy(rangeTasks, (task) => task.status),
        tasksByCategory: countBy(rangeTasks, (task) => task.category),
        recordCount: rangeRecords.length,
        finance: financeSummary,
        weather: weatherSummary,
        market: marketSummary,
        inventory: inventorySummary,
        observations: { count: rangeObservations.length, byType: countBy(rangeObservations, (obs) => obs.type), recent: rangeObservations.slice(-12) },
        livestock: livestockSummary,
        compliance: complianceSummary,
      },
      weather: weatherSummary,
      finance: financeSummary,
      markets: marketSummary,
      inventory: inventorySummary,
      observations: { count: rangeObservations.length, byType: countBy(rangeObservations, (obs) => obs.type), recent: rangeObservations.slice(-20) },
      livestock: livestockSummary,
      compliance: complianceSummary,
      timeSeries: { range: prettyRange(range.start, range.end), fields: rows.map((r) => ({ name: r.name, areaHa: r.areaHa, analysis: r.analysis })) },
      recommendations: { recommendations: recommendations.slice(0, 20) },
      popComparison: { cadence, fields: rows.map((r) => ({ name: r.name, comparison: r.comparison })) },
      rankings,
      operations: { recordCount: rangeRecords.length, totalNitrogenKg: Number(totals.totalN.toFixed(1)), records: rangeRecords.slice(0, 30), inputEvents: rows.flatMap((r) => r.inputEvents.map((event) => ({ field: r.name, ...event }))).slice(0, 30) },
      fields: { fields: rows.map((r) => ({ name: r.name, areaHa: r.areaHa, crop: r.crop, soil: r.soil, landUse: r.landUse, health: r.health })) },
      schemes: { totalEligible: totals.totalEligible, assignedCount: totals.assignedCount, fields: mappedFields.map((f) => ({ name: f.name || "Unnamed", landUse: attrs[f.id]?.landUse || null, areaHa: Number((areas[f.id] || 0).toFixed(2)), eligible: eligibleCount(schemeResults.find((s) => s.fieldId === f.id)?.results || []), assigned: assignments[f.id] || null })) },
      elevation: { fields: rows.map((r) => ({ name: r.name, elevation: elevData.get(r.id) || null })) },
    };
    return selected.map((key) => ({
      key,
      title: ALL_SECTIONS.find((section) => section.key === key)?.label || key,
      evidence: sectionEvidence[key] || null,
    }));
  }, [sections, mappedFields, fieldAnalyses, farmHealth.health, attrs, areas, totals, farmNdviSummary, healthSummary, range.start, range.end, rangeTasks, rangeRecords, financeSummary, weatherSummary, marketSummary, inventorySummary, rangeObservations, livestockSummary, complianceSummary, recommendations, cadence, rankings, assignments, schemeResults, elevData]);

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
      <section data-report-section="overview">
        <h2>Farm overview</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Fields</div><div class="val">${totals.fields}</div></div>
          <div class="cell"><div class="lab">Total area</div><div class="val">${totals.totalHa.toFixed(1)} ha</div></div>
          <div class="cell"><div class="lab">Net margin</div><div class="val">${money(totals.netMargin)}</div></div>
          <div class="cell"><div class="lab">Open tasks</div><div class="val">${rangeTasks.filter((task) => task.status !== "completed" && task.status !== "cancelled").length}</div></div>
        </div>
        ${healthSummary ? `<p class="meta" style="margin-top:12px">${healthSummary.healthy} field${healthSummary.healthy !== 1 ? "s" : ""} healthy · ${healthSummary.watch} on watch · ${healthSummary.poor} poor</p>` : ""}
        <p class="meta">${rangeRecords.length} field operation records · ${rangeFinances.length} finance transactions · ${rangeObservations.length} observations · ${inventory.length} store items · ${totals.livestock || 0} active livestock.</p>
        ${farmNdviSummary ? `<p class="meta">${farmNdviSummary.improving} improving · ${farmNdviSummary.stable} stable · ${farmNdviSummary.declining} declining across the period</p>` : ""}
      </section>`;

    sHtml.operationsSnapshot = `
      <section data-report-section="operationsSnapshot">
        <h2>Whole-farm operations snapshot · ${esc(rangePretty)}</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Field records</div><div class="val">${rangeRecords.length}</div></div>
          <div class="cell"><div class="lab">Tasks due</div><div class="val">${rangeTasks.length}</div></div>
          <div class="cell"><div class="lab">Observations</div><div class="val">${rangeObservations.length}</div></div>
          <div class="cell"><div class="lab">Store value</div><div class="val">${money(totals.inventoryValue)}</div></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Area</th><th class="num">Count</th><th>Current read</th></tr></thead>
          <tbody>
            <tr><td>Finance</td><td class="num">${rangeFinances.length}</td><td>Income ${money(totals.income)} · expenses ${money(totals.expenses)} · net ${money(totals.netMargin)}</td></tr>
            <tr><td>Markets</td><td class="num">${rangeMarketSales.length + rangeMarketPurchases.length}</td><td>Sales ${money(marketSummary.salesValue)} · purchases ${money(marketSummary.purchasesValue)} · ${marketWatchlist.length} watchlist item${marketWatchlist.length === 1 ? "" : "s"}</td></tr>
            <tr><td>Livestock</td><td class="num">${totals.livestock || 0}</td><td>${rangeLivestockMovements.length} movement${rangeLivestockMovements.length === 1 ? "" : "s"} · ${rangeLivestockMedicines.length} medicine record${rangeLivestockMedicines.length === 1 ? "" : "s"} · ${rangeLivestockBreeding.length} breeding event${rangeLivestockBreeding.length === 1 ? "" : "s"}</td></tr>
            <tr><td>Compliance</td><td class="num">${complianceSummary.completed}/${complianceSummary.checklistItems}</td><td>${complianceSummary.gaps.length} audit gap${complianceSummary.gaps.length === 1 ? "" : "s"} flagged · ${complianceSummary.preharvestForms} pre-harvest form${complianceSummary.preharvestForms === 1 ? "" : "s"}</td></tr>
          </tbody>
        </table>
      </section>`;

    sHtml.weather = `
      <section data-report-section="weather">
        <h2>Weather & workability</h2>
        ${weatherSummary ? `
        <div class="stats">
          <div class="cell"><div class="lab">7-day rain</div><div class="val">${weatherSummary.rainTotal} mm</div></div>
          <div class="cell"><div class="lab">GDD base 0°C</div><div class="val">${weatherSummary.gdd ?? "—"}</div></div>
          <div class="cell"><div class="lab">Spray windows</div><div class="val">${weatherSummary.sprayWindows.length}</div></div>
          <div class="cell"><div class="lab">Frost risk hrs</div><div class="val">${weatherSummary.frostRiskHours}</div></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Date</th><th>Weather</th><th class="num">Temp</th><th class="num">Rain</th><th class="num">Wind</th><th>Field work</th></tr></thead>
          <tbody>
            ${weatherSummary.daily.map((d) => {
              const work = weatherSummary.fieldWork.find((w) => w.date === d.date);
              return `<tr><td>${esc(fmtDate(d.date))}</td><td>${esc(d.weather)}</td><td class="num">${d.tempMin ?? "—"}–${d.tempMax ?? "—"}°C</td><td class="num">${d.rainMm ?? 0} mm</td><td class="num">${d.windMax ?? "—"} km/h</td><td>${esc(work?.summary || "—")}</td></tr>`;
            }).join("")}
          </tbody>
        </table>` : `<p class="empty">Weather forecast unavailable. Add mapped fields and check the weather service connection.</p>`}
      </section>`;

    sHtml.finance = `
      <section data-report-section="finance">
        <h2>Finance performance · ${esc(rangePretty)}</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Income</div><div class="val">${money(totals.income)}</div></div>
          <div class="cell"><div class="lab">Expenses</div><div class="val">${money(totals.expenses)}</div></div>
          <div class="cell"><div class="lab">Net</div><div class="val">${money(totals.netMargin)}</div></div>
          <div class="cell"><div class="lab">Transactions</div><div class="val">${rangeFinances.length}</div></div>
        </div>
        ${financeSummary.byCategory.length ? `<table class="tbl"><thead><tr><th>Category</th><th class="num">Amount</th></tr></thead><tbody>${financeSummary.byCategory.map(([key, value]) => `<tr><td>${esc(key.replace(":", " · "))}</td><td class="num">${money(value)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No finance transactions in this period.</p>`}
      </section>`;

    sHtml.markets = `
      <section data-report-section="markets">
        <h2>Markets, sales & purchases</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Sales</div><div class="val">${money(marketSummary.salesValue)}</div></div>
          <div class="cell"><div class="lab">Purchases</div><div class="val">${money(marketSummary.purchasesValue)}</div></div>
          <div class="cell"><div class="lab">Watchlist</div><div class="val">${marketWatchlist.length}</div></div>
          <div class="cell"><div class="lab">Price rows</div><div class="val">${marketSummary.prices.length}</div></div>
        </div>
        <table class="tbl"><thead><tr><th>Commodity</th><th>Market</th><th class="num">Reference</th><th class="num">Local</th><th>Trend</th></tr></thead><tbody>
          ${marketSummary.prices.slice(0, 10).map((row) => `<tr><td>${esc(row.commodity)}</td><td>${esc(row.market)}</td><td class="num">${row.value != null ? `${row.value} ${esc(row.unit || "")}` : "—"}</td><td class="num">${row.localPrice ?? "—"}</td><td>${esc(row.trend || "—")}</td></tr>`).join("")}
        </tbody></table>
      </section>`;

    sHtml.inventory = `
      <section data-report-section="inventory">
        <h2>Store & inventory</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Items</div><div class="val">${inventory.length}</div></div>
          <div class="cell"><div class="lab">Value</div><div class="val">${money(totals.inventoryValue)}</div></div>
          <div class="cell"><div class="lab">Low stock</div><div class="val">${inventorySummary.lowStock.length}</div></div>
          <div class="cell"><div class="lab">Expiry issues</div><div class="val">${inventorySummary.expired.length + inventorySummary.expiringSoon.length}</div></div>
        </div>
        ${inventory.length ? `<table class="tbl"><thead><tr><th>Item</th><th>Category</th><th class="num">Qty</th><th class="num">Value</th><th>Expiry</th></tr></thead><tbody>${inventory.slice(0, 30).map((item) => `<tr><td>${esc(item.name || "Unnamed")}</td><td>${esc(item.category || "—")}</td><td class="num">${item.quantity ?? 0} ${esc(item.unit || "")}</td><td class="num">${money((Number(item.quantity) || 0) * (Number(item.unitCost) || 0))}</td><td>${esc(fmtDate(item.expiryDate))}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No inventory items recorded.</p>`}
      </section>`;

    sHtml.observations = `
      <section data-report-section="observations">
        <h2>Field observations · ${esc(rangePretty)}</h2>
        ${rangeObservations.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Field</th><th>Type</th><th>Notes</th></tr></thead><tbody>${rangeObservations.slice().sort((a, b) => String(b.datetime || b.date || "").localeCompare(String(a.datetime || a.date || ""))).slice(0, 40).map((obs) => `<tr><td>${esc(fmtDate(obs.datetime || obs.date))}</td><td>${esc(mappedFields.find((f) => f.id === obs.fieldId)?.name || obs.fieldName || "—")}</td><td>${esc(obs.type || "general")}</td><td>${esc(obs.notes || obs.note || "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No observations recorded in this period.</p>`}
      </section>`;

    sHtml.livestock = `
      <section data-report-section="livestock">
        <h2>Livestock</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Active animals</div><div class="val">${livestockSummary.active}</div></div>
          <div class="cell"><div class="lab">Movements</div><div class="val">${livestockSummary.movements}</div></div>
          <div class="cell"><div class="lab">Medicines</div><div class="val">${livestockSummary.medicines}</div></div>
          <div class="cell"><div class="lab">Breeding</div><div class="val">${livestockSummary.breedingEvents}</div></div>
        </div>
        ${Object.keys(livestockSummary.bySpecies).length ? `<table class="tbl"><thead><tr><th>Species</th><th class="num">Animals</th></tr></thead><tbody>${Object.entries(livestockSummary.bySpecies).map(([species, count]) => `<tr><td>${esc(species)}</td><td class="num">${count}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No livestock records.</p>`}
      </section>`;

    sHtml.compliance = `
      <section data-report-section="compliance">
        <h2>Compliance & audit</h2>
        <div class="stats">
          <div class="cell"><div class="lab">Checklist items</div><div class="val">${complianceSummary.checklistItems}</div></div>
          <div class="cell"><div class="lab">Complete</div><div class="val">${complianceSummary.completed}</div></div>
          <div class="cell"><div class="lab">Gaps</div><div class="val">${complianceSummary.gaps.length}</div></div>
          <div class="cell"><div class="lab">Pre-harvest</div><div class="val">${complianceSummary.preharvestForms}</div></div>
        </div>
        ${complianceSummary.gaps.length ? `<table class="tbl"><thead><tr><th>Standard</th><th>Item</th><th>Status</th></tr></thead><tbody>${complianceSummary.gaps.slice(0, 20).map((gap) => `<tr><td>${esc(gap.standard)}</td><td>${esc(gap.item)}</td><td>${esc(typeof gap.value === "object" ? gap.value.status || "gap" : "gap")}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No compliance gaps flagged in stored checklists.</p>`}
      </section>`;

    // Time-series analysis
    sHtml.timeSeries = `
      <section data-report-section="timeSeries">
        <h2>Spectral time-series analysis · ${esc(rangePretty)}</h2>
        <p class="meta">Cloud-masked Sentinel-2 indices per field. NDVI remains the primary trend axis, with EVI, NDWI, NDMI, NDRE, SAVI and NBR adding canopy, moisture, chlorophyll and disturbance context. ${farmNdviSummary?.fieldsWithData ?? 0} of ${totals.fields} fields have data for this period.</p>
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
        ${fieldAnalyses.some((f) => f.analysis?.spectral && SPECTRAL_INDEX_LIST.some((idx) => f.analysis.spectral[idx.id]?.mean != null)) ? `
        <h3>Supplementary indices (period means / change)</h3>
        <table class="tbl">
          <thead><tr><th>Field</th>${SPECTRAL_INDEX_LIST.map((idx) => `<th class="num">${idx.label}</th>`).join("")}</tr></thead>
          <tbody>
            ${fieldAnalyses.filter((f) => f.analysis).map((f) => `
              <tr>
                <td>${esc(f.name)}</td>
                ${SPECTRAL_INDEX_LIST.map((idx) => {
                  const s = f.analysis.spectral?.[idx.id];
                  const mean = s?.mean;
                  const change = s?.change;
                  return `<td class="num">${mean ?? "—"}<br><span class="meta">${change != null ? `${change > 0 ? "+" : ""}${change}` : ""}</span></td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>` : ""}
      </section>`;

    // Recommendations
    sHtml.recommendations = `
      <section data-report-section="recommendations">
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
      <section data-report-section="popComparison">
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
      <section data-report-section="rankings">
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
      <section data-report-section="operations">
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
      <section data-report-section="fields">
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
      <section data-report-section="schemes">
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
      <section data-report-section="elevation">
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
  }, [sections, cadence, range, farm, mappedFields, areas, rangeRecords, rangeTasks, rangeFinances, rangeObservations, rangeMarketSales, rangeMarketPurchases, rangeLivestockMovements, rangeLivestockMedicines, rangeLivestockBreeding, yieldStore, assignments, attrs, totals, healthSummary, elevData, schemeResults, year, farmHealth, fieldAnalyses, rankings, recommendations, farmNdviSummary, financeSummary, weatherSummary, marketSummary, marketWatchlist, inventory, inventorySummary, livestockSummary, complianceSummary]);

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

  const loadInterpretiveReports = useCallback(async () => {
    if (!farmId || !tilthApiConfigured() || !supabase) return;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return;
      const response = await fetchTilthApi(`/api/platform-assistant/reports/interpretive?farmId=${encodeURIComponent(farmId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not load interpretive reports.");
      setInterpretiveReports(payload.reports || []);
      setInterpretiveError("");
    } catch (err) {
      setInterpretiveError(err?.message || "Could not load interpretive reports.");
    }
  }, [farmId]);

  useEffect(() => {
    loadInterpretiveReports();
  }, [loadInterpretiveReports]);

  useEffect(() => {
    if (!interpretiveReports.some((report) => report.metadata?.status === "processing")) return undefined;
    const id = window.setInterval(loadInterpretiveReports, 4000);
    return () => window.clearInterval(id);
  }, [interpretiveReports, loadInterpretiveReports]);

  const openPreview = () => {
    const h = buildHtml();
    openReportWindow(h, `${farm?.name || "Farm"} ${CADENCE[cadence].label} report`);
  };

  const openInterpretiveReport = (report) => {
    if (!report?.content || report.metadata?.status !== "completed") return;
    openReportWindow(report.content, report.title || "Interpretive report");
  };

  const startInterpretiveReport = async () => {
    if (!farmId || !anySelected || !totals.fields || interpretiveBusy) return;
    setInterpretiveBusy(true);
    setInterpretiveError("");
    try {
      if (!tilthApiConfigured() || !supabase) throw new Error("Tilth reporting service is not available right now.");
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("You need to be signed in.");
      const selectedSections = buildReportSections();
      const cadenceLabel = CADENCE[cadence].label;
      const rangeLabel = prettyRange(range.start, range.end);
      const factualHtml = buildHtml();
      const response = await fetchTilthApi("/api/platform-assistant/reports/interpretive/start", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          farmId,
          farmName: farm?.name || "Unnamed farm",
          cadence,
          range: { start: isoDay(range.start), end: isoDay(range.end), label: rangeLabel },
          title: `${cadenceLabel} AI interpretive report · ${rangeLabel}`,
          prompt: `Generate an AI interpretive ${cadenceLabel.toLowerCase()} farm report with executive summary and per-section interpretation.`,
          sections: selectedSections,
          evidence: {
            farm: { id: farmId, name: farm?.name || "Unnamed farm" },
            cadence,
            range: { start: isoDay(range.start), end: isoDay(range.end), label: rangeLabel },
            sections: Object.fromEntries(selectedSections.map((section) => [section.key, section.evidence])),
          },
          factualHtml,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || `Could not start interpretive report (${response.status}).`);
      setInterpretiveReports((prev) => [payload.report, ...prev.filter((report) => report.id !== payload.report?.id)].filter(Boolean));
      window.setTimeout(loadInterpretiveReports, 1500);
    } catch (err) {
      setInterpretiveError(err?.message || "Could not start interpretive report.");
    } finally {
      setInterpretiveBusy(false);
    }
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
  const currentRangeKey = `${isoDay(range.start)}:${isoDay(range.end)}`;
  const processingCurrentInterpretive = interpretiveReports.some((report) => {
    const meta = report.metadata || {};
    const reportRangeKey = `${meta.range?.start || ""}:${meta.range?.end || ""}`;
    return meta.status === "processing" && meta.cadence === cadence && reportRangeKey === currentRangeKey;
  });

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Reporting"
          title="Farm reports"
          description="Stakeholder-ready factual and AI-interpretive farm snapshots covering operations, weather, markets, finance, stock, compliance, livestock and field performance."
          actions={<>
            {reportMode === "interpretive" ? (
              <Button variant="primary" size="sm" onClick={startInterpretiveReport} disabled={!anySelected || !totals.fields || interpretiveBusy || processingCurrentInterpretive}>
                {interpretiveBusy || processingCurrentInterpretive ? "Processing..." : "Generate AI report"}
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={openPreview} disabled={!anySelected || !totals.fields}>Preview</Button>
                <Button variant="primary" size="sm" onClick={downloadPdf} disabled={!anySelected || !totals.fields}>Download PDF</Button>
              </>
            )}
          </>}
        />
      }
    >
      <div className="tilth-rep-layout" style={{ flex: "1 1 auto", minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 12, overflow: "hidden" }}>
        {/* Left */}
        <div className="tilth-rep-main tilth-scroll" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
          <Card padding={14}>
            <Kicker style={{ marginBottom: 8 }}>Report cadence</Kicker>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(CADENCE).map(([id, c]) => <CadenceTab key={id} label={c.label} active={cadence === id} onClick={() => setCadence(id)} />)}
            </div>
            <div style={{ marginTop: 8, fontFamily: fonts.sans, fontSize: 12, color: brand.muted }}>
              Covering: <strong style={{ color: brand.forest }}>{prettyRange(range.start, range.end)}</strong> ({CADENCE[cadence].days} days)
            </div>
          </Card>

          <Card padding={14}>
            <Kicker style={{ marginBottom: 8 }}>Report type</Kicker>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <SectionToggle label="Factual report" on={reportMode === "factual"} onToggle={() => setReportMode("factual")} />
              <SectionToggle label="AI interpretive report" on={reportMode === "interpretive"} onToggle={() => setReportMode("interpretive")} />
            </div>
            <Body size="sm" style={{ marginTop: 8, color: brand.muted }}>
              Factual reports open instantly. AI interpretive reports queue in the background and add an executive summary plus interpretation below each selected section.
            </Body>
            {interpretiveError ? <Body size="sm" style={{ marginTop: 8, color: brand.danger }}>{interpretiveError}</Body> : null}
          </Card>

          <Card padding={14} tone="section">
            <Kicker style={{ marginBottom: 6 }}>Farm snapshot</Kicker>
            <Headline size="sm">{farm?.name || "Unnamed farm"}</Headline>
            <Body size="sm" style={{ marginTop: 6 }}>{prettyRange(range.start, range.end)}</Body>
            <Divider style={{ margin: "12px 0" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              <MiniKv label="Fields" value={totals.fields} />
              <MiniKv label="Net" value={money(totals.netMargin)} />
              <MiniKv label="Records" value={totals.records} />
              <MiniKv label="Tasks" value={rangeTasks.length} />
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
              <Pill tone={rangeFinances.length ? "ok" : "neutral"}>{rangeFinances.length} finance</Pill>
              <Pill tone={weatherSummary ? "ok" : "neutral"}>weather {weatherSummary ? "ready" : "loading"}</Pill>
              <Pill tone={inventory.length ? "ok" : "neutral"}>{inventory.length} store items</Pill>
              <Pill tone={rangeObservations.length ? "ok" : "neutral"}>{rangeObservations.length} observations</Pill>
              <Pill tone={totals.livestock ? "ok" : "neutral"}>{totals.livestock || 0} livestock</Pill>
              <Pill tone={totals.totalEligible ? "ok" : "neutral"}>{totals.totalEligible} eligible schemes</Pill>
            </div>
          </Card>
        </div>

        {/* Right sidebar */}
        <div className="tilth-rep-sidebar tilth-scroll" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
          <Card padding={12}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <Kicker>Library</Kicker>
              <Pill tone="neutral">{library.length + interpretiveReports.length}</Pill>
            </div>
            {interpretiveReports.length ? (
              <div style={{ display: "grid", gap: 4, marginBottom: library.length ? 10 : 0 }}>
                {interpretiveReports.map((r) => {
                  const status = r.metadata?.status || "processing";
                  return (
                    <div key={r.id} style={{ padding: "8px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, display: "grid", gap: 7 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: brand.forest, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginTop: 2 }}>{fmtDate(r.created_at)} · AI interpretive · {r.metadata?.cadence || "—"}</div>
                        </div>
                        <Pill tone={status === "completed" ? "ok" : status === "failed" ? "danger" : "warn"}>{status === "completed" ? "Ready" : status}</Pill>
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => openInterpretiveReport(r)} disabled={status !== "completed"} style={{ minHeight: 30 }}>
                        {status === "completed" ? "Open" : "Processing..."}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}
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
            ) : interpretiveReports.length ? null : <Body size="sm">Download a factual report or generate an AI interpretive report to start your library.</Body>}
          </Card>

          <Card padding={12}>
            <Kicker style={{ marginBottom: 6 }}>What's in each cadence</Kicker>
            <div style={{ display: "grid", gap: 6 }}>
              <CadenceInfo label="Weekly" items={["Operations snapshot", "Weather and workability", "Finance, store and observations", "Field/satellite alerts", "Actionable recommendations"]} />
              <CadenceInfo label="Monthly" items={["Everything in weekly", "Markets, livestock and compliance", "Field registry with health", "Scheme eligibility", "Period-over-period Δ"]} />
              <CadenceInfo label="Quarterly" items={["Everything in monthly", "Yield and topography", "Strategic business view", "Stakeholder performance narrative"]} />
            </div>
          </Card>

          <Card padding={12} tone="section">
            <Kicker style={{ marginBottom: 6 }}>About</Kicker>
            <Body size="sm" style={{ lineHeight: 1.55 }}>
              Reports can be scoped from a whole-farm stakeholder snapshot down to selected
              sections. AI interpretive reports consolidate operations, business, compliance,
              weather and field evidence into a management narrative. Use "Print → Save as PDF"
              for a portable copy.
            </Body>
          </Card>
        </div>
      </div>

      <style>{`
        @media (max-width: 1250px) { .tilth-rep-layout { grid-template-columns: 1fr !important; } }
        @media (max-width: 760px) {
          .tilth-rep-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
          }
          .tilth-rep-main,
          .tilth-rep-sidebar,
          .tilth-rep-main.tilth-scroll,
          .tilth-rep-sidebar.tilth-scroll {
            min-height: auto !important;
            overflow: visible !important;
            padding-right: 0 !important;
          }
        }
      `}</style>
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

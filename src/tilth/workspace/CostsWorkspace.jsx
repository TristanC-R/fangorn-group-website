import { useMemo, useState } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Card,
  Kicker,
  SectionHeader,
  Stat,
  WorkspaceFrame,
  EmptyState,
} from "../ui/primitives.jsx";
import { tilthStore } from "../state/localStore.js";
import { useFarmHealth } from "../../lib/cropHealth.js";
import { ringAreaSqDeg } from "../geoPointInPolygon.js";
import {
  computeFarmMargins,
  marginCorrelation,
  rankFieldsByProfitability,
} from "../../lib/costAnalysis.js";

function approxHectares(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(ring));
  const midLat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
  return Math.max(0, (sqDeg * 111_132 * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 10_000);
}

const fmt = (v) => (v == null || !Number.isFinite(v)) ? "—" : `£${v.toFixed(0)}`;
const fmtHa = (v) => (v == null || !Number.isFinite(v)) ? "—" : `£${v.toFixed(0)}/ha`;

export function CostsWorkspace({ farm, fields }) {
  const farmId = farm?.id;
  const year = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(year);

  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const yieldStore = useMemo(() => tilthStore.loadYield(farmId), [farmId]);
  const plantings = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);
  const { health } = useFarmHealth(fields, plantings);

  const margins = useMemo(() => {
    if (!fields?.length) return null;
    try {
      return computeFarmMargins(
        fields.map((f) => ({ ...f, areaHa: approxHectares(f.boundary || []) })),
        records, yieldStore, plantings, attrs, null, selectedYear,
      );
    } catch { return null; }
  }, [fields, records, yieldStore, plantings, attrs, selectedYear]);

  const correlation = useMemo(() => {
    if (!margins?.fieldMargins) return null;
    try { return marginCorrelation(margins.fieldMargins, health, records, null, selectedYear); } catch { return null; }
  }, [margins, health, records, selectedYear]);

  const rankings = useMemo(() => {
    if (!margins?.fieldMargins) return [];
    try { return rankFieldsByProfitability(margins.fieldMargins); } catch { return []; }
  }, [margins]);

  if (!fields?.length) {
    return (
      <WorkspaceFrame header={<SectionHeader kicker="Finance" title="Costs & margin" description="Add fields and yield data to see financial analysis." />}>
        <EmptyState title="No fields" message="Map fields and log yield data to unlock cost analysis." />
      </WorkspaceFrame>
    );
  }

  const agg = margins ? {
    totalRevenue: margins.totalRevenue,
    totalCost: margins.totalCost,
    totalMargin: margins.totalMargin,
    avgMarginPerHa: margins.averageMarginPerHa,
    bestField: margins.bestField ? { name: margins.bestField.fieldName, marginPerHa: margins.bestField.grossMarginPerHa } : null,
  } : null;

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Finance"
          title="Costs & margin"
          description="Gross margin analysis per field — revenue minus variable costs."
          actions={
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              style={{ fontFamily: fonts.mono, fontSize: 11, padding: "6px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white }}
            >
              {[year - 2, year - 1, year].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          }
        />
      }
    >
      <div className="tilth-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 4px 4px" }}>
        {/* Farm aggregates */}
        {agg ? (
          <div className="tilth-costs-stats" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
            <Stat kicker="Revenue" value={fmt(agg.totalRevenue)} sub="total" tone="forest" />
            <Stat kicker="Costs" value={fmt(agg.totalCost)} sub="variable" />
            <Stat kicker="Margin" value={fmt(agg.totalMargin)} sub="gross" tone={agg.totalMargin >= 0 ? "ok" : "danger"} />
            <Stat kicker="Avg margin/ha" value={fmtHa(agg.avgMarginPerHa)} sub="" />
            <Stat kicker="Best field" value={agg.bestField?.name || "—"} sub={agg.bestField?.marginPerHa != null ? fmtHa(agg.bestField.marginPerHa) : ""} />
          </div>
        ) : (
          <div className="tilth-costs-stats" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
            <Stat kicker="Revenue" value="—" sub="No yield data" />
            <Stat kicker="Costs" value="—" sub="" />
            <Stat kicker="Margin" value="—" sub="" />
            <Stat kicker="Avg margin/ha" value="—" sub="" />
            <Stat kicker="Best field" value="—" sub="" />
          </div>
        )}

        {/* Per-field table */}
        <Card padding={14} style={{ marginBottom: 14 }}>
          <Kicker style={{ marginBottom: 10 }}>Field margins — {selectedYear}</Kicker>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${brand.border}` }}>
                  {["Rank", "Field", "Crop", "Yield (t/ha)", "Revenue", "Costs", "Margin", "Margin/ha", "ROI"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankings.map((r, i) => {
                  const fm = margins?.fieldMargins?.find((m) => m.fieldId === r.fieldId);
                  return (
                    <tr key={r.fieldId || i} style={{ borderBottom: `1px solid ${brand.border}` }}>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontWeight: 600, color: brand.muted }}>{r.rank || i + 1}</td>
                      <td style={{ padding: "6px 8px", fontWeight: 500, color: brand.forest }}>{r.fieldName || "—"}</td>
                      <td style={{ padding: "6px 8px", color: brand.bodySoft }}>{fm?.cropName || "—"}</td>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{fm?.yieldTHa != null ? fm.yieldTHa.toFixed(1) : "—"}</td>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{fmt(fm?.revenue)}</td>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{fmt(fm?.variableCosts)}</td>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, color: (fm?.grossMargin ?? 0) >= 0 ? brand.ok : brand.danger }}>{fmt(fm?.grossMargin)}</td>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{fmtHa(r.marginPerHa)}</td>
                      <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{fm?.roi != null ? `${(fm.roi * 100).toFixed(0)}%` : "—"}</td>
                    </tr>
                  );
                })}
                {rankings.length === 0 && (
                  <tr><td colSpan="9" style={{ padding: "16px 8px", textAlign: "center", color: brand.muted, fontFamily: fonts.sans, fontSize: 12 }}>Log yield data to see margin analysis.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Correlation insights */}
        {correlation && (
          <Card padding={14}>
            <Kicker style={{ marginBottom: 10 }}>Correlation insights</Kicker>
            <div style={{ display: "grid", gap: 8 }}>
              {[
                { label: "Margin vs health score", data: correlation.marginVsScore },
                { label: "Margin vs N rate", data: correlation.marginVsN },
                { label: "Margin vs spray count", data: correlation.marginVsSprays },
              ].map((c) => c.data ? (
                <div key={c.label} style={{ padding: "8px 10px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.bgSection }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>{c.label}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>r = {c.data.r?.toFixed(2)}</span>
                  </div>
                  <Body size="sm" style={{ color: brand.bodySoft }}>{c.data.insight || "Insufficient data for correlation."}</Body>
                </div>
              ) : null)}
            </div>
          </Card>
        )}
        <style>{`
          @media (max-width: 900px) {
            .tilth-costs-stats {
              grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            }
          }
          @media (max-width: 430px) {
            .tilth-costs-stats {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </div>
    </WorkspaceFrame>
  );
}

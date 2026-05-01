import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ringAreaSqDeg } from "../geoPointInPolygon.js";
import { tilthStore } from "../state/localStore.js";
import { useFieldElevation } from "../../lib/tilthElevation.js";
import {
  SCHEME_CATALOGUE,
  THEMES,
  SFI26_AGREEMENT_CAP,
} from "../../lib/schemeCatalogue.js";
import {
  evaluateField,
  farmSummary,
  confidenceTier,
  eligibleCount,
  maybeCount,
} from "../../lib/schemeEligibility.js";

function approxHectares(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(boundary));
  const midLat = boundary.reduce((a, p) => a + p.lat, 0) / boundary.length;
  const metersPerDegLat = 111_132;
  const metersPerDegLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(0, (sqDeg * metersPerDegLat * metersPerDegLng) / 10_000);
}

function download(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// ─────────────────────────────────────────────────────────────────────

export function SubmissionsWorkspace({ farm, fields }) {
  const farmId = farm?.id || null;

  // Assignments: Map<fieldId, Set<actionCode>> stored as { fieldId: { codes: [...] } }
  const [assigned, setAssigned] = useState(() => {
    const raw = tilthStore.loadAssignments(farmId);
    return deserializeAssignments(raw);
  });
  useEffect(() => {
    setAssigned(deserializeAssignments(tilthStore.loadAssignments(farmId)));
  }, [farmId]);

  const persist = useCallback((next) => {
    setAssigned(next);
    tilthStore.saveAssignments(farmId, serializeAssignments(next));
  }, [farmId]);

  const [expandedField, setExpandedField] = useState(null);
  const [schemeFilter, setSchemeFilter] = useState("all");
  const [themeFilter, setThemeFilter] = useState("all");

  const withRings = useMemo(
    () => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3),
    [fields],
  );

  const areas = useMemo(() => {
    const m = {};
    for (const f of withRings) m[f.id] = approxHectares(f.boundary);
    return m;
  }, [withRings]);

  const totalFarmHa = useMemo(
    () => Object.values(areas).reduce((a, v) => a + v, 0),
    [areas],
  );

  // Elevation data
  const fieldIds = useMemo(() => withRings.map((f) => f.id), [withRings]);
  const { data: elevData } = useFieldElevation(fieldIds);

  // Field attributes (soil, crop, landUse) from localStore
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);
  const plantingsMap = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);

  // Build per-field data and run the engine
  const fieldResults = useMemo(() => {
    const farmData = { totalHa: totalFarmHa, fieldCount: withRings.length };

    return withRings.map((f) => {
      const fa = attrs[f.id] || {};
      const elev = elevData.get(f.id);
      const planting = plantingsMap[f.id]?.[0] || null;
      const fieldData = {
        landUse: fa.landUse || "arable",
        soil: fa.soil || null,
        crop: fa.crop || null,
        areaHa: areas[f.id] || null,
        elevation: elev?.status === "ok" ? {
          mean: elev.elevation_mean,
          min: elev.elevation_min,
          max: elev.elevation_max,
          slope_mean_deg: elev.slope_mean_deg,
          slope_max_deg: elev.slope_max_deg,
          twi_mean: elev.twi_mean,
          aspect_dominant: elev.aspect_dominant,
        } : null,
        ndviMean: null,
        isOrganic: fa.organic === true,
        currentPlanting: planting,
      };
      const results = evaluateField(fieldData, farmData);
      return { fieldId: f.id, fieldName: f.name, areaHa: areas[f.id], landUse: fieldData.landUse, results };
    });
  }, [withRings, attrs, elevData, areas, totalFarmHa, plantingsMap]);

  // Farm-level summary
  const summary = useMemo(
    () => farmSummary(fieldResults, assigned),
    [fieldResults, assigned],
  );

  const toggleAction = useCallback((fieldId, code) => {
    setAssigned((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(fieldId) || []);
      if (set.has(code)) set.delete(code);
      else set.add(code);
      if (set.size) next.set(fieldId, set);
      else next.delete(fieldId);
      const serialized = serializeAssignments(next);
      tilthStore.saveAssignments(farmId, serialized);
      return next;
    });
  }, [farmId]);

  const clearAll = () => {
    if (!window.confirm("Clear all scheme assignments?")) return;
    persist(new Map());
  };

  const exportJson = () => {
    const payload = {
      farm: { id: farm?.id, name: farm?.name },
      generated_at: new Date().toISOString(),
      parcels: fieldResults.map((fr) => {
        const codes = [...(assigned.get(fr.fieldId) || [])];
        return {
          field_id: fr.fieldId,
          name: fr.fieldName,
          area_ha: fr.areaHa ? Number(fr.areaHa.toFixed(2)) : 0,
          assigned_actions: codes,
          eligible_count: eligibleCount(fr.results),
        };
      }),
      totals: {
        parcels: fieldResults.length,
        assigned_actions: summary.totalAssigned,
        estimated_annual: summary.totalEstimated,
      },
      warnings: summary.warnings,
    };
    download(
      `tilth-schemes-${farmId || "farm"}-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json",
      JSON.stringify(payload, null, 2),
    );
  };

  // Filtered catalogue for the expanded field
  const filteredResults = useMemo(() => {
    if (!expandedField) return [];
    const fr = fieldResults.find((r) => r.fieldId === expandedField);
    if (!fr) return [];
    return fr.results.filter((r) => {
      if (schemeFilter !== "all" && r.action.scheme !== schemeFilter) return false;
      if (themeFilter !== "all" && r.action.theme !== themeFilter) return false;
      return true;
    });
  }, [expandedField, fieldResults, schemeFilter, themeFilter]);

  const schemes = useMemo(() => [...new Set(SCHEME_CATALOGUE.map((a) => a.scheme))], []);

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Funding & schemes"
          title="Scheme eligibility"
          description="Auto-assessed eligibility for SFI26, Countryside Stewardship and other environmental schemes based on your field data."
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={clearAll} disabled={!summary.totalAssigned}>Clear</Button>
              <Button variant="primary" size="sm" onClick={exportJson} disabled={!withRings.length}>Export</Button>
            </>
          }
        />
      }
    >
      {withRings.length ? (
        <div className="tilth-scheme-layout tilth-scroll" style={{ flex: "1 1 auto", minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 12, overflow: "hidden" }}>
          {/* Left: field list + expanded detail */}
          <div className="tilth-scheme-main" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
            {!expandedField ? (
              <Card padding={12} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                  <Kicker>Fields</Kicker>
                  <Pill tone="neutral">{withRings.length} parcels</Pill>
                </div>
                <div className="tilth-scroll" style={{ display: "grid", gap: 4, overflowY: "auto", minHeight: 0, paddingRight: 2 }}>
                  {fieldResults.map((fr) => {
                    const ec = eligibleCount(fr.results);
                    const mc = maybeCount(fr.results);
                    const ac = assigned.get(fr.fieldId)?.size || 0;
                    return (
                      <Row key={fr.fieldId} onClick={() => setExpandedField(fr.fieldId)} style={{ padding: "8px 10px", cursor: "pointer" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto auto", gap: 8, alignItems: "center" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>
                              {fr.fieldName || "Unnamed"}
                            </div>
                            <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                              {fr.areaHa ? `${fr.areaHa.toFixed(1)} ha` : "—"} · {fr.landUse}
                            </div>
                          </div>
                          <Pill tone="ok">{ec} eligible</Pill>
                          {mc > 0 && <Pill tone="warn">{mc} maybe</Pill>}
                          {ac > 0 && <Pill tone="forest">{ac} added</Pill>}
                        </div>
                      </Row>
                    );
                  })}
                </div>
              </Card>
            ) : (
              <ExpandedField
                fr={fieldResults.find((r) => r.fieldId === expandedField)}
                filteredResults={filteredResults}
                assigned={assigned.get(expandedField) || new Set()}
                onToggle={(code) => toggleAction(expandedField, code)}
                onBack={() => setExpandedField(null)}
                schemeFilter={schemeFilter}
                setSchemeFilter={setSchemeFilter}
                themeFilter={themeFilter}
                setThemeFilter={setThemeFilter}
                schemes={schemes}
              />
            )}
          </div>

          {/* Right: summary sidebar */}
          <div className="tilth-scheme-sidebar tilth-scroll" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Stat kicker="Est. annual" value={`£${summary.totalEstimated.toLocaleString()}`} sub="If all assigned" tone="forest" />
              <Stat kicker="Assigned" value={summary.totalAssigned} sub={`across ${fieldResults.length} fields`} />
            </div>

            {summary.warnings.length > 0 && (
              <Card padding={10}>
                <Kicker style={{ marginBottom: 6, color: brand.orange }}>Warnings</Kicker>
                {summary.warnings.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 4 }}>
                    <span style={{ color: brand.orange, fontWeight: 700, flexShrink: 0 }}>!</span>
                    <Body size="sm">{w}</Body>
                  </div>
                ))}
              </Card>
            )}

            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>By scheme</Kicker>
              {Object.keys(summary.byScheme).length ? (
                <div style={{ display: "grid", gap: 4 }}>
                  {Object.entries(summary.byScheme).sort((a, b) => b[1] - a[1]).map(([s, pay]) => (
                    <SchemeRow key={s} label={s} value={`£${pay.toLocaleString()}`} />
                  ))}
                </div>
              ) : (
                <Body size="sm" color={brand.muted}>No actions assigned yet.</Body>
              )}
            </Card>

            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>By theme</Kicker>
              {Object.keys(summary.byTheme).length ? (
                <div style={{ display: "grid", gap: 4 }}>
                  {Object.entries(summary.byTheme).sort((a, b) => b[1] - a[1]).map(([t, pay]) => (
                    <SchemeRow key={t} label={t} value={`£${pay.toLocaleString()}`} />
                  ))}
                </div>
              ) : (
                <Body size="sm" color={brand.muted}>Assign actions to see breakdown.</Body>
              )}
            </Card>

            <Card padding={12}>
              <Kicker style={{ marginBottom: 6 }}>SFI26 limits</Kicker>
              <div style={{ display: "grid", gap: 4 }}>
                <LimitRow label="Agreement cap" value={`£${summary.totalEstimated.toLocaleString()} / £${SFI26_AGREEMENT_CAP.toLocaleString()}`} ok={summary.totalEstimated <= SFI26_AGREEMENT_CAP} />
                <LimitRow label="25% area cap" value={`${summary.areaCappedHa.toFixed(1)} ha / ${(totalFarmHa * 0.25).toFixed(1)} ha`} ok={summary.areaCappedHa <= totalFarmHa * 0.25} />
                <LimitRow label="Min farm size" value={`${totalFarmHa.toFixed(1)} ha (≥ 3 ha)`} ok={totalFarmHa >= 3} />
              </div>
            </Card>

            <Card padding={12} tone="section">
              <Kicker style={{ marginBottom: 6 }}>Data sources</Kicker>
              <Body size="sm" style={{ lineHeight: 1.55 }}>
                Eligibility is assessed from land use, soil type (WMS), crop type (CROME), elevation (Copernicus DEM 30 m), and field area.
                Before applying, confirm action rules, payment rates, land cover and evidence requirements against official guidance.
              </Body>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                <Button
                  as="a"
                  href="https://www.gov.uk/government/collections/sustainable-farming-incentive-guidance"
                  target="_blank"
                  rel="noreferrer"
                  variant="secondary"
                  size="sm"
                >
                  SFI guidance
                </Button>
                <Button
                  as="a"
                  href="https://www.gov.uk/government/collections/countryside-stewardship-get-paid-for-environmental-land-management"
                  target="_blank"
                  rel="noreferrer"
                  variant="secondary"
                  size="sm"
                >
                  CS guidance
                </Button>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <Card padding={24}>
          <EmptyState
            kicker="No parcels"
            title="Map your fields first"
            description="Scheme eligibility reads from field boundaries and attributes. Map or import boundaries in Fields."
          />
        </Card>
      )}

      <style>{`
        @media (max-width: 1250px) {
          .tilth-scheme-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .tilth-scheme-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
            padding-bottom: 18px !important;
          }
          .tilth-scheme-main,
          .tilth-scheme-sidebar,
          .tilth-scheme-sidebar.tilth-scroll {
            min-height: auto !important;
            overflow: visible !important;
            padding-right: 0 !important;
          }
          .tilth-scheme-main > .tilth-mobile-card,
          .tilth-scheme-main > div,
          .tilth-scheme-main .tilth-scroll,
          .tilth-scheme-sidebar .tilth-scroll {
            min-height: auto !important;
            max-height: none !important;
            overflow: visible !important;
          }
          .tilth-scheme-main [style*="grid-template-columns: minmax(0, 1fr) auto auto auto"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

// ─── Expanded field detail ───────────────────────────────────────────

function ExpandedField({ fr, filteredResults, assigned, onToggle, onBack, schemeFilter, setSchemeFilter, themeFilter, setThemeFilter, schemes }) {
  if (!fr) return null;
  const eligCount = eligibleCount(fr.results);

  return (
    <Card padding={12} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button type="button" onClick={onBack} style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.forest, background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
          Back
        </button>
        <span style={{ fontWeight: 700, color: brand.forest, fontSize: 14 }}>{fr.fieldName || "Unnamed"}</span>
        <Pill tone="ok">{eligCount} eligible</Pill>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <FilterSelect label="Scheme" value={schemeFilter} onChange={setSchemeFilter} options={[{ id: "all", label: "All schemes" }, ...schemes.map((s) => ({ id: s, label: s }))]} />
        <FilterSelect label="Theme" value={themeFilter} onChange={setThemeFilter} options={[{ id: "all", label: "All themes" }, ...THEMES.map((t) => ({ id: t, label: t }))]} />
      </div>

      <div className="tilth-scroll" style={{ display: "grid", gap: 3, overflowY: "auto", minHeight: 0, paddingRight: 2 }}>
        {filteredResults.map((r) => (
          <ActionRow key={r.action.code} result={r} isAssigned={assigned.has(r.action.code)} onToggle={() => onToggle(r.action.code)} />
        ))}
        {filteredResults.length === 0 && (
          <Body size="sm" color={brand.muted} style={{ padding: 8 }}>No actions match this filter.</Body>
        )}
      </div>
    </Card>
  );
}

function ActionRow({ result, isAssigned, onToggle }) {
  const { action, eligible, confidence, reasons, estimatedPayment } = result;
  const tier = confidenceTier(confidence);
  const disabled = eligible === false;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto auto auto",
        gap: 8,
        alignItems: "center",
        padding: "6px 8px",
        borderRadius: radius.base,
        border: `1px solid ${isAssigned ? brand.forest : brand.border}`,
        background: disabled ? brand.bgSection : isAssigned ? "rgba(16,78,63,0.05)" : brand.white,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <button
        type="button"
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        style={{
          width: 20,
          height: 20,
          borderRadius: 3,
          border: `1.5px solid ${isAssigned ? brand.forest : brand.border}`,
          background: isAssigned ? brand.forest : brand.white,
          color: brand.white,
          cursor: disabled ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          fontWeight: 700,
          padding: 0,
          flexShrink: 0,
        }}
      >
        {isAssigned ? "✓" : ""}
      </button>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.forest, padding: "1px 5px", border: `1px solid ${brand.border}`, borderRadius: 2, background: brand.bgSection, flexShrink: 0 }}>
            {action.code}
          </span>
          <span style={{ fontSize: 11.5, color: brand.forest, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {action.name}
          </span>
        </div>
        {reasons.length > 0 && (
          <div style={{ fontSize: 10, color: brand.muted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {reasons[0]}
          </div>
        )}
      </div>

      <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.bodySoft, whiteSpace: "nowrap" }}>
        {action.payment}
      </span>

      {estimatedPayment > 0 && (
        <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.forest, fontWeight: 600, whiteSpace: "nowrap" }}>
          ~£{estimatedPayment.toLocaleString()}
        </span>
      )}

      {eligible !== false ? (
        <Pill tone={tier.tone}>{tier.label}</Pill>
      ) : (
        <Pill tone="neutral">Ineligible</Pill>
      )}
    </div>
  );
}

// ─── Helper components ───────────────────────────────────────────────

function FilterSelect({ label, value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      style={{
        fontFamily: fonts.sans,
        fontSize: 11,
        padding: "4px 8px",
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        background: brand.white,
        color: brand.forest,
      }}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}

function SchemeRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "5px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.bgSection }}>
      <span style={{ fontSize: 11, color: brand.forest }}>{label}</span>
      <span style={{ fontFamily: fonts.mono, fontSize: 11, color: brand.forest, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function LimitRow({ label, value, ok }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "5px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base }}>
      <span style={{ fontSize: 11, color: brand.forest }}>{label}</span>
      <span style={{ fontFamily: fonts.mono, fontSize: 11, color: ok ? brand.moss : brand.orange, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ─── Serialisation ───────────────────────────────────────────────────

function serializeAssignments(map) {
  const out = {};
  for (const [fieldId, set] of map) {
    if (set.size) out[fieldId] = { codes: [...set] };
  }
  return out;
}

function deserializeAssignments(raw) {
  const m = new Map();
  if (!raw || typeof raw !== "object") return m;
  for (const [fieldId, val] of Object.entries(raw)) {
    if (Array.isArray(val?.codes) && val.codes.length) {
      m.set(fieldId, new Set(val.codes));
    } else if (typeof val?.code === "string" && val.code !== "—") {
      m.set(fieldId, new Set([val.code]));
    }
  }
  return m;
}

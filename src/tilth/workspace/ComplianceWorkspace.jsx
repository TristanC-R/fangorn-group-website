import { useMemo, useState, useCallback } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  Kicker,
  Pill,
  SectionHeader,
  Stat,
  WorkspaceFrame,
  EmptyState,
} from "../ui/primitives.jsx";
import { tilthStore, useLocalValue } from "../state/localStore.js";
import { generateCompliancePack, downloadAllFiles } from "../../lib/compliancePack.js";
import { DEFRA_DATA_LINKS, rpaDatasetLinks } from "../../lib/officialFarmData.js";

const PRODUCT_CATALOGUE = [
  { id: "nitram", name: "Nitram 34.5%", category: "fertiliser", nFraction: 0.345, unit: "kg/ha" },
  { id: "urea-46", name: "Urea 46%", category: "fertiliser", nFraction: 0.46, unit: "kg/ha" },
  { id: "triple-super", name: "Triple Superphosphate", category: "fertiliser", nFraction: 0, unit: "kg/ha" },
  { id: "muriate-potash", name: "Muriate of Potash", category: "fertiliser", nFraction: 0, unit: "kg/ha" },
  { id: "roundup-flex", name: "Roundup Flex", category: "herbicide", nFraction: 0, unit: "L/ha" },
  { id: "atlantis-od", name: "Atlantis OD", category: "herbicide", nFraction: 0, unit: "L/ha" },
  { id: "proline-275", name: "Proline 275", category: "fungicide", nFraction: 0, unit: "L/ha" },
  { id: "revystar-xpro", name: "Revystar XPro", category: "fungicide", nFraction: 0, unit: "L/ha" },
  { id: "ascra-xpro", name: "Ascra Xpro", category: "fungicide", nFraction: 0, unit: "L/ha" },
  { id: "decis-forte", name: "Decis Forte", category: "insecticide", nFraction: 0, unit: "L/ha" },
  { id: "hallmark-zeon", name: "Hallmark Zeon", category: "insecticide", nFraction: 0, unit: "L/ha" },
  { id: "moddus", name: "Moddus", category: "pgr", nFraction: 0, unit: "L/ha" },
];

export function ComplianceWorkspace({ farm, fields }) {
  const farmId = farm?.id;
  const year = new Date().getFullYear();
  const [generating, setGenerating] = useState(false);
  const [lastGenerated, setLastGenerated] = useState(null);
  const [officialSettings, setOfficialSettings] = useLocalValue("official_data_settings", farmId, { sbi: "" });

  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);
  const plantings = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);
  const assignments = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(`tilth:assignments:${farmId}`) || "{}"); } catch { return {}; }
  }, [farmId]);

  const rpaLinks = useMemo(() => rpaDatasetLinks(officialSettings.sbi), [officialSettings.sbi]);

  // NVZ summary
  const nvzSummary = useMemo(() => {
    const byField = {};
    for (const r of records) {
      if (!r.date || !new Date(r.date).getFullYear || new Date(r.date).getFullYear() !== year) continue;
      const prod = PRODUCT_CATALOGUE.find((p) => p.id === r.productId);
      if (!prod || !prod.nFraction) continue;
      const n = (r.rate || 0) * prod.nFraction;
      byField[r.fieldId] = (byField[r.fieldId] || 0) + n;
    }
    let compliant = 0, over = 0;
    const details = [];
    for (const f of fields || []) {
      const applied = byField[f.id] || 0;
      const landUse = attrs[f.id]?.landUse || "arable";
      const cap = landUse === "grass" ? 250 : 220;
      const ok = applied <= cap;
      if (ok) compliant++; else over++;
      details.push({ fieldId: f.id, name: f.name, applied, cap, headroom: cap - applied, ok });
    }
    return { compliant, over, details };
  }, [records, fields, attrs, year]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const pack = generateCompliancePack({
        records, fields, fieldAttrs: attrs, plantings, assignments,
        schemeResults: [], products: PRODUCT_CATALOGUE, year, farmName: farm?.name || "Farm",
      });
      downloadAllFiles(pack, farm?.name || "Farm", year);
      setLastGenerated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Compliance pack error:", err);
    } finally {
      setGenerating(false);
    }
  }, [records, fields, attrs, plantings, assignments, farm, year]);

  if (!fields?.length) {
    return (
      <WorkspaceFrame header={<SectionHeader kicker="Exports" title="Compliance" description="Add fields to generate compliance packs." />}>
        <EmptyState title="No fields" message="Map your fields first, then come back to generate NVZ reports and input diaries." />
      </WorkspaceFrame>
    );
  }

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Exports"
          title="Compliance pack"
          description={`Generate NVZ evidence, input diaries, and scheme claim packs for ${year}.`}
          actions={
            <Button variant="primary" size="sm" onClick={handleGenerate} disabled={generating}>
              {generating ? "Generating…" : "Download all"}
            </Button>
          }
        />
      }
    >
      <div className="tilth-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 4px 4px" }}>
        {/* Stats */}
        <div className="tilth-compliance-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat kicker="Records" value={records.length} sub={`${year}`} />
          <Stat kicker="NVZ compliant" value={nvzSummary.compliant} sub={`of ${fields.length}`} tone="ok" />
          <Stat kicker="Over N cap" value={nvzSummary.over} sub="fields" tone={nvzSummary.over > 0 ? "danger" : "ok"} />
          <Stat kicker="Last export" value={lastGenerated || "—"} sub="" />
        </div>

        <Card padding={14} style={{ marginBottom: 14 }}>
          <div className="tilth-compliance-rpa" style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 14, alignItems: "start" }}>
            <div>
              <Kicker style={{ marginBottom: 8 }}>RPA / Defra data</Kicker>
              <Body size="sm" style={{ color: brand.bodySoft, marginBottom: 10 }}>
                Enter the farm SBI to jump to official RPA land parcel, hedge and land-cover datasets.
              </Body>
              <input
                value={officialSettings.sbi || ""}
                onChange={(e) => setOfficialSettings((prev) => ({ ...prev, sbi: e.target.value }))}
                placeholder="Single Business Identifier"
                style={{ ...inputStyle, fontSize: 12.5 }}
              />
              <div style={{ marginTop: 8 }}>
                <Pill tone={rpaLinks.valid ? "ok" : "warn"} style={{ fontSize: 9 }}>
                  {rpaLinks.valid ? "SBI ready" : "Add SBI"}
                </Pill>
              </div>
            </div>
            <div className="tilth-compliance-link-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {[
                { label: "Land parcels", url: rpaLinks.landParcels, desc: "Registered field parcels" },
                { label: "Hedges", url: rpaLinks.hedges, desc: "SFI / CS hedge records" },
                { label: "Land covers", url: rpaLinks.landCovers, desc: "Official land-cover records" },
                { label: "RPA portal", url: rpaLinks.portal, desc: "Official RPA data entry point" },
              ].map((link) => (
                <a
                  key={link.label}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: "none", border: `1px solid ${brand.border}`, borderRadius: radius.base, padding: "9px 10px", background: brand.bgSection }}
                >
                  <div style={{ fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 700, color: brand.forest }}>{link.label}</div>
                  <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted, marginTop: 3 }}>{link.desc}</div>
                </a>
              ))}
            </div>
          </div>
          <div className="tilth-compliance-defra-links" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {DEFRA_DATA_LINKS.map((link) => (
              <a key={link.label} href={link.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <Pill tone="neutral" style={{ fontSize: 9 }}>{link.label}</Pill>
              </a>
            ))}
          </div>
        </Card>

        {/* NVZ table */}
        <Card padding={14} style={{ marginBottom: 14 }}>
          <Kicker style={{ marginBottom: 10 }}>NVZ N budget — {year}</Kicker>
          <div className="tilth-compliance-table" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${brand.border}` }}>
                  {["Field", "N applied (kg/ha)", "Cap", "Headroom", "Status"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {nvzSummary.details.map((d) => (
                  <tr key={d.fieldId} style={{ borderBottom: `1px solid ${brand.border}`, background: d.ok ? "transparent" : brand.dangerSoft }}>
                    <td style={{ padding: "6px 8px", fontWeight: 500, color: brand.forest }}>{d.name}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{d.applied.toFixed(1)}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{d.cap}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11, color: d.headroom < 0 ? brand.danger : brand.ok }}>{d.headroom.toFixed(1)}</td>
                    <td style={{ padding: "6px 8px" }}><Pill tone={d.ok ? "ok" : "danger"} style={{ fontSize: 9 }}>{d.ok ? "OK" : "Over"}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tilth-compliance-nvz-cards" style={{ display: "none" }}>
            {nvzSummary.details.map((d) => (
              <div key={d.fieldId} style={{ border: `1px solid ${d.ok ? brand.border : brand.danger}`, background: d.ok ? brand.white : brand.dangerSoft, borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 700, color: brand.forest }}>{d.name}</span>
                  <Pill tone={d.ok ? "ok" : "danger"} style={{ fontSize: 9 }}>{d.ok ? "OK" : "Over"}</Pill>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <MiniMetric label="N applied" value={d.applied.toFixed(1)} />
                  <MiniMetric label="Cap" value={d.cap} />
                  <MiniMetric label="Headroom" value={d.headroom.toFixed(1)} tone={d.headroom < 0 ? "danger" : "ok"} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Export cards */}
        <div className="tilth-compliance-export-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
          {[
            { label: "Input diary CSV", desc: "Every application record formatted for RPA submission.", file: "inputDiaryCsv" },
            { label: "NVZ evidence report", desc: "Per-field N budgets, closed period checks, and compliance summary.", file: "nvzReportHtml" },
            { label: "Scheme claim summary", desc: "SFI26 & CS assigned actions, payment estimates, and cap checks.", file: "schemeClaimHtml" },
            { label: "Field boundaries GeoJSON", desc: "All field polygons with area and attributes for upload.", file: "boundariesGeoJson" },
          ].map((item) => (
            <Card key={item.file} padding={14}>
              <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest, marginBottom: 4 }}>{item.label}</div>
              <Body size="sm" style={{ color: brand.bodySoft, marginBottom: 8 }}>{item.desc}</Body>
              <Button variant="secondary" size="sm" onClick={handleGenerate} disabled={generating}>
                Download
              </Button>
            </Card>
          ))}
        </div>

        <style>{`
          @media (max-width: 760px) {
            .tilth-compliance-stats {
              grid-template-columns: 1fr 1fr !important;
              gap: 8px !important;
            }
            .tilth-compliance-rpa,
            .tilth-compliance-link-grid,
            .tilth-compliance-export-grid {
              grid-template-columns: 1fr !important;
            }
            .tilth-compliance-link-grid a {
              min-height: 56px !important;
              border-radius: 8px !important;
            }
            .tilth-compliance-defra-links {
              overflow-x: auto !important;
              flex-wrap: nowrap !important;
              padding-bottom: 4px !important;
            }
            .tilth-compliance-defra-links a {
              flex: 0 0 auto !important;
            }
            .tilth-compliance-table {
              display: none !important;
            }
            .tilth-compliance-nvz-cards {
              display: grid !important;
              gap: 8px !important;
            }
            .tilth-compliance-export-grid button {
              width: 100% !important;
            }
          }
          @media (max-width: 430px) {
            .tilth-compliance-stats {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </div>
    </WorkspaceFrame>
  );
}

function MiniMetric({ label, value, tone }) {
  const color = tone === "danger" ? brand.danger : tone === "ok" ? brand.ok : brand.forest;
  return (
    <div style={{ border: `1px solid ${brand.border}`, background: brand.white, borderRadius: 8, padding: "7px 8px" }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>{label}</div>
      <div style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

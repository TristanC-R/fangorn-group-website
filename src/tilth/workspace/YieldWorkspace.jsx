import { useEffect, useMemo, useRef, useState } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
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
import { tilthStore } from "../state/localStore.js";

function yieldColor(t) {
  const stops = [
    { t: 0, c: [180, 65, 46] },
    { t: 0.5, c: [217, 129, 25] },
    { t: 1, c: [100, 154, 92] },
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * f);
  const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * f);
  const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parseYieldCsv(text) {
  // Accepts headers: field,yield,year  (case-insensitive; yield_t_ha / yield_tha also accepted)
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], error: "Empty file" };
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const fieldIdx = header.findIndex((h) => ["field", "field_name", "field_id", "name"].includes(h));
  const yieldIdx = header.findIndex((h) =>
    ["yield", "yield_t_ha", "yield_tha", "tonnes_per_ha", "t_ha"].includes(h)
  );
  const yearIdx = header.findIndex((h) => h === "year");
  if (fieldIdx < 0 || yieldIdx < 0) {
    return {
      rows: [],
      error: "Need at least a 'field' and 'yield' column (e.g. field,yield_t_ha,year).",
    };
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const fieldName = cols[fieldIdx];
    const y = parseFloat(cols[yieldIdx]);
    const year = yearIdx >= 0 ? parseInt(cols[yearIdx], 10) : new Date().getFullYear();
    if (!fieldName || !Number.isFinite(y)) continue;
    rows.push({ fieldName, yieldTHa: y, year });
  }
  return { rows, error: rows.length ? null : "No valid rows parsed." };
}

export function YieldWorkspace({ farm, fields }) {
  const farmId = farm?.id || null;

  const withRings = useMemo(
    () =>
      (fields || []).filter(
        (f) => Array.isArray(f.boundary) && f.boundary.length >= 3
      ),
    [fields]
  );
  const hasFields = withRings.length > 0;

  const [store, setStore] = useState(() => tilthStore.loadYield(farmId));
  useEffect(() => {
    setStore(tilthStore.loadYield(farmId));
  }, [farmId]);

  // Yield store shape: { [year]: { [fieldId]: yield_t_ha } }
  const years = Object.keys(store)
    .map((y) => parseInt(y, 10))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  const [year, setYear] = useState(() => years[0] || new Date().getFullYear());
  useEffect(() => {
    if (!years.length) {
      setYear(new Date().getFullYear());
    } else if (!years.includes(year)) {
      setYear(years[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(years)]);

  const saveStore = (next) => {
    setStore(next);
    tilthStore.saveYield(farmId, next);
  };

  const currentYearMap = useMemo(
    () => store[String(year)] || {},
    [store, year]
  );

  const choropleth = useMemo(() => {
    if (!hasFields || !Object.keys(currentYearMap).length) return {};
    const values = Object.values(currentYearMap).filter(Number.isFinite);
    if (!values.length) return {};
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const out = {};
    for (const f of withRings) {
      const v = currentYearMap[f.id];
      if (!Number.isFinite(v)) continue;
      const t = (v - min) / span;
      out[f.id] = { value: v.toFixed(1), color: yieldColor(t) };
    }
    return out;
  }, [withRings, currentYearMap, hasFields]);

  const averageYield = useMemo(() => {
    const vals = Object.values(currentYearMap).filter(Number.isFinite);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [currentYearMap]);

  const mapCenter = useMemo(() => {
    const first = withRings[0];
    if (!first) return { lat: 54, lng: -2, zoom: 6 };
    const c = ringCentroid(first.boundary);
    return { lat: c.lat, lng: c.lng, zoom: 14 };
  }, [withRings]);

  // Trend rows: each field, last 3 years where available
  const trendRows = useMemo(() => {
    const ys = [...years].sort((a, b) => a - b).slice(-3);
    return withRings.map((f) => {
      const vals = ys.map((y) => {
        const v = (store[String(y)] || {})[f.id];
        return Number.isFinite(v) ? v : null;
      });
      const latest = vals[vals.length - 1];
      const prev = vals[vals.length - 2];
      const delta = Number.isFinite(latest) && Number.isFinite(prev) ? latest - prev : null;
      return { id: f.id, name: f.name || "Unnamed", ys, vals, delta };
    });
  }, [withRings, store, years]);

  const fileRef = useRef(null);
  const [importError, setImportError] = useState(null);
  const [importSummary, setImportSummary] = useState(null);

  const onUpload = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    setImportError(null);
    setImportSummary(null);
    try {
      const text = await file.text();
      const { rows, error } = parseYieldCsv(text);
      if (error) {
        setImportError(error);
        return;
      }
      const nameLookup = new Map();
      for (const f of withRings) {
        nameLookup.set((f.name || "").toLowerCase(), f.id);
      }
      const next = { ...store };
      let matched = 0;
      let skipped = 0;
      for (const r of rows) {
        const fid = nameLookup.get(String(r.fieldName).toLowerCase());
        if (!fid) {
          skipped += 1;
          continue;
        }
        const y = String(r.year);
        next[y] = { ...(next[y] || {}), [fid]: r.yieldTHa };
        matched += 1;
      }
      if (!matched) {
        setImportError(
          `None of the ${rows.length} rows matched a mapped field name. Check the 'field' column matches the field name in Fields.`
        );
        return;
      }
      saveStore(next);
      setImportSummary(`Imported ${matched} rows${skipped ? ` · ${skipped} skipped` : ""}.`);
      if (rows[0]?.year) setYear(rows[0].year);
    } catch (e) {
      setImportError(e?.message || "Could not read file.");
    }
  };

  const clearAll = () => {
    if (!window.confirm("Clear all yield data for this farm?")) return;
    saveStore({});
  };

  const sampleCsv = () => {
    const names = withRings.slice(0, 6).map((f) => f.name || "Unnamed");
    const lines = ["field,yield_t_ha,year"];
    const thisYear = new Date().getFullYear();
    for (const n of names) {
      lines.push(`${n},${(7 + Math.random() * 4).toFixed(1)},${thisYear}`);
      lines.push(`${n},${(6.5 + Math.random() * 4).toFixed(1)},${thisYear - 1}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tilth-yield-sample.csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  };

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Harvest"
          title="Yield maps"
          description="Upload per-field yield data (CSV: field,yield_t_ha,year). We'll normalise, colour the parcels and compare across seasons."
          actions={
            <>
              {years.length ? (
                <select
                  value={year}
                  onChange={(e) => setYear(parseInt(e.target.value, 10))}
                  style={{ ...inputStyle, width: "auto", padding: "6px 10px", fontSize: 12.5 }}
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      Year {y}
                    </option>
                  ))}
                </select>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={onUpload}
                style={{ display: "none" }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={sampleCsv}
                disabled={!hasFields}
              >
                Sample CSV
              </Button>
              <Button variant="primary" size="sm" onClick={() => fileRef.current?.click()} disabled={!hasFields}>
                Upload CSV
              </Button>
              {years.length ? (
                <Button variant="ghost" size="sm" onClick={clearAll}>
                  Clear
                </Button>
              ) : null}
            </>
          }
        />
      }
    >
      {!hasFields ? (
        <Card padding={24}>
          <EmptyState
            kicker="Nothing to paint"
            title="Map fields first"
            description="Yield overlays paint onto your mapped boundaries. Head to Fields to map or import boundaries."
          />
        </Card>
      ) : (
        <div
          className="tilth-yield-layout"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 320px",
            gap: 12,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
            <div style={{ flex: "1 1 auto", minHeight: 0 }}>
              <FieldMapThree2D
                key={`yield-${mapCenter.lat}-${mapCenter.lng}`}
                center={[mapCenter.lat, mapCenter.lng]}
                zoom={mapCenter.zoom}
                savedFields={withRings}
                draftRing={[]}
                mapMode="pan"
                basemap="light"
                choropleth={choropleth}
                height="100%"
              />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "0 0 auto" }}>
              <LegendSwatch color={yieldColor(0)} label="Low" />
              <LegendSwatch color={yieldColor(0.5)} label="Mid" />
              <LegendSwatch color={yieldColor(1)} label="High" />
              {!Object.keys(currentYearMap).length ? (
                <Pill tone="neutral">Upload data for {year}</Pill>
              ) : (
                <Pill tone="ok">{Object.keys(currentYearMap).length} fields · {year}</Pill>
              )}
              {importError ? <Pill tone="danger">{importError}</Pill> : null}
              {importSummary ? <Pill tone="ok">{importSummary}</Pill> : null}
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Stat
                kicker="Avg yield"
                value={averageYield ? `${averageYield.toFixed(1)} t/ha` : "—"}
                sub={`Year ${year}`}
                tone="forest"
              />
              <Stat
                kicker="Fields"
                value={`${Object.keys(currentYearMap).length} / ${withRings.length}`}
                sub="With yield"
              />
            </div>

            <Card padding={12}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <Kicker>Per-field trend</Kicker>
                <Pill tone="neutral">t / ha</Pill>
              </div>
              <div style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }} className="tilth-scroll">
                {trendRows.map((row) => (
                  <Row key={row.id} style={{ padding: "7px 9px" }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1.4fr) repeat(3, 1fr) auto",
                        gap: 6,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          color: brand.forest,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 12.5,
                        }}
                      >
                        {row.name}
                      </div>
                      {row.vals.map((v, i) => (
                        <div
                          key={i}
                          style={{
                            fontFamily: fonts.mono,
                            fontSize: 10.5,
                            color: i === row.vals.length - 1 ? brand.forest : brand.bodySoft,
                            fontWeight: i === row.vals.length - 1 ? 600 : 400,
                          }}
                        >
                          {Number.isFinite(v) ? v.toFixed(1) : "—"}
                        </div>
                      ))}
                      <Pill tone={row.delta == null ? "neutral" : row.delta >= 0 ? "ok" : "danger"}>
                        {row.delta == null ? "—" : `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)}`}
                      </Pill>
                    </div>
                  </Row>
                ))}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1.4fr) repeat(3, 1fr) auto",
                  gap: 6,
                  marginTop: 4,
                  padding: "4px 9px",
                  fontFamily: fonts.mono,
                  fontSize: 9,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: brand.muted,
                }}
              >
                <span>Field</span>
                {[...years].sort((a, b) => a - b).slice(-3).map((y) => (
                  <span key={y}>{y}</span>
                ))}
                {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
                  <span key={`ph-${i}`}>—</span>
                ))}
                <span>Δ</span>
              </div>
            </Card>

            <Card padding={12} tone="section">
              <Kicker style={{ marginBottom: 6 }}>CSV format</Kicker>
              <Body size="sm" style={{ marginBottom: 8, lineHeight: 1.5 }}>
                One row per field per year. Field names must match your mapped fields. Full grain-pass
                shapefiles / ISOXML parsing arrives with the backend.
              </Body>
              <pre
                style={{
                  margin: 0,
                  fontFamily: fonts.mono,
                  fontSize: 10.5,
                  background: brand.white,
                  border: `1px solid ${brand.border}`,
                  borderRadius: radius.base,
                  padding: "6px 8px",
                  color: brand.forest,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {`field,yield_t_ha,year\nNorth paddock,9.1,2026\nSouth meadow,7.4,2026`}
              </pre>
            </Card>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 1250px) {
          .tilth-yield-layout { grid-template-columns: 1fr !important; grid-template-rows: minmax(260px, 1fr) auto !important; }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

function LegendSwatch({ color, label }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 6px",
        background: brand.white,
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        fontFamily: fonts.mono,
        fontSize: 9.5,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: brand.forest,
      }}
    >
      <span aria-hidden style={{ width: 10, height: 10, background: color, borderRadius: 2 }} />
      {label}
    </div>
  );
}

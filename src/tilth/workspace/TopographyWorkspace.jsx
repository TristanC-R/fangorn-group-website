import { useEffect, useMemo, useRef, useState } from "react";
import { brand, fonts, radius } from "../ui/theme.js";
import {
  Body,
  Card,
  EmptyState,
  Kicker,
  Pill,
  Row,
  SectionHeader,
  Stat,
  Subpanel,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { FieldMapThree2D } from "../FieldMapThree2D.jsx";
import { ringCentroid } from "../geoPointInPolygon.js";
import {
  useFieldElevation,
  autoRefreshElevation,
} from "../../lib/tilthElevation.js";

const LAYERS = [
  { id: "elevation", label: "Elevation", unit: "m", legend: ["low", "mid", "high"] },
  { id: "slope", label: "Slope", unit: "°", legend: ["flat", "moderate", "steep"] },
  { id: "aspect", label: "Aspect", unit: "", legend: ["N", "E", "S", "W"] },
  { id: "twi", label: "TWI", unit: "", legend: ["dry", "mid", "wet"] },
];

function layerColor(t, layerId) {
  if (layerId === "elevation") {
    const from = [100, 160, 88];
    const mid = [217, 180, 100];
    const to = [140, 90, 60];
    const ab = t < 0.5 ? { f: from, tt: mid, k: t * 2 } : { f: mid, tt: to, k: (t - 0.5) * 2 };
    return `rgb(${Math.round(ab.f[0] + (ab.tt[0] - ab.f[0]) * ab.k)}, ${Math.round(
      ab.f[1] + (ab.tt[1] - ab.f[1]) * ab.k
    )}, ${Math.round(ab.f[2] + (ab.tt[2] - ab.f[2]) * ab.k)})`;
  }
  if (layerId === "slope") {
    const from = [100, 154, 92];
    const mid = [217, 129, 25];
    const to = [180, 65, 46];
    const ab = t < 0.5 ? { f: from, tt: mid, k: t * 2 } : { f: mid, tt: to, k: (t - 0.5) * 2 };
    return `rgb(${Math.round(ab.f[0] + (ab.tt[0] - ab.f[0]) * ab.k)}, ${Math.round(
      ab.f[1] + (ab.tt[1] - ab.f[1]) * ab.k
    )}, ${Math.round(ab.f[2] + (ab.tt[2] - ab.f[2]) * ab.k)})`;
  }
  if (layerId === "aspect") {
    const hues = ["#2F6077", "#D98119", "#B4412E", "#649A5C"];
    return hues[Math.floor(t * 4) % 4];
  }
  const from = [217, 199, 163];
  const to = [47, 96, 119];
  return `rgb(${Math.round(from[0] + (to[0] - from[0]) * t)}, ${Math.round(
    from[1] + (to[1] - from[1]) * t
  )}, ${Math.round(from[2] + (to[2] - from[2]) * t)})`;
}

function normalise(val, min, max) {
  if (!Number.isFinite(val) || !Number.isFinite(min) || !Number.isFinite(max)) return 0.5;
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

function aspectNorm(deg) {
  if (!Number.isFinite(deg)) return 0.5;
  return ((deg % 360) + 360) % 360 / 360;
}

function fmt(v, dp = 1) {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(dp);
}

export function TopographyWorkspace({ fields }) {
  const [layer, setLayer] = useState("elevation");
  const [selectedId, setSelectedId] = useState(null);
  const autoFiredRef = useRef(false);

  const withRings = useMemo(
    () => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3),
    [fields]
  );

  const fieldIds = useMemo(() => withRings.map((f) => f.id), [withRings]);
  const { data: elevData, status, refresh } = useFieldElevation(fieldIds);

  useEffect(() => {
    if (autoFiredRef.current) return;
    if (status !== "ready" || !fieldIds.length) return;
    autoFiredRef.current = true;
    autoRefreshElevation(fieldIds, elevData);
  }, [status, fieldIds, elevData]);

  const okFields = useMemo(() => {
    const out = [];
    for (const f of withRings) {
      const row = elevData.get(f.id);
      if (row?.status === "ok") out.push({ field: f, elev: row });
    }
    return out;
  }, [withRings, elevData]);

  const pendingCount = useMemo(() => {
    let c = 0;
    for (const f of withRings) {
      const row = elevData.get(f.id);
      if (!row || row.status === "pending") c++;
    }
    return c;
  }, [withRings, elevData]);

  const globalRange = useMemo(() => {
    let gMin = Infinity, gMax = -Infinity;
    let sMax = 0;
    let tMin = Infinity, tMax = -Infinity;
    for (const { elev } of okFields) {
      if (Number.isFinite(elev.elevation_min) && elev.elevation_min < gMin) gMin = elev.elevation_min;
      if (Number.isFinite(elev.elevation_max) && elev.elevation_max > gMax) gMax = elev.elevation_max;
      if (Number.isFinite(elev.slope_max_deg) && elev.slope_max_deg > sMax) sMax = elev.slope_max_deg;
      if (Number.isFinite(elev.twi_min) && elev.twi_min < tMin) tMin = elev.twi_min;
      if (Number.isFinite(elev.twi_max) && elev.twi_max > tMax) tMax = elev.twi_max;
    }
    return {
      elevMin: gMin === Infinity ? 0 : gMin,
      elevMax: gMax === -Infinity ? 100 : gMax,
      slopeMax: sMax || 10,
      twiMin: tMin === Infinity ? 0 : tMin,
      twiMax: tMax === -Infinity ? 15 : tMax,
    };
  }, [okFields]);

  const choropleth = useMemo(() => {
    const out = {};
    for (const { field, elev } of okFields) {
      let t, val;
      if (layer === "elevation") {
        val = elev.elevation_mean;
        t = normalise(val, globalRange.elevMin, globalRange.elevMax);
      } else if (layer === "slope") {
        val = elev.slope_mean_deg;
        t = normalise(val, 0, globalRange.slopeMax);
      } else if (layer === "aspect") {
        val = elev.aspect_mean_deg;
        t = aspectNorm(val);
      } else {
        val = elev.twi_mean;
        t = normalise(val, globalRange.twiMin, globalRange.twiMax);
      }
      out[field.id] = {
        value: Number.isFinite(val) ? val.toFixed(1) : "—",
        color: layerColor(t, layer),
      };
    }
    return out;
  }, [okFields, layer, globalRange]);

  const mapCenter = useMemo(() => {
    const first = withRings[0];
    if (!first) return { lat: 54, lng: -2, zoom: 6 };
    const c = ringCentroid(first.boundary);
    return { lat: c.lat, lng: c.lng, zoom: 15 };
  }, [withRings]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return okFields.find((o) => o.field.id === selectedId) || null;
  }, [selectedId, okFields]);

  const farmStats = useMemo(() => {
    if (!okFields.length) return null;
    const means = okFields.map((o) => o.elev.elevation_mean).filter(Number.isFinite);
    const slopes = okFields.map((o) => o.elev.slope_mean_deg).filter(Number.isFinite);
    return {
      avgElev: means.length ? means.reduce((a, v) => a + v, 0) / means.length : null,
      minElev: means.length ? Math.min(...okFields.map((o) => o.elev.elevation_min).filter(Number.isFinite)) : null,
      maxElev: means.length ? Math.max(...okFields.map((o) => o.elev.elevation_max).filter(Number.isFinite)) : null,
      avgSlope: slopes.length ? slopes.reduce((a, v) => a + v, 0) / slopes.length : null,
    };
  }, [okFields]);

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Remote sensing"
          title="Topography & terrain"
          description="Elevation, slope, aspect and topographic wetness from Copernicus DEM 30 m."
          actions={
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {LAYERS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLayer(l.id)}
                    style={{
                      fontFamily: fonts.sans,
                      fontSize: 10.5,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      padding: "6px 10px",
                      borderRadius: radius.base,
                      border: `1px solid ${layer === l.id ? brand.forest : brand.border}`,
                      background: layer === l.id ? brand.forest : brand.white,
                      color: layer === l.id ? brand.white : brand.forest,
                      cursor: "pointer",
                    }}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              {pendingCount > 0 && (
                <Pill tone="warn">
                  Processing {pendingCount} field{pendingCount !== 1 ? "s" : ""}…
                </Pill>
              )}
              {okFields.length > 0 && pendingCount === 0 && (
                <Pill tone="ok">
                  {okFields.length} field{okFields.length !== 1 ? "s" : ""} loaded
                </Pill>
              )}
            </>
          }
        />
      }
    >
      {withRings.length ? (
        <div
          className="tilth-topo-layout"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 340px",
            gap: 12,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
            <div style={{ flex: "1 1 auto", minHeight: 0 }}>
              <FieldMapThree2D
                key={`${mapCenter.lat}-${mapCenter.lng}-${mapCenter.zoom}-${layer}`}
                center={[mapCenter.lat, mapCenter.lng]}
                zoom={mapCenter.zoom}
                savedFields={withRings}
                draftRing={[]}
                mapMode="pan"
                basemap="light"
                choropleth={choropleth}
                height="100%"
                onSelectField={(id) => setSelectedId(id === selectedId ? null : id)}
              />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "0 0 auto" }}>
              {LAYERS.find((l) => l.id === layer)?.legend.map((lbl, i, arr) => (
                <LegendSwatch
                  key={lbl}
                  label={lbl}
                  color={layerColor(i / Math.max(1, arr.length - 1), layer)}
                />
              ))}
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
            {farmStats && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Stat kicker="Avg elevation" value={`${fmt(farmStats.avgElev, 0)} m`} sub="Farm mean" tone="forest" />
                <Stat kicker="Elev range" value={`${fmt(farmStats.minElev, 0)}–${fmt(farmStats.maxElev, 0)} m`} sub="Min – max" />
                <Stat kicker="Avg slope" value={`${fmt(farmStats.avgSlope)}°`} sub="Farm mean" />
                <Stat kicker="Fields" value={okFields.length} sub={`of ${withRings.length}`} />
              </div>
            )}

            {selected && (
              <Card padding={12}>
                <Subpanel
                  kicker="Selected field"
                  title={selected.field.name || "Unnamed"}
                  actions={
                    <button
                      type="button"
                      onClick={() => refresh(selected.field.id, { force: true })}
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 10,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        padding: "4px 8px",
                        borderRadius: radius.base,
                        border: `1px solid ${brand.border}`,
                        background: brand.white,
                        color: brand.forest,
                        cursor: "pointer",
                      }}
                    >
                      Re-extract
                    </button>
                  }
                >
                  <FieldDetailTable elev={selected.elev} />
                </Subpanel>
              </Card>
            )}

            <Card padding={12}>
              <Subpanel kicker="Per field" title="Terrain summary" style={{ marginBottom: 0 }}>
                <div style={{ display: "grid", gap: 4 }}>
                  {okFields.slice(0, 20).map(({ field, elev }) => {
                    let val, unit;
                    if (layer === "elevation") { val = elev.elevation_mean; unit = "m"; }
                    else if (layer === "slope") { val = elev.slope_mean_deg; unit = "°"; }
                    else if (layer === "aspect") { val = elev.aspect_mean_deg; unit = "°"; }
                    else { val = elev.twi_mean; unit = ""; }
                    const t = layer === "aspect"
                      ? aspectNorm(val)
                      : layer === "elevation"
                        ? normalise(val, globalRange.elevMin, globalRange.elevMax)
                        : layer === "slope"
                          ? normalise(val, 0, globalRange.slopeMax)
                          : normalise(val, globalRange.twiMin, globalRange.twiMax);
                    return (
                      <Row
                        key={field.id}
                        onClick={() => setSelectedId(field.id === selectedId ? null : field.id)}
                        active={field.id === selectedId}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr auto auto",
                            gap: 10,
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              color: brand.forest,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {field.name || "Unnamed"}
                          </span>
                          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: brand.bodySoft }}>
                            {fmt(val)}{unit}
                            {layer === "aspect" && elev.aspect_dominant ? ` ${elev.aspect_dominant}` : ""}
                          </span>
                          <span
                            aria-hidden
                            style={{
                              width: 14,
                              height: 14,
                              background: layerColor(t, layer),
                              borderRadius: 2,
                            }}
                          />
                        </div>
                      </Row>
                    );
                  })}
                  {withRings.length > 0 && okFields.length === 0 && pendingCount > 0 && (
                    <Body size="sm" color={brand.bodySoft}>
                      Extracting elevation data from Copernicus DEM…
                    </Body>
                  )}
                </div>
              </Subpanel>
            </Card>

            <Card padding={12} tone="section">
              <Kicker style={{ marginBottom: 6 }}>Data source</Kicker>
              <Body size="sm" style={{ lineHeight: 1.55 }}>
                Copernicus DEM GLO-30 (30 m resolution) via Microsoft Planetary Computer.
                Slope and aspect computed from finite differences; TWI approximated using
                local slope (no full flow-accumulation routing).
              </Body>
            </Card>
          </div>
        </div>
      ) : (
        <Card padding={24}>
          <EmptyState
            kicker="No fields"
            title="Need boundaries to compute terrain metrics"
            description="Terrain derivatives clip to field polygons. Map at least one field in Fields."
          />
        </Card>
      )}

      <style>{`
        @media (max-width: 1250px) {
          .tilth-topo-layout { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

function FieldDetailTable({ elev }) {
  if (!elev) return null;
  const rows = [
    { label: "Mean elevation", value: `${fmt(elev.elevation_mean)} m` },
    { label: "Min / Max", value: `${fmt(elev.elevation_min)} / ${fmt(elev.elevation_max)} m` },
    { label: "Elevation range", value: `${fmt(elev.elevation_range)} m` },
    { label: "Std dev", value: `${fmt(elev.elevation_stddev)} m` },
    { label: "Median", value: `${fmt(elev.elevation_median)} m` },
    { label: "", value: "" },
    { label: "Mean slope", value: `${fmt(elev.slope_mean_deg)}°` },
    { label: "Max slope", value: `${fmt(elev.slope_max_deg)}°` },
    { label: "Slope std dev", value: `${fmt(elev.slope_stddev_deg)}°` },
    { label: "", value: "" },
    { label: "Mean aspect", value: `${fmt(elev.aspect_mean_deg)}° ${elev.aspect_dominant || ""}` },
    { label: "", value: "" },
    { label: "TWI mean", value: fmt(elev.twi_mean) },
    { label: "TWI range", value: `${fmt(elev.twi_min)} – ${fmt(elev.twi_max)}` },
    { label: "", value: "" },
    { label: "Resolution", value: `${elev.resolution_m || 30} m` },
    { label: "Valid pixels", value: `${elev.valid_pixel_count ?? "—"} / ${elev.total_pixel_count ?? "—"}` },
  ];
  return (
    <div style={{ display: "grid", gap: 2 }}>
      {rows.map((r, i) =>
        r.label === "" ? (
          <div key={i} style={{ height: 6 }} />
        ) : (
          <div
            key={r.label}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 8,
              alignItems: "baseline",
              padding: "2px 0",
            }}
          >
            <span style={{ fontSize: 12, color: brand.bodySoft }}>{r.label}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 12, color: brand.forest, fontWeight: 600 }}>
              {r.value}
            </span>
          </div>
        )
      )}
    </div>
  );
}

function LegendSwatch({ color, label }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        background: brand.white,
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: brand.forest,
      }}
    >
      <span
        aria-hidden
        style={{ width: 12, height: 12, background: color, borderRadius: 2 }}
      />
      {label}
    </div>
  );
}

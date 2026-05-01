import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Subpanel,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { FieldMapThree2D } from "../FieldMapThree2D.jsx";
import { ringCentroid } from "../geoPointInPolygon.js";
import { getTilthApiBase } from "../../lib/tilthApi.js";
import { SOIL_ENVIRONMENT_PRESETS } from "../../lib/officialFarmData.js";

/**
 * Identify a single layer at a (lon, lat) point via the Tilth proxy. Returns
 *   { ok: true,  features: [{label, properties}], status, attribution }
 * or
 *   { ok: false, error: "..." }
 *
 * The proxy normalises WMS GetFeatureInfo and ArcGIS REST /identify into the
 * same shape, so this helper is a thin fetch wrapper.
 */
async function identifyLayer(apiBase, layerId, lat, lng, zoom, signal) {
  const params = new URLSearchParams({
    lon: String(lng),
    lat: String(lat),
  });
  // Pass current map zoom so the proxy can build a mapExtent that
  // matches the user's view scale. Without this, ArcGIS sub-layers with
  // scale-visibility rules (BGS 1:50k, UKSO 1:500k…) can return zero hits
  // at small mapExtents — exactly the symptom we were seeing.
  if (Number.isFinite(zoom)) params.set("z", String(Math.round(zoom)));
  const url = `${apiBase}/api/wms/${encodeURIComponent(layerId)}/identify?${params.toString()}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      features: Array.isArray(data?.features) ? data.features : [],
      attribution: data?.attribution || "",
      status: data?.upstreamStatus || res.status,
      error: data?.upstreamError || null,
    };
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, aborted: true };
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Catalogue of UK-relevant WMS / data layers that Tilth overlays on top of
 * the field map. The backend (`tilth-api`) is the canonical source for layer
 * URLs and serves tiles via `/api/wms/:id?z=...&x=...&y=...`. This local list
 * is used as a fallback when the backend isn't reachable — the UI still shows
 * all layers but marks them as "proxy offline".
 */
const FALLBACK_LAYERS = [
  {
    id: "bgs-bedrock-50k",
    group: "Geology",
    label: "BGS bedrock 1:50k",
    provider: "British Geological Survey",
    blurb: "Bedrock geology at 1:50,000.",
    attribution: "© British Geological Survey (BGS, UKRI)",
    swatches: ["#c5b283", "#8a7a4a", "#adb08e", "#746b56"],
  },
  {
    id: "bgs-superficial-50k",
    group: "Geology",
    label: "BGS superficial deposits 1:50k",
    provider: "British Geological Survey",
    blurb: "Quaternary drift — till, alluvium, blown sand, peat.",
    attribution: "© British Geological Survey (BGS, UKRI)",
    swatches: ["#d7c68d", "#a38a4f", "#b29a6b", "#76674a"],
  },
  {
    id: "bgs-mass-movement",
    group: "Geology",
    label: "BGS mass movement",
    provider: "British Geological Survey",
    blurb: "Mapped landslide and slump features.",
    attribution: "© British Geological Survey (BGS, UKRI)",
    swatches: ["#a03d2b", "#c76148", "#e38e72", "#efc2b3"],
  },
  {
    id: "bgs-gbase-shallow",
    group: "Geology",
    label: "G-BASE geochem — shallow",
    provider: "British Geological Survey",
    blurb: "Baseline stream-sediment + soil geochemistry.",
    attribution: "© British Geological Survey (BGS, UKRI)",
    swatches: ["#2f6077", "#4a8483", "#c07c12", "#b4412e"],
  },
  {
    id: "uk-lime-areas",
    group: "Soil",
    label: "Liming potential (UKSO)",
    provider: "BGS / UKSO",
    blurb: "Areas likely to benefit from liming.",
    attribution: "© BGS (UKRI) — UK Soil Observatory",
    swatches: ["#eadfbf", "#c9b47a", "#a88f4a", "#644a1a"],
  },
  {
    id: "uk-plant-avail-mg",
    group: "Soil",
    label: "Plant-available magnesium",
    provider: "UKSO MAGNET",
    blurb: "Modelled plant-available Mg in topsoils.",
    attribution: "© BGS (UKRI) — UKSO MAGNET",
    swatches: ["#f3e3b8", "#d9b86a", "#a88438", "#5f4a1b"],
  },
  {
    id: "soil-texture-simple",
    group: "Soil",
    label: "Soil texture (simple classes)",
    provider: "BGS / UKSO",
    blurb: "Light / medium / heavy bands at 1km.",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#d7ba7e", "#b9a57b", "#8d9a64", "#6f8a70"],
  },
  {
    id: "soil-texture-detailed",
    group: "Soil",
    label: "Soil texture (detailed classes)",
    provider: "BGS / UKSO",
    blurb: "Full 38-class parent-material texture at 1km.",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#c8a368", "#a3894a", "#6d7e55", "#5b6a45"],
  },
  {
    id: "soil-depth-thickness",
    group: "Soil",
    label: "Soil depth / layer thickness",
    provider: "BGS / UKSO",
    blurb: "Deep / intermediate / shallow at 1km.",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#efe3c2", "#d5b676", "#a88438", "#5f4a1b"],
  },
  {
    id: "soil-erosion-risk",
    group: "Soil",
    label: "Bare-soil erosion risk",
    provider: "BGS / UKSO",
    blurb: "Water erosion susceptibility — low to very high.",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#d9d0b6", "#cba66b", "#b56a36", "#8a2b15"],
  },
  {
    id: "peat-coverage",
    group: "Soil",
    label: "Peat coverage",
    provider: "BGS / UKSO",
    blurb: "Surface peat and buried peat layers at 1km.",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#4e3a1d", "#7a5a2e", "#a88438", "#d5b676"],
  },
  {
    id: "subsoil-grainsize",
    group: "Soil",
    label: "Subsoil grain size",
    provider: "BGS / UKSO",
    blurb: "Dominant grain-size class of parent material.",
    attribution: "© BGS (UKRI) — Soil Parent Material v2",
    swatches: ["#f5e6b5", "#d9bd74", "#a88438", "#5f4a1b"],
  },
  {
    id: "biosoil-toc",
    group: "Soil",
    label: "Soil organic carbon (BioSoil 0–5 cm)",
    provider: "Forest Research / UKSO",
    blurb: "Measured topsoil TOC at EU BioSoil forest plots.",
    attribution: "© Forest Research / UKSO",
    swatches: ["#eadfbf", "#c9b47a", "#a88f4a", "#3d2d12"],
  },
  {
    id: "coal-mining",
    group: "Hazards",
    label: "Coal-mining reporting areas",
    provider: "The Coal Authority / BGS",
    blurb: "Statutory coal-mining reporting areas.",
    attribution: "© The Coal Authority / BGS",
    swatches: ["#5a5149", "#7a6e61", "#b4412e", "#d5c4a8"],
  },
  {
    id: "flood-model-locations",
    group: "Hazards",
    label: "EA flood model locations",
    provider: "Environment Agency",
    blurb: "Locations covered by current EA flood models.",
    attribution: "© Environment Agency (OGL v3)",
    swatches: ["#2f6077", "#6f8aa0", "#b5c5d0", "#e4ebef"],
  },
  {
    id: "opentopo",
    group: "Hazards",
    label: "OpenTopoMap relief",
    provider: "OpenTopoMap",
    blurb: "Shaded relief + contours. Sanity layer.",
    attribution: "© OpenTopoMap / OpenStreetMap contributors",
    swatches: ["#3d3d3d", "#6b6b6b", "#9e9e9e", "#dadada"],
  },
  {
    id: "sssi-england",
    group: "Land",
    label: "SSSI (Sites of Special Scientific Interest)",
    provider: "Natural England",
    blurb: "Statutorily protected sites.",
    attribution: "© Natural England (OGL v3)",
    swatches: ["#4a8443", "#649a5c", "#8fb86a", "#c3d3c4"],
  },
  {
    id: "aonb-england",
    group: "Land",
    label: "Areas of Outstanding Natural Beauty",
    provider: "Natural England",
    blurb: "AONB designations.",
    attribution: "© Natural England (OGL v3)",
    swatches: ["#af8a3f", "#c7a454", "#d7b878", "#eadfbf"],
  },
  {
    id: "national-parks-england",
    group: "Land",
    label: "National Parks (England)",
    provider: "Natural England",
    blurb: "National Park boundaries.",
    attribution: "© Natural England (OGL v3)",
    swatches: ["#35643a", "#4a8443", "#6f8a70", "#c3d3c4"],
  },
  {
    id: "crome-2024",
    group: "Land",
    label: "Crop Map of England 2024",
    provider: "Rural Payments Agency",
    blurb: "Classified crop type per hexagonal cell across England.",
    attribution: "© Rural Payments Agency / Defra (OGL v3)",
    swatches: ["#d7ba30", "#649a5c", "#af8a3f", "#c4ddd0"],
  },
  {
    id: "crome-2023",
    group: "Land",
    label: "Crop Map of England 2023",
    provider: "Rural Payments Agency",
    blurb: "Previous year RPA crop classification.",
    attribution: "© Rural Payments Agency / Defra (OGL v3)",
    swatches: ["#c9a82c", "#5a8550", "#9a7a34", "#b4ccc0"],
  },
];

const GROUPS = ["Soil", "Geology", "Land", "Hazards"];
const DEFAULT_OPACITY = 0.7;
const LEGEND_COLLAPSED_LIMIT = 8;

// Shared cache so toggling a layer off + on doesn't refetch its legend each time,
// and enabling a second LayerCard for the same id reuses the first one's result.
const legendCache = new Map();
const legendInflight = new Map();

async function loadLegend(apiBase, id) {
  const key = `${apiBase}|${id}`;
  if (legendCache.has(key)) return legendCache.get(key);
  if (legendInflight.has(key)) return legendInflight.get(key);
  const p = fetch(`${apiBase}/api/wms/${encodeURIComponent(id)}/legend`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const normalized = {
        entries: Array.isArray(data?.entries) ? data.entries : [],
        source: data?.source || "none",
        attribution: data?.attribution || "",
        totalEntries: Number.isFinite(data?.totalEntries) ? data.totalEntries : null,
        truncated: !!data?.truncated,
      };
      legendCache.set(key, normalized);
      return normalized;
    })
    .catch((e) => {
      const fallback = {
        entries: [],
        source: "error",
        attribution: "",
        totalEntries: null,
        truncated: false,
        error: String(e?.message || e),
      };
      // Cache the failure briefly so we don't hammer the backend, but allow
      // retry on next mount.
      legendCache.set(key, fallback);
      setTimeout(() => legendCache.delete(key), 30_000);
      return fallback;
    })
    .finally(() => legendInflight.delete(key));
  legendInflight.set(key, p);
  return p;
}

function Legend({ apiBase, layer }) {
  const [state, setState] = useState({
    status: "loading",
    entries: [],
    source: "",
    error: null,
    totalEntries: null,
    truncated: false,
  });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!apiBase) {
      setState({
        status: "offline",
        entries: [],
        source: "",
        error: null,
        totalEntries: null,
        truncated: false,
      });
      return () => {
        alive = false;
      };
    }
    setState({
      status: "loading",
      entries: [],
      source: "",
      error: null,
      totalEntries: null,
      truncated: false,
    });
    loadLegend(apiBase, layer.id).then((data) => {
      if (!alive) return;
      setState({
        status: data.entries.length ? "ready" : data.error ? "error" : "empty",
        entries: data.entries,
        source: data.source,
        error: data.error || null,
        totalEntries: data.totalEntries ?? null,
        truncated: !!data.truncated,
      });
    });
    return () => {
      alive = false;
    };
  }, [apiBase, layer.id]);

  const fallbackSwatches = layer.swatches || [];
  const entries = state.entries;
  // Single WMS image "entry" — render large and skip the row list.
  const fullImage = entries.length === 1 && entries[0]?.full && entries[0]?.swatch;

  if (state.status === "loading") {
    return (
      <div
        style={{
          marginTop: 8,
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: brand.muted,
        }}
      >
        Loading legend…
      </div>
    );
  }

  if (fullImage) {
    return (
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <LegendHeader />
        <img
          src={entries[0].swatch}
          alt={`${layer.label} legend`}
          style={{
            maxWidth: "100%",
            display: "block",
            borderRadius: 4,
            border: `1px solid ${brand.border}`,
            background: brand.white,
          }}
        />
      </div>
    );
  }

  if (!entries.length) {
    return (
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <LegendHeader />
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
            fontFamily: fonts.sans,
            fontSize: 11,
            color: brand.muted,
          }}
        >
          {fallbackSwatches.length ? (
            <>
              {fallbackSwatches.map((c, i) => (
                <span
                  key={i}
                  aria-hidden
                  style={{
                    width: 14,
                    height: 10,
                    background: c,
                    borderRadius: 2,
                    border: `1px solid ${brand.border}`,
                  }}
                />
              ))}
              <span>No machine-readable key — colours only</span>
            </>
          ) : (
            <span>No legend published by upstream</span>
          )}
        </div>
      </div>
    );
  }

  const visible = expanded ? entries : entries.slice(0, LEGEND_COLLAPSED_LIMIT);
  const hidden = entries.length - visible.length;

  const truncatedHint = state.truncated
    ? `Showing ${entries.length} of ${state.totalEntries} published classes.`
    : null;

  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      <LegendHeader />
      <div
        style={{
          display: "grid",
          gap: 2,
          maxHeight: expanded ? 260 : undefined,
          overflowY: expanded ? "auto" : "visible",
          paddingRight: expanded ? 4 : 0,
        }}
        className={expanded ? "tilth-scroll" : undefined}
      >
        {visible.map((e, i) => (
          <LegendRow key={i} entry={e} />
        ))}
      </div>
      {entries.length > LEGEND_COLLAPSED_LIMIT ? (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            setExpanded((v) => !v);
          }}
          style={{
            alignSelf: "flex-start",
            background: "transparent",
            border: "none",
            padding: 0,
            marginTop: 2,
            cursor: "pointer",
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: brand.forest,
          }}
        >
          {expanded ? "Show fewer" : `Show all · ${entries.length}`}
          {!expanded && hidden ? ` (+${hidden})` : ""}
        </button>
      ) : null}
      {truncatedHint ? (
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 10,
            color: brand.muted,
            marginTop: 2,
          }}
        >
          {truncatedHint}
        </span>
      ) : null}
    </div>
  );
}

function LegendHeader() {
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 9,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: brand.muted,
      }}
    >
      Legend
    </span>
  );
}

function LegendRow({ entry }) {
  const isImg = typeof entry.swatch === "string" && entry.swatch.startsWith("data:");
  const isHex = typeof entry.swatch === "string" && entry.swatch.startsWith("#");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 18,
      }}
    >
      {isImg ? (
        <img
          src={entry.swatch}
          alt=""
          style={{
            width: 18,
            height: 14,
            objectFit: "cover",
            borderRadius: 2,
            border: `1px solid ${brand.border}`,
            flex: "0 0 auto",
            imageRendering: "pixelated",
          }}
        />
      ) : (
        <span
          aria-hidden
          style={{
            width: 18,
            height: 14,
            background: isHex ? entry.swatch : brand.border,
            borderRadius: 2,
            border: `1px solid ${brand.border}`,
            flex: "0 0 auto",
          }}
        />
      )}
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 11,
          color: brand.forest,
          lineHeight: 1.35,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={entry.label}
      >
        {entry.label || "—"}
      </span>
    </div>
  );
}

function LayerCard({ layer, enabled, opacity, onToggle, onOpacity, apiBase }) {
  return (
    <Row
      active={enabled}
      style={{
        padding: "10px 12px",
        display: "block",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            onToggle();
          }}
          aria-label={enabled ? `Hide ${layer.label}` : `Show ${layer.label}`}
          style={{
            width: 16,
            height: 16,
            borderRadius: 3,
            border: `1px solid ${enabled ? brand.forest : brand.border}`,
            background: enabled ? brand.forest : brand.white,
            color: brand.white,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            flex: "0 0 auto",
            cursor: "pointer",
            marginTop: 2,
          }}
        >
          {enabled ? "\u2713" : ""}
        </button>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: fonts.sans,
                fontSize: 13,
                fontWeight: 600,
                color: brand.forest,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {layer.label}
            </span>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 9,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: brand.muted,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "45%",
              }}
              title={layer.provider}
            >
              {layer.provider}
            </span>
          </div>
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 12,
              color: brand.bodySoft,
              lineHeight: 1.45,
              marginTop: 4,
            }}
          >
            {layer.blurb}
          </div>
          {!enabled ? (
            <div
              style={{
                display: "flex",
                gap: 4,
                marginTop: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {(layer.swatches || []).map((c, i) => (
                <span
                  key={i}
                  aria-hidden
                  style={{
                    width: 14,
                    height: 10,
                    background: c,
                    borderRadius: 2,
                    border: `1px solid ${brand.border}`,
                  }}
                />
              ))}
              <span style={{ flex: 1 }} />
              <StatusBadge apiBase={apiBase} needsTenantConfig={layer.needsTenantConfig} id={layer.id} />
            </div>
          ) : null}

          {enabled ? (
            <>
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 9,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: brand.muted,
                  }}
                >
                  Opacity
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={opacity}
                  onChange={(ev) => onOpacity(Number(ev.target.value))}
                  onClick={(ev) => ev.stopPropagation()}
                  style={{ flex: 1, accentColor: brand.forest }}
                />
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    color: brand.forest,
                    minWidth: 36,
                    textAlign: "right",
                  }}
                >
                  {Math.round(opacity * 100)}%
                </span>
              </div>
              <Legend apiBase={apiBase} layer={layer} />
            </>
          ) : null}
        </div>
      </div>
    </Row>
  );
}

function StatusBadge({ apiBase, needsTenantConfig, id }) {
  if (!apiBase) {
    return (
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.amber,
        }}
        title="Map layers are not available right now."
      >
        Layers offline
      </span>
    );
  }
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 9,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: needsTenantConfig ? brand.amber : brand.ok,
      }}
      title={
        needsTenantConfig
          ? "This layer needs setup before it can be shown."
          : `Layer service ready: ${id}`
      }
    >
      {needsTenantConfig ? "Check config" : "Live"}
    </span>
  );
}

function LayerStatusPill({ apiBase, manifestState }) {
  if (!apiBase) return <Pill tone="warn">Map layers offline</Pill>;
  if (manifestState === "loading") return <Pill tone="neutral">Loading layers…</Pill>;
  if (manifestState === "error") return <Pill tone="warn">Some layers unavailable</Pill>;
  return <Pill tone="ok">Map layers online</Pill>;
}

/**
 * Floating info card shown when the user clicks anywhere on the map while
 * one or more overlay layers are active. We fire a separate identify
 * request to each upstream (proxied through tilth-api) and surface the
 * results layer-by-layer. The card opens immediately in a "loading" state
 * so the user gets feedback even on slow upstreams (BGS in particular can
 * be sluggish on first hit).
 *
 * Shape of `info`:
 *   {
 *     x, y,                     // wrapper-relative for popup placement
 *     pointLat, pointLng,       // for the location strip
 *     layers: [{
 *       id, label, swatch,
 *       status: 'loading' | 'ready' | 'empty' | 'error',
 *       features: [{label, properties}],
 *       error?: string,
 *     }]
 *   }
 */
function OverlayInfoCard({ info, onClose }) {
  const left = Math.max(8, Math.min(info.x + 8, 9999));
  const top = Math.max(8, info.y - 12);
  const coordLabel = `${info.pointLat.toFixed(5)}, ${info.pointLng.toFixed(5)}`;

  return (
    <div
      role="dialog"
      aria-label="Layer feature info"
      className="tilth-soil-info-card tilth-scroll"
      style={{
        position: "absolute",
        left,
        top,
        transform: "translate(0, -100%)",
        zIndex: 6,
        background: "rgba(255,255,255,0.98)",
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        padding: "8px 10px 9px 10px",
        minWidth: 220,
        maxWidth: 320,
        maxHeight: 400,
        overflowY: "auto",
        boxShadow: "0 2px 8px rgba(16, 78, 63, 0.15)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: brand.muted,
            flex: "1 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {coordLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            border: "none",
            background: "transparent",
            color: brand.muted,
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
            width: 44,
            height: 44,
            minWidth: 44,
            minHeight: 44,
          }}
        >
          ×
        </button>
      </div>

      {info.layers.length === 0 ? (
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 12,
            color: brand.muted,
          }}
        >
          No active layers to query.
        </div>
      ) : (
        info.layers.map((l) => (
          <OverlayLayerSection key={l.id} layer={l} />
        ))
      )}
    </div>
  );
}

function OverlayLayerSection({ layer }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: brand.forest,
            flex: "1 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={layer.label}
        >
          {layer.label}
        </span>
        <Pill tone="neutral" style={{ fontSize: 8 }}>Point data</Pill>
      </div>

      {layer.status === "loading" ? (
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: brand.muted,
          }}
        >
          Querying upstream…
        </span>
      ) : layer.status === "error" ? (
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: brand.amber,
          }}
          title={layer.error || ""}
        >
          Query failed
        </span>
      ) : layer.status === "visual-only" ? (
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            color: brand.muted,
            lineHeight: 1.35,
          }}
        >
          Visual raster only. UKSO does not provide reliable per-click values for this layer, so use the mapped colour/legend rather than a point popup.
        </span>
      ) : layer.status === "empty" || !layer.features?.length ? (
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            color: brand.muted,
          }}
        >
          No feature at this point.
        </span>
      ) : (
        layer.features.slice(0, 3).map((feat, i) => (
          <OverlayFeatureRow key={i} feature={feat} />
        ))
      )}
    </div>
  );
}

function OverlayFeatureRow({ feature }) {
  const props = feature.properties || {};
  const knownKeys = new Set(["color"]);
  const extras = [];
  for (const k of Object.keys(props)) {
    if (knownKeys.has(k)) continue;
    const v = props[k];
    if (v == null) continue;
    if (typeof v === "object") continue;
    const s = String(v).trim();
    if (!s) continue;
    if (s === feature.label) continue; // don't repeat the headline
    extras.push([k, s.length > 60 ? `${s.slice(0, 57)}…` : s]);
    if (extras.length >= 5) break;
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        marginTop: 2,
      }}
    >
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 12,
          fontWeight: 600,
          color: brand.forest,
          lineHeight: 1.25,
        }}
      >
        {feature.label || "(unnamed)"}
      </span>
      {extras.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "1px 8px",
            fontFamily: fonts.mono,
            fontSize: 10,
            color: brand.muted,
          }}
        >
          {extras.map(([k, v]) => (
            <Fragment key={k}>
              <span style={{ textTransform: "lowercase" }}>{k}</span>
              <span style={{ color: brand.forest, wordBreak: "break-word" }}>{v}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SoilWorkspace({ fields }) {
  const apiBase = getTilthApiBase();
  const [catalogue, setCatalogue] = useState(FALLBACK_LAYERS);
  const [manifestState, setManifestState] = useState(apiBase ? "loading" : "offline");
  const [enabledIds, setEnabledIds] = useState(() => new Set());
  const [opacities, setOpacities] = useState({});
  const [groupFilter, setGroupFilter] = useState("all");
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  // Popup shown when the user clicks the map while overlays are active.
  // Holds the click position (lat/lng + wrapper-relative pixel coords)
  // and a per-active-layer identify result that updates progressively
  // as each upstream returns. Cleared by the close button, Escape, or
  // a change in the active layer set.
  const [overlayInfo, setOverlayInfo] = useState(null);
  const mapWrapRef = useRef(null);
  const mountedRef = useRef(true);
  // Bumped on every click so async identify responses can ignore
  // themselves if the user has already clicked again.
  const identifyTokenRef = useRef(0);
  // Track every in-flight AbortController so we can cancel them on a
  // new click or component unmount — saves bandwidth and avoids the
  // "ghost result lands after popup closed" race.
  const inflightRef = useRef(new Set());

  useEffect(() => {
    if (!overlayInfo) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOverlayInfo(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayInfo]);

  useEffect(() => {
    mountedRef.current = true;
    const inflightSet = inflightRef.current;
    return () => {
      mountedRef.current = false;
      for (const c of inflightSet) {
        try {
          c.abort();
        } catch {
          /* ignore */
        }
      }
      inflightSet.clear();
    };
  }, []);

  useEffect(() => {
    if (!apiBase) {
      setCatalogue(FALLBACK_LAYERS);
      setManifestState("offline");
      return undefined;
    }
    const ctrl = new AbortController();
    setManifestState("loading");
    fetch(`${apiBase}/api/wms/layers`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!mountedRef.current) return;
        if (Array.isArray(data?.layers) && data.layers.length) {
          setCatalogue(data.layers);
          setManifestState("ok");
        } else {
          setCatalogue(FALLBACK_LAYERS);
          setManifestState("error");
        }
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (!mountedRef.current) return;
        console.warn("[SoilWorkspace] manifest fetch failed:", e?.message || e);
        setCatalogue(FALLBACK_LAYERS);
        setManifestState("error");
      });
    return () => ctrl.abort();
  }, [apiBase]);

  const withRings = useMemo(
    () =>
      (fields || []).filter(
        (f) => Array.isArray(f.boundary) && f.boundary.length >= 3
      ),
    [fields]
  );

  const mapCenter = useMemo(() => {
    const first = withRings[0];
    if (!first) return { lat: 54, lng: -2, zoom: 6 };
    const c = ringCentroid(first.boundary);
    return { lat: c.lat, lng: c.lng, zoom: 14 };
  }, [withRings]);

  const toggle = (id) => {
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setOpacities((prev) => (prev[id] != null ? prev : { ...prev, [id]: DEFAULT_OPACITY }));
  };

  const setOpacity = (id, v) => {
    setOpacities((prev) => ({ ...prev, [id]: v }));
  };

  const applyLayerPreset = (ids) => {
    const available = new Set(catalogue.map((l) => l.id));
    const visibleIds = ids.filter((id) => available.has(id));
    setEnabledIds(new Set(visibleIds));
    setOpacities((prev) => {
      const next = {};
      visibleIds.forEach((id) => {
        if (next[id] == null) next[id] = DEFAULT_OPACITY;
        if (prev[id] != null) next[id] = prev[id];
      });
      return next;
    });
  };

  const quickPresets = useMemo(
    () => SOIL_ENVIRONMENT_PRESETS.map((preset) => ({
      ...preset,
      layers: catalogue.filter((l) => preset.layerIds.includes(l.id)),
    })).filter((preset) => preset.layers.length),
    [catalogue]
  );

  const filtered = useMemo(() => {
    if (groupFilter === "all") return catalogue;
    return catalogue.filter((l) => l.group === groupFilter);
  }, [groupFilter, catalogue]);

  const activeLayers = useMemo(
    () => catalogue.filter((l) => enabledIds.has(l.id)),
    [catalogue, enabledIds]
  );

  // Dedupe attribution strings — many UKSO sub-layers share the same credit,
  // so joining raw strings produces `"X · X · X"`. This keeps the strip tidy.
  const activeAttribution = useMemo(() => {
    const seen = new Set();
    const parts = [];
    for (const l of activeLayers) {
      const a = (l.attribution || "").trim();
      if (!a || seen.has(a)) continue;
      seen.add(a);
      parts.push(a);
    }
    return parts.join(" · ");
  }, [activeLayers]);

  // Build overlays prop for the map. `activeKey` already captures every
  // visible-property change of the active layers (id, version, opacity,
  // maxNativeZoom) so `reconcileOverlays` only sees a fresh array when
  // something user-visible has actually changed.
  const activeKey = useMemo(
    () =>
      activeLayers
        .map(
          (l) =>
            `${l.id}:${l.tileVersion || ""}:${l.renderMode || ""}:${l.maxNativeZoom ?? ""}:${(opacities[l.id] ?? DEFAULT_OPACITY).toFixed(2)}`
        )
        .join("|"),
    [activeLayers, opacities]
  );

  // When the active layer set changes the previously-clicked popup may
  // be referencing layers that are no longer visible. Drop it.
  useEffect(() => {
    setOverlayInfo(null);
  }, [activeKey]);

  // Build overlays prop for the map. Coarse UKSO ArcGIS rasters render as a
  // single field-clipped export image, not a slippy-tile stack. That avoids
  // the strange per-tile scaling/resampling artefacts those 1km rasters show
  // when ArcGIS is asked for field-level web-map tiles.
  const overlays = useMemo(() => {
    if (!apiBase) return [];
    return activeLayers.map((l) => {
      const version = encodeURIComponent(l.tileVersion || `${l.maxNativeZoom ?? ""}`);
      const opacity = opacities[l.id] ?? DEFAULT_OPACITY;
      const useFieldExport = l.renderMode === "fields";
      if (useFieldExport) {
        return {
          id: l.id,
          mode: "fields",
          opacity,
          minZoom: l.minZoom ?? undefined,
          maxZoom: l.maxZoom ?? undefined,
          tileVersion: l.tileVersion || `${l.maxNativeZoom ?? ""}`,
          rings: withRings,
          exportUrl: (minx, miny, maxx, maxy, w, h) =>
            `${apiBase}/api/wms/${encodeURIComponent(l.id)}/export?bbox=${[minx, miny, maxx, maxy].map((n) => n.toFixed(4)).join(",")}&size=${Math.round(w)},${Math.round(h)}&v=${version}`,
        };
      }
      return {
        id: l.id,
        opacity,
        minZoom: l.minZoom ?? undefined,
        maxZoom: l.maxZoom ?? undefined,
        maxNativeZoom: l.maxNativeZoom ?? undefined,
        url: (z, x, y) =>
          `${apiBase}/api/wms/${encodeURIComponent(l.id)}?z=${z}&x=${x}&y=${y}&v=${version}`,
      };
    });
  }, [apiBase, activeLayers, opacities, withRings]);

  // --- Click-to-identify ------------------------------------------------
  // On every pan-mode click the renderer hands us the world coordinate
  // and the original clientX/Y. We ask each currently-active layer's
  // upstream what feature sits under the click — WMS layers via
  // GetFeatureInfo and ArcGIS layers via /identify, both proxied by
  // tilth-api so the browser doesn't run into CORS or referer rules.
  //
  // The popup opens immediately in a "loading" state and updates each
  // layer's row as its fetch resolves. A monotonic token discards any
  // late responses for previous clicks; an inflight AbortController
  // set cancels stale requests too.
  const handleOverlayClick = useCallback(
    ({ lat, lng, zoom, clientX, clientY }) => {
      if (!apiBase) return;
      const queryableLayers = activeLayers.filter((l) => {
        const coarseArcgisRaster = l.kind === "arcgis" && l.maxNativeZoom != null;
        return (l.kind === "wms" || l.kind === "arcgis") && !coarseArcgisRaster;
      });
      const popupLayers = activeLayers
        .filter((l) => l.kind === "wms" || l.kind === "arcgis")
        .map((l) => {
          const coarseArcgisRaster = l.kind === "arcgis" && l.maxNativeZoom != null;
          return {
            id: l.id,
            label: l.label,
            swatch: (l.swatches && l.swatches[0]) || "#5a8550",
            status: coarseArcgisRaster ? "visual-only" : "loading",
            features: [],
          };
        });
      if (!popupLayers.length) {
        setOverlayInfo(null);
        return;
      }
      // Cancel any in-flight from previous clicks.
      for (const c of inflightRef.current) {
        try {
          c.abort();
        } catch {
          /* ignore */
        }
      }
      inflightRef.current.clear();

      const token = ++identifyTokenRef.current;
      const rect = mapWrapRef.current?.getBoundingClientRect();
      const x = rect ? clientX - rect.left : 0;
      const y = rect ? clientY - rect.top : 0;
      setOverlayInfo({
        x,
        y,
        pointLat: lat,
        pointLng: lng,
        layers: popupLayers,
      });

      for (const l of queryableLayers) {
        const ctrl = new AbortController();
        inflightRef.current.add(ctrl);
        identifyLayer(apiBase, l.id, lat, lng, zoom, ctrl.signal).then((result) => {
          inflightRef.current.delete(ctrl);
          if (!mountedRef.current) return;
          if (token !== identifyTokenRef.current) return; // newer click already replaced popup
          if (result.aborted) return;
          setOverlayInfo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              layers: prev.layers.map((row) => {
                if (row.id !== l.id) return row;
                if (!result.ok) {
                  return { ...row, status: "error", error: result.error || "fetch failed" };
                }
                if (!result.features.length) {
                  return { ...row, status: "empty", features: [] };
                }
                return { ...row, status: "ready", features: result.features };
              }),
            };
          });
        });
      }
    },
    [apiBase, activeLayers]
  );

  const groupCounts = useMemo(() => {
    const counts = { all: catalogue.length };
    for (const g of GROUPS) counts[g] = 0;
    for (const l of catalogue) {
      if (counts[l.group] == null) counts[l.group] = 0;
      counts[l.group] += 1;
    }
    return counts;
  }, [catalogue]);

  return (
    <WorkspaceFrame
      header={
        <div className="tilth-soil-header">
          <SectionHeader
            kicker="Environmental"
            title="Soil & land context"
            description="Stack soil, geology, coal-mining, flood and designation overlays beneath your field map. All layers are proxied through the Tilth backend so tiles are cached and attributed in one place."
            actions={<LayerStatusPill apiBase={apiBase} manifestState={manifestState} />}
          />
        </div>
      }
    >
      {!withRings.length ? (
        <Card padding={24}>
          <EmptyState
            kicker="No fields"
            title="Map boundaries to unlock overlays"
            description="Soil & land overlays sit beneath field polygons. Map at least one field first."
          />
        </Card>
      ) : (
        <div
          className="tilth-soil-layout"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 360px",
            gap: 12,
            overflow: "hidden",
          }}
        >
          <div className="tilth-soil-map-column" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
            <div
              ref={mapWrapRef}
              style={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}
            >
              <FieldMapThree2D
                key={`soil-${mapCenter.lat.toFixed(4)}-${mapCenter.lng.toFixed(4)}`}
                center={[mapCenter.lat, mapCenter.lng]}
                zoom={mapCenter.zoom}
                savedFields={withRings}
                draftRing={[]}
                mapMode="pan"
                basemap="light"
                overlays={overlays}
                height="100%"
                onOverlayClick={handleOverlayClick}
              />
              {overlayInfo ? (
                <OverlayInfoCard info={overlayInfo} onClose={() => setOverlayInfo(null)} />
              ) : null}
              <button
                type="button"
                className="tilth-soil-layer-button"
                onClick={() => setLayerMenuOpen(true)}
                style={{
                  position: "absolute",
                  right: 12,
                  top: 12,
                  zIndex: 5,
                  display: "none",
                  border: `1px solid ${brand.border}`,
                  borderRadius: radius.base,
                  background: brand.white,
                  color: brand.forest,
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  padding: "9px 11px",
                  boxShadow: "0 10px 30px rgba(16,78,63,0.16)",
                  cursor: "pointer",
                }}
              >
                Layers
              </button>
              {activeLayers.length ? (
                <div
                  style={{
                    position: "absolute",
                    left: 8,
                    bottom: 36,
                    zIndex: 3,
                    background: "rgba(255,255,255,0.94)",
                    border: `1px solid ${brand.border}`,
                    borderRadius: radius.base,
                    padding: "6px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    maxWidth: "60%",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 9,
                        letterSpacing: "0.16em",
                        textTransform: "uppercase",
                        color: brand.muted,
                      }}
                    >
                      Active
                    </span>
                    {activeLayers.map((l) => (
                      <span
                        key={l.id}
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 10,
                          letterSpacing: "0.04em",
                          color: brand.forest,
                          whiteSpace: "nowrap",
                        }}
                        title={l.attribution || l.provider}
                      >
                        {l.label} · {Math.round((opacities[l.id] ?? DEFAULT_OPACITY) * 100)}%
                      </span>
                    ))}
                  </div>
                  {activeAttribution ? (
                    <span
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 10,
                        color: brand.muted,
                        lineHeight: 1.35,
                      }}
                      title={activeAttribution}
                    >
                      {activeAttribution}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div
              className="tilth-soil-filter-bar"
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
                  fontSize: 9,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: brand.muted,
                }}
              >
                Filter
              </span>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                <GroupChip
                  label={`All · ${groupCounts.all}`}
                  active={groupFilter === "all"}
                  onClick={() => setGroupFilter("all")}
                />
                {GROUPS.map((g) => (
                  <GroupChip
                    key={g}
                    label={`${g} · ${groupCounts[g] ?? 0}`}
                    active={groupFilter === g}
                    onClick={() => setGroupFilter(g)}
                  />
                ))}
              </div>
              <span style={{ flex: 1 }} />
              <Pill tone={activeLayers.length ? "ok" : "neutral"}>
                {activeLayers.length} / {catalogue.length} enabled
              </Pill>
            </div>
          </div>

          <div
            className={`tilth-soil-side-panel tilth-scroll ${layerMenuOpen ? "open" : ""}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 0,
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            <button
              type="button"
              className="tilth-soil-panel-close"
              onClick={() => setLayerMenuOpen(false)}
              style={{
                display: "none",
                border: `1px solid ${brand.border}`,
                borderRadius: radius.base,
                background: brand.white,
                color: brand.forest,
                fontFamily: fonts.mono,
                fontSize: 10,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: "8px 10px",
                cursor: "pointer",
                justifyContent: "center",
              }}
            >
              Close layers
            </button>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Stat
                kicker="Layers"
                value={`${activeLayers.length}`}
                sub={`${catalogue.length} available`}
                tone="forest"
              />
              <Stat
                kicker="Fields"
                value={withRings.length}
                sub="Clipped to boundaries"
              />
            </div>

            {quickPresets.length ? (
              <Card padding={12}>
                <Kicker style={{ marginBottom: 6 }}>SFI / compliance views</Kicker>
                <Body size="sm" style={{ color: brand.muted, marginBottom: 8 }}>
                  Choose one view at a time. Presets replace the current layer stack so the map stays readable.
                </Body>
                <div style={{ display: "grid", gap: 6 }}>
                  {quickPresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyLayerPreset(preset.layerIds)}
                      style={{
                        textAlign: "left",
                        border: `1px solid ${preset.layers.some((l) => enabledIds.has(l.id)) ? brand.forest : brand.border}`,
                        background: preset.layers.some((l) => enabledIds.has(l.id)) ? brand.bgSection : brand.white,
                        borderRadius: radius.base,
                        padding: "8px 9px",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest, fontWeight: 700 }}>{preset.label}</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted, marginTop: 2 }}>{preset.blurb}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                        {preset.layers.map((layer) => (
                          <Pill key={layer.id} tone={enabledIds.has(layer.id) ? "ok" : "neutral"} style={{ fontSize: 8 }}>
                            {layer.label}
                          </Pill>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
                {activeLayers.length ? (
                  <Button variant="ghost" size="sm" onClick={() => setEnabledIds(new Set())} style={{ marginTop: 8 }}>
                    Clear layers
                  </Button>
                ) : null}
              </Card>
            ) : null}

            <Card
              padding={10}
              style={{
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                flex: "1 1 auto",
              }}
            >
              <Subpanel
                kicker={
                  groupFilter === "all"
                    ? "Available overlays"
                    : `Overlays · ${groupFilter}`
                }
                title={null}
                style={{ marginBottom: 6 }}
              />
              <div style={{ display: "grid", gap: 6 }}>
                {filtered.map((l) => (
                  <LayerCard
                    key={l.id}
                    layer={l}
                    enabled={enabledIds.has(l.id)}
                    opacity={opacities[l.id] ?? DEFAULT_OPACITY}
                    onToggle={() => toggle(l.id)}
                    onOpacity={(v) => setOpacity(l.id, v)}
                    apiBase={apiBase}
                  />
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 1250px) {
          .tilth-soil-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .tilth-soil-layout {
            display: block !important;
            position: relative !important;
            overflow: hidden !important;
            gap: 0 !important;
          }
          .tilth-soil-header p {
            display: none !important;
          }
          .tilth-soil-header > div {
            margin-bottom: 8px !important;
          }
          .tilth-soil-map-column {
            position: absolute !important;
            inset: 0 !important;
            display: block !important;
          }
          .tilth-soil-map-column > div:first-child {
            height: 100% !important;
          }
          .tilth-soil-layer-button {
            display: inline-flex !important;
          }
          .tilth-soil-filter-bar {
            display: none !important;
          }
          .tilth-soil-side-panel {
            position: fixed !important;
            left: max(10px, env(safe-area-inset-left, 0px)) !important;
            right: max(10px, env(safe-area-inset-right, 0px)) !important;
            top: max(72px, env(safe-area-inset-top, 0px)) !important;
            bottom: max(10px, env(safe-area-inset-bottom, 0px)) !important;
            z-index: 2600 !important;
            display: none !important;
            max-height: none !important;
            overflow-y: auto !important;
            background: ${brand.white} !important;
            border: 1px solid ${brand.border} !important;
            border-radius: 16px !important;
            box-shadow: 0 -18px 70px rgba(14,42,36,0.24) !important;
            padding: 12px !important;
          }
          .tilth-soil-side-panel.open {
            display: flex !important;
          }
          .tilth-soil-panel-close {
            display: inline-flex !important;
            position: sticky !important;
            top: 0 !important;
            z-index: 2 !important;
          }
          .tilth-soil-side-panel > div:first-of-type {
            grid-template-columns: 1fr 1fr !important;
          }
          .tilth-soil-info-card {
            position: fixed !important;
            left: max(10px, env(safe-area-inset-left, 0px)) !important;
            right: max(10px, env(safe-area-inset-right, 0px)) !important;
            bottom: max(10px, env(safe-area-inset-bottom, 0px)) !important;
            top: auto !important;
            transform: none !important;
            width: auto !important;
            min-width: 0 !important;
            max-width: none !important;
            max-height: min(70dvh, 640px) !important;
            z-index: 2500 !important;
            border-radius: 16px 16px 8px 8px !important;
            box-shadow: 0 -18px 70px rgba(14,42,36,0.22) !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

function GroupChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: "5px 9px",
        borderRadius: radius.base,
        border: `1px solid ${active ? brand.forest : brand.border}`,
        background: active ? brand.forest : brand.white,
        color: active ? brand.white : brand.forest,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

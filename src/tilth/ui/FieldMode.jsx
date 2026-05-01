import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { brand, fonts, radius, inputStyle } from "./theme.js";
import { Button, Kicker, Pill } from "./primitives.jsx";
import { FieldMapThree2D } from "../FieldMapThree2D.jsx";
import { ringCentroid, ringAreaSqDeg } from "../geoPointInPolygon.js";
import { scoreColor, STAGE_LABELS, FLAG_LABELS, useFarmHealth } from "../../lib/cropHealth.js";
import { SPECTRAL_INDICES, SPECTRAL_INDEX_LIST, formatSpectralValue, spectralTone } from "../../lib/spectralIndices.js";
import { tilthStore, useLocalValue } from "../state/localStore.js";
import { daysSincePlanting, expectedStage } from "../../lib/cropPhenology.js";
import { buildSpectralTileUrlFn, useFieldNdviScenes } from "../../lib/tilthSentinel.js";
import { buildSarTileUrlFn, SAR_BAND_DEFAULTS, useFieldSarScenes } from "../../lib/tilthSar.js";

function approxHectares(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(ring));
  const midLat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
  return Math.max(0, (sqDeg * 111_132 * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 10_000);
}

function fmtHa(ha) {
  if (!Number.isFinite(ha) || ha <= 0) return "—";
  return ha < 10 ? `${ha.toFixed(2)} ha` : `${ha.toFixed(1)} ha`;
}

const SHEET_COLLAPSED = 80;
const SHEET_PEEK = 240;
const SHEET_FULL = "70dvh";
const WIND_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "Variable"];
const BASE_PRODUCTS = [
  { id: "nitram", name: "Nitram 34.5%" },
  { id: "urea-46", name: "Urea 46%" },
  { id: "roundup-flex", name: "Roundup Flex" },
  { id: "proline-275", name: "Proline 275" },
  { id: "decis-forte", name: "Decis Forte" },
  { id: "atlantis-od", name: "Atlantis OD" },
];

function makeCustomProductId(name) {
  const base = String(name || "custom-product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "custom-product";
  return `custom-${base}`;
}

/**
 * Mobile-optimised field walking mode.
 * Full-screen map with GPS dot, tap-to-select field, bottom sheet for details + quick actions.
 */
export function FieldMode({ farm, fields, user, onExit, onNavigate }) {
  const farmId = farm?.id || null;
  const [selectedId, setSelectedId] = useState(null);
  const [sheetState, setSheetState] = useState("collapsed");
  const [gpsPos, setGpsPos] = useState(null);
  const [gpsError, setGpsError] = useState(null);
  const [quickLog, setQuickLog] = useState(false);
  const [activeS2Index, setActiveS2Index] = useState(null);
  const [activeS1Band, setActiveS1Band] = useState(null);
  const mapRef = useRef(null);
  const [teamLocations, setTeamLocations] = useLocalValue("team_locations", farmId, []);

  const plantingsMap = useMemo(() => tilthStore.loadPlantings(farmId), [farmId]);
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);
  const [customProducts, setCustomProducts] = useState(() => tilthStore.loadCustomProducts(farmId));
  useEffect(() => {
    setCustomProducts(tilthStore.loadCustomProducts(farmId));
  }, [farmId]);
  const productOptions = useMemo(() => [...BASE_PRODUCTS, ...(Array.isArray(customProducts) ? customProducts : [])], [customProducts]);
  const farmHealth = useFarmHealth(fields, plantingsMap);
  const health = useMemo(() => farmHealth?.health || new Map(), [farmHealth]);

  const items = useMemo(() => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3).map((f) => ({
    ...f,
    centroid: ringCentroid(f.boundary),
    hectares: approxHectares(f.boundary),
  })), [fields]);

  const selected = useMemo(() => items.find((f) => f.id === selectedId), [items, selectedId]);
  const selectedHealth = selectedId ? health.get(selectedId) : null;
  const selectedPlanting = selectedId ? plantingsMap[selectedId]?.[0] : null;
  const selectedAttr = selectedId ? attrs[selectedId] : null;
  const selectedFieldIds = useMemo(() => (selectedId ? [selectedId] : []), [selectedId]);
  const { latest: latestS2ByField, status: s2Status } = useFieldNdviScenes(selectedFieldIds);
  const { latest: latestS1ByField, status: s1Status } = useFieldSarScenes(selectedFieldIds);
  const selectedS2 = selectedId ? latestS2ByField.get(selectedId) || null : null;
  const selectedS1 = selectedId ? latestS1ByField.get(selectedId) || null : null;

  const dsp = selectedPlanting ? daysSincePlanting(selectedPlanting.plantingDate) : null;
  const stg = selectedPlanting ? expectedStage(selectedPlanting.crop, dsp) : null;

  const trackedLocations = useMemo(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    return (Array.isArray(teamLocations) ? teamLocations : [])
      .filter((loc) => Number.isFinite(loc.lat) && Number.isFinite(loc.lng))
      .map((loc) => ({ ...loc, isLive: new Date(loc.updatedAt).getTime() >= cutoff }))
      .sort((a, b) => Number(b.isLive) - Number(a.isLive) || (a.name || "").localeCompare(b.name || ""));
  }, [teamLocations]);

  const liveLocations = useMemo(() => trackedLocations.filter((loc) => loc.isLive), [trackedLocations]);

  const workerMarkers = useMemo(() => trackedLocations.map((loc) => ({
    id: loc.id,
    lat: loc.lat,
    lng: loc.lng,
    color: loc.isLive ? (loc.id === (user?.id || user?.email || "local-device") ? "#ec9a29" : "#104e3f") : "#7b8a82",
  })), [trackedLocations, user?.email, user?.id]);

  // GPS tracking
  useEffect(() => {
    if (!navigator.geolocation) { setGpsError("GPS not available"); return; }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const nextPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setGpsPos(nextPos);
        setGpsError(null);
        const personId = user?.id || user?.email || "local-device";
        const entry = {
          id: personId,
          name: user?.email || "This device",
          role: "operator",
          ...nextPos,
          updatedAt: new Date().toISOString(),
        };
        setTeamLocations((rows) => [entry, ...(Array.isArray(rows) ? rows : []).filter((r) => r.id !== personId)]);
      },
      (err) => { setGpsError(err.message); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [setTeamLocations, user?.email, user?.id]);

  const handleFieldTap = useCallback((id) => {
    setSelectedId(id);
    setSheetState("full");
  }, []);

  const closeSheet = useCallback(() => {
    setQuickLog(false);
    setSheetState("collapsed");
  }, []);

  const clearRasters = useCallback(() => {
    setActiveS2Index(null);
    setActiveS1Band(null);
  }, []);

  // Build health choropleth
  const choropleth = useMemo(() => {
    const out = {};
    for (const f of items) {
      const h = health.get(f.id);
      if (h) out[f.id] = { value: h.score, color: scoreColor(h.score) };
    }
    return out;
  }, [items, health]);

  const centerField = useCallback(() => {
    if (selected?.boundary) mapRef.current?.fitRing?.(selected.boundary, { padding: 0.3 });
  }, [selected]);

  const centerGps = useCallback(() => {
    if (gpsPos) mapRef.current?.setCenterZoom?.(gpsPos.lat, gpsPos.lng, 17);
  }, [gpsPos]);

  const liveRasterOverlays = useMemo(() => {
    if (!selected) return null;
    const overlays = [];
    if (activeS2Index && selectedS2?.item_id && selectedS2.status === "ok") {
      const index = SPECTRAL_INDICES[activeS2Index] || SPECTRAL_INDICES.ndvi;
      const url = buildSpectralTileUrlFn({
        itemId: selectedS2.item_id,
        collection: selectedS2.collection || "sentinel-2-l2a",
        index: index.id,
        colormap: index.colormap,
        rescale: `${index.min},${index.max}`,
      });
      if (url) {
        overlays.push({
          id: `live-s2-${index.id}-${selected.id}-${selectedS2.item_id}`,
          opacity: 0.72,
          minZoom: 8,
          maxZoom: 19,
          url,
          clipFields: [selected],
        });
      }
    }
    if (activeS1Band && selectedS1?.item_id && selectedS1.status === "ok") {
      const band = SAR_BAND_DEFAULTS[activeS1Band] || SAR_BAND_DEFAULTS.vh;
      const url = buildSarTileUrlFn({
        itemId: selectedS1.item_id,
        collection: selectedS1.collection || "sentinel-1-rtc",
        band: activeS1Band,
        rescale: band.rescale,
        colormap: band.colormap,
      });
      if (url) {
        overlays.push({
          id: `live-s1-${activeS1Band}-${selected.id}-${selectedS1.item_id}`,
          opacity: 0.64,
          minZoom: 8,
          maxZoom: 19,
          url,
          clipFields: [selected],
        });
      }
    }
    return overlays.length ? overlays : null;
  }, [activeS1Band, activeS2Index, selected, selectedS1, selectedS2]);

  const rasterActive = Boolean(liveRasterOverlays?.length);

  // Quick log form
  const [logProduct, setLogProduct] = useState("");
  const [logRate, setLogRate] = useState("");
  const [logStartTime, setLogStartTime] = useState("");
  const [logEndTime, setLogEndTime] = useState("");
  const [logWindDirection, setLogWindDirection] = useState("");
  const [logCustomProduct, setLogCustomProduct] = useState("");
  const [logNotes, setLogNotes] = useState("");

  const handleQuickLog = () => {
    if (!selectedId || !logProduct) return;
    const records = tilthStore.loadRecords(farmId);
    records.push({
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fieldId: selectedId,
      productId: logProduct,
      rate: Number(logRate) || 0,
      area: selected?.hectares || 0,
      date: new Date().toISOString().slice(0, 10),
      startTime: logStartTime,
      endTime: logEndTime,
      windDirection: logWindDirection,
      operator: "",
      notes: logNotes,
    });
    tilthStore.saveRecords(farmId, records);
    setQuickLog(false);
    setLogProduct("");
    setLogRate("");
    setLogStartTime("");
    setLogEndTime("");
    setLogWindDirection("");
    setLogNotes("");
  };

  const addCustomProduct = () => {
    const name = logCustomProduct.trim();
    if (!name) return;
    const baseId = makeCustomProductId(name);
    let id = baseId;
    let n = 2;
    while (productOptions.some((p) => p.id === id)) {
      id = `${baseId}-${n}`;
      n += 1;
    }
    const entry = {
      id,
      name,
      ai: "Custom product",
      category: "Herbicide",
      unit: "L/ha",
      defaultRate: Number(logRate) || 1,
      nFraction: 0,
      custom: true,
    };
    const next = [...(Array.isArray(customProducts) ? customProducts : []), entry];
    tilthStore.saveCustomProducts(farmId, next);
    setCustomProducts(next);
    setLogProduct(entry.id);
    setLogCustomProduct("");
  };

  const sheetHeight = sheetState === "full" ? SHEET_FULL : sheetState === "peek" ? SHEET_PEEK : SHEET_COLLAPSED;
  const mapBottomInset = sheetState === "collapsed" ? SHEET_COLLAPSED + 14 : sheetState === "peek" ? SHEET_PEEK + 14 : 14;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: brand.white, display: "flex", flexDirection: "column" }}>
      {/* Header bar */}
      <div className="tilth-live-map-header" style={{
        position: "absolute", top: 10, left: 12, right: 12, zIndex: 130,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        padding: "8px 10px", background: "rgba(255,255,255,0.92)", backdropFilter: "blur(12px)",
        borderBottom: `1px solid ${brand.border}`,
        border: `1px solid ${brand.border}`,
        borderRadius: 14,
        boxShadow: "0 10px 28px rgba(16,78,63,0.12)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.moss }}>Live farm map</div>
          <Pill tone={liveLocations.length ? "ok" : "neutral"} style={{ fontSize: 9 }}>{liveLocations.length} live</Pill>
          {gpsPos && (
            <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>
              GPS ±{Math.round(gpsPos.accuracy)}m
            </div>
          )}
          {gpsError && <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.danger }}>GPS: {gpsError}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
          {gpsPos && (
            <button type="button" onClick={centerGps} style={{ padding: "6px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, fontFamily: fonts.mono, fontSize: 10, color: brand.forest, cursor: "pointer" }}>
              My location
            </button>
          )}
          <button type="button" onClick={onExit} style={{ padding: "6px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.forest, fontFamily: fonts.mono, fontSize: 10, color: brand.white, cursor: "pointer" }}>
            Exit
          </button>
        </div>
      </div>

      {/* Full-screen map */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <FieldMapThree2D
          center={items[0]?.centroid ? [items[0].centroid.lat, items[0].centroid.lng] : [54, -2]}
          zoom={items.length ? 15 : 6}
          savedFields={items}
          draftRing={[]}
          mapMode="pan"
          basemap="satellite"
          selectedFieldId={selectedId}
          choropleth={choropleth}
          pointMarkers={workerMarkers}
          overlays={liveRasterOverlays}
          suppressFieldFill={rasterActive}
          controls={false}
          uiInsets={{ bottom: mapBottomInset }}
          onSelectField={handleFieldTap}
          onReady={(ctx) => { mapRef.current = ctx; }}
          height="100%"
        />
      </div>

      <div className="tilth-live-people-card" style={{
        position: "absolute",
        top: 68,
        left: 12,
        zIndex: 115,
        width: "min(300px, calc(100vw - 24px))",
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(12px)",
        border: `1px solid ${brand.border}`,
        borderRadius: 14,
        boxShadow: "0 10px 30px rgba(16,78,63,0.14)",
        padding: 10,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
          <Kicker>People on farm</Kicker>
          <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>last 30 min</span>
        </div>
        <div style={{ display: "grid", gap: 5, maxHeight: 132, overflowY: "auto" }} className="tilth-scroll">
          {trackedLocations.length ? trackedLocations.map((loc) => {
            const isMe = loc.id === (user?.id || user?.email || "local-device");
            return (
              <button
                key={loc.id}
                type="button"
                onClick={() => mapRef.current?.setCenterZoom?.(loc.lat, loc.lng, 17)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  border: `1px solid ${isMe ? "#ec9a29" : brand.border}`,
                  borderRadius: radius.base,
                  background: isMe ? "#fff7ed" : loc.isLive ? brand.white : brand.bgSection,
                  padding: "6px 8px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: loc.isLive ? (isMe ? "#ec9a29" : brand.forest) : "#7b8a82", border: `2px solid ${brand.white}`, boxShadow: "0 0 0 1px rgba(16,78,63,0.18)" }} />
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {isMe ? "You" : (loc.name?.split("@")[0] || "Device")}
                  </span>
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, whiteSpace: "nowrap" }}>
                  {loc.isLive ? `±${Math.round(loc.accuracy || 0)}m` : "last known"}
                </span>
              </button>
            );
          }) : (
            <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.muted, lineHeight: 1.35 }}>
              No saved locations yet. Open this map on each work phone and allow GPS access.
            </div>
          )}
        </div>
      </div>

      <div className="tilth-live-map-controls" style={{
        position: "absolute",
        top: 68,
        right: 12,
        zIndex: 116,
        display: "grid",
        gap: 6,
      }}>
        <button type="button" onClick={() => mapRef.current?.zoomBy?.(1)} aria-label="Zoom in" style={liveMapControlStyle}>+</button>
        <button type="button" onClick={() => mapRef.current?.zoomBy?.(-1)} aria-label="Zoom out" style={liveMapControlStyle}>-</button>
        {gpsPos && (
          <button type="button" onClick={centerGps} aria-label="Centre on my location" style={liveMapControlStyle}>◎</button>
        )}
      </div>

      {/* Bottom sheet */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 120,
        height: sheetHeight,
        background: brand.white,
        borderTop: `2px solid ${brand.forest}`,
        borderRadius: "14px 14px 0 0",
        boxShadow: "0 -8px 30px rgba(0,0,0,0.12)",
        transition: "height 250ms ease",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{ padding: "10px 14px 8px", borderBottom: sheetState === "full" ? `1px solid ${brand.border}` : "none" }}>
          {sheetState === "full" ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.muted }}>
                  Field menu
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 650, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selected?.name || "Live map"}
                </div>
              </div>
              <button
                type="button"
                onClick={closeSheet}
                style={{
                  minHeight: 38,
                  padding: "8px 12px",
                  border: `1px solid ${brand.border}`,
                  borderRadius: radius.base,
                  background: brand.white,
                  color: brand.forest,
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  flex: "0 0 auto",
                }}
              >
                Close
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => selected && setSheetState("full")}
              disabled={!selected}
              style={{
                width: "100%",
                minHeight: 52,
                padding: "10px 12px",
                border: `1px solid ${selected ? brand.forest : brand.border}`,
                borderRadius: radius.base,
                background: selected ? brand.forest : brand.bgSection,
                color: selected ? brand.white : brand.muted,
                fontFamily: fonts.mono,
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                cursor: selected ? "pointer" : "default",
                boxShadow: selected ? "0 8px 22px rgba(16,78,63,0.16)" : "none",
              }}
            >
              {selected ? `Open ${selected.name || "field"} menu` : "Tap a field to open menu"}
            </button>
          )}
        </div>

        {/* Sheet content */}
        <div style={{ flex: 1, overflowY: "auto", padding: sheetState === "full" ? "10px 14px 14px" : "0 14px 14px" }} className="tilth-scroll">
          {selected ? (
            quickLog ? (
              /* Quick log form */
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <Kicker>Quick log — {selected.name}</Kicker>
                  <button type="button" onClick={() => setQuickLog(false)} style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, background: "transparent", border: "none", cursor: "pointer" }}>Cancel</button>
                </div>
                <select value={logProduct} onChange={(e) => setLogProduct(e.target.value)} style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }}>
                  <option value="">Select product…</option>
                  {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div className="tilth-fieldmode-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                  <input value={logCustomProduct} onChange={(e) => setLogCustomProduct(e.target.value)} placeholder="Add chemical not in list" style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }} />
                  <Button variant="secondary" size="sm" onClick={addCustomProduct} disabled={!logCustomProduct.trim()}>Add</Button>
                </div>
                <input type="number" value={logRate} onChange={(e) => setLogRate(e.target.value)} placeholder="Rate" style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }} />
                <div className="tilth-fieldmode-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <input type="time" value={logStartTime} onChange={(e) => setLogStartTime(e.target.value)} aria-label="Start time" style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }} />
                  <input type="time" value={logEndTime} onChange={(e) => setLogEndTime(e.target.value)} aria-label="End time" style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }} />
                </div>
                <select value={logWindDirection} onChange={(e) => setLogWindDirection(e.target.value)} style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }}>
                  <option value="">Wind direction…</option>
                  {WIND_DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <input value={logNotes} onChange={(e) => setLogNotes(e.target.value)} placeholder="Notes (optional)" style={{ ...inputStyle, fontSize: 13, padding: "10px 12px" }} />
                <Button variant="primary" size="sm" onClick={handleQuickLog} disabled={!logProduct}>Log application</Button>
              </div>
            ) : (
              /* Field detail */
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontFamily: fonts.serif, fontSize: 18, color: brand.forest, fontWeight: 500 }}>{selected.name}</div>
                  {selectedHealth && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 999, background: scoreColor(selectedHealth.score) }} />
                      <span style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: 600, color: brand.forest }}>{selectedHealth.score}</span>
                    </div>
                  )}
                </div>

                {/* Quick stats */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  <MiniField label="Area" value={fmtHa(selected.hectares)} />
                  <MiniField label="Crop" value={selectedPlanting?.crop || selectedAttr?.crop || "—"} />
                  <MiniField label="Soil" value={selectedAttr?.soil || "—"} />
                </div>

                {/* Health summary */}
                {selectedHealth && (
                  <div style={{ padding: "8px 10px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.bgSection }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.bodySoft, lineHeight: 1.4, marginBottom: 4 }}>{selectedHealth.summary}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      <Pill tone="neutral" style={{ fontSize: 9, textTransform: "none" }}>{STAGE_LABELS[selectedHealth.stage] || selectedHealth.stage}</Pill>
                      {selectedHealth.flags.slice(0, 3).map((fl) => (
                        <Pill key={fl} tone={fl.includes("dip") || fl === "late_emergence" ? "danger" : "warn"} style={{ fontSize: 9, textTransform: "none" }}>{FLAG_LABELS[fl] || fl}</Pill>
                      ))}
                      {SPECTRAL_INDEX_LIST.slice(0, 6).map((idx) => {
                        const value = selectedHealth.metrics?.spectral?.[idx.id];
                        return Number.isFinite(value) ? (
                          <Pill key={idx.id} tone={spectralTone(value, idx.id)} style={{ fontSize: 9, textTransform: "none" }} title={idx.interpretation}>
                            {idx.label} {formatSpectralValue(value)}
                          </Pill>
                        ) : null;
                      })}
                    </div>
                  </div>
                )}

                {/* Crop stage */}
                {selectedPlanting && stg && (
                  <div style={{ padding: "6px 10px", borderRadius: radius.base, border: `1px solid ${brand.forest}33`, background: "#f0f6f0" }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>{selectedPlanting.crop}</span>
                      <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>{dsp} days · {stg.stageName}</span>
                    </div>
                    <div style={{ display: "flex", gap: 2, height: 5, borderRadius: 3, overflow: "hidden" }}>
                      {Array.from({ length: stg.totalStages }, (_, i) => (
                        <div key={i} style={{ flex: 1, borderRadius: 1, background: i < stg.stageIndex ? brand.forest : i === stg.stageIndex ? brand.moss : brand.border }} />
                      ))}
                    </div>
                    {stg.isLate && <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.warn, marginTop: 3 }}>Behind expected schedule</div>}
                  </div>
                )}

                {/* Selected-field raster overlays */}
                <div style={{ padding: "8px 10px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.white, display: "grid", gap: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <Kicker>Inspect rasters</Kicker>
                    {rasterActive ? (
                      <Button variant="ghost" size="sm" onClick={clearRasters} style={{ minHeight: 30, padding: "5px 8px", fontSize: 9 }}>
                        Standard view
                      </Button>
                    ) : (
                      <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>selected field only</span>
                    )}
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted, marginBottom: 4 }}>
                        Sentinel-2 optical
                      </div>
                      <div className="tilth-fieldmode-raster-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 5 }}>
                        {SPECTRAL_INDEX_LIST.map((idx) => (
                          <Button
                            key={idx.id}
                            variant={activeS2Index === idx.id ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setActiveS2Index((current) => current === idx.id ? null : idx.id)}
                            disabled={!selectedS2}
                            title={selectedS2 ? `Toggle latest Sentinel-2 ${idx.label} raster clipped to this field.` : `No Sentinel-2 raster ready (${s2Status}).`}
                            style={{ minHeight: 34, padding: "6px 7px", fontSize: 9 }}
                          >
                            {idx.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted, marginBottom: 4 }}>
                        Sentinel-1 radar
                      </div>
                      <div className="tilth-fieldmode-raster-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 5 }}>
                        {Object.entries(SAR_BAND_DEFAULTS).map(([bandId, band]) => (
                          <Button
                            key={bandId}
                            variant={activeS1Band === bandId ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setActiveS1Band((current) => current === bandId ? null : bandId)}
                            disabled={!selectedS1}
                            title={selectedS1 ? `Toggle latest Sentinel-1 ${band.label} raster clipped to this field.` : `No Sentinel-1 raster ready (${s1Status}).`}
                            style={{ minHeight: 34, padding: "6px 7px", fontSize: 9 }}
                          >
                            {bandId.toUpperCase()}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    <Pill tone={selectedS2 ? "ok" : "neutral"} style={{ fontSize: 9 }}>
                      S2 {selectedS2?.scene_datetime ? new Date(selectedS2.scene_datetime).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : s2Status}
                    </Pill>
                    <Pill tone={selectedS1 ? "ok" : "neutral"} style={{ fontSize: 9 }}>
                      S1 {selectedS1?.scene_datetime ? new Date(selectedS1.scene_datetime).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : s1Status}
                    </Pill>
                    {rasterActive ? (
                      <Pill tone="info" style={{ fontSize: 9 }}>Boundary only</Pill>
                    ) : null}
                  </div>
                </div>

                {/* Action buttons */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <Button variant="primary" size="sm" onClick={() => { setQuickLog(true); setSheetState("full"); }}>Log application</Button>
                  <Button variant="secondary" size="sm" onClick={centerField}>Center map</Button>
                  <Button variant="secondary" size="sm" onClick={() => { onExit(); onNavigate?.("insights"); }}>Open insights</Button>
                  <Button variant="secondary" size="sm" onClick={() => { onExit(); onNavigate?.("sensing"); }}>Satellite data</Button>
                </div>
              </div>
            )
          ) : (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ fontFamily: fonts.sans, fontSize: 13, color: brand.bodySoft }}>Tap a field on the map</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginTop: 2 }}>{items.length} field{items.length === 1 ? "" : "s"} mapped</div>
            </div>
          )}
        </div>
      </div>
      <style>{`
        @media (max-width: 680px) {
          .tilth-live-map-header {
            left: 8px !important;
            right: 8px !important;
            top: 8px !important;
            align-items: flex-start !important;
            flex-direction: column !important;
          }
          .tilth-live-map-header > div {
            width: 100% !important;
          }
          .tilth-live-map-header > div:last-child {
            justify-content: space-between !important;
          }
          .tilth-live-people-card {
            top: 118px !important;
            left: 8px !important;
            width: min(260px, calc(100vw - 76px)) !important;
            max-height: 174px !important;
          }
          .tilth-live-map-controls {
            top: 118px !important;
            right: 8px !important;
          }
        }
        @media (max-width: 520px) {
          .tilth-fieldmode-form-grid {
            grid-template-columns: 1fr !important;
          }
          .tilth-fieldmode-raster-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }
      `}</style>
    </div>
  );
}

const liveMapControlStyle = {
  width: 36,
  height: 36,
  borderRadius: 12,
  border: `1px solid ${brand.border}`,
  background: "rgba(255,255,255,0.94)",
  color: brand.forest,
  boxShadow: "0 8px 22px rgba(16,78,63,0.14)",
  cursor: "pointer",
  fontFamily: fonts.mono,
  fontSize: 16,
  fontWeight: 700,
  backdropFilter: "blur(12px)",
};

function MiniField({ label, value }) {
  return (
    <div style={{ padding: "5px 7px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.white }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 8, letterSpacing: "0.14em", textTransform: "uppercase", color: brand.muted }}>{label}</div>
      <div style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 500, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}

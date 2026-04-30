import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  EmptyState,
  FieldLabel,
  Kicker,
  Pill,
  Row,
  SectionHeader,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { getTilthApiBase } from "../../lib/tilthApi.js";
import { FieldMapThree2D } from "../FieldMapThree2D.jsx";
import { haversineM, ringAreaSqDeg, ringCentroid } from "../geoPointInPolygon.js";
import { FieldsSetup } from "../FieldsSetup.jsx";
import { supabase } from "../../lib/supabaseClient.js";
import { triggerNdviRefresh } from "../../lib/tilthSentinel.js";
import { triggerSarRefresh } from "../../lib/tilthSar.js";
import { autoFillFieldSoil } from "../../lib/soilAutoFill.js";
import { tilthStore } from "../state/localStore.js";
import {
  LAND_USES,
  DEFAULT_LAND_USE,
  landUseColor,
  landUseLabel,
} from "../state/landUse.js";
import {
  CROP_NAMES,
  cropTimeline,
  daysSincePlanting,
  expectedStage,
} from "../../lib/cropPhenology.js";

function approxHectares(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const sqDeg = Math.abs(ringAreaSqDeg(ring));
  const midLat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
  const metersPerDegLat = 111_132;
  const metersPerDegLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const areaM2 = sqDeg * metersPerDegLat * metersPerDegLng;
  return Math.max(0, areaM2 / 10_000);
}

function approxPerimeterM(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    total += haversineM(a.lat, a.lng, b.lat, b.lng);
  }
  return total;
}

function fmtHa(ha) {
  if (!Number.isFinite(ha) || ha <= 0) return "—";
  return ha < 10 ? `${ha.toFixed(2)} ha` : `${ha.toFixed(1)} ha`;
}

function formatDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

async function geocodeFarmToView(farm, signal) {
  const parts = [
    farm?.address_line1,
    farm?.address_line2,
    farm?.city,
    farm?.region,
    farm?.postcode,
    farm?.country,
  ]
    .filter(Boolean)
    .join(", ");
  if (!parts.trim()) return null;
  const api = getTilthApiBase();
  const p = new URLSearchParams({ format: "json", limit: "1", q: parts });
  const url = api
    ? `${api}/api/nominatim/search?${p.toString()}`
    : `https://nominatim.openstreetmap.org/search?${p.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) return null;
  const json = await res.json();
  const hit = Array.isArray(json) ? json[0] : null;
  const lat = hit?.lat ? parseFloat(hit.lat) : NaN;
  const lng = hit?.lon ? parseFloat(hit.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, zoom: 15 };
}

const SOIL_OPTIONS = ["Clay", "Clay loam", "Loam", "Sandy loam", "Sandy", "Silty", "Peat", "Chalk"];
const TENURE_OPTIONS = ["Owned", "Tenanted", "Share-farmed", "Contract farmed"];

export function FieldsWorkspace({ farm, fields, onFieldsUpdated }) {
  const [selectedId, setSelectedId] = useState(fields?.[0]?.id || null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editRing, setEditRing] = useState(null);
  const [saveBusy, setSaveBusy] = useState(false);

  const mapRef = useRef(null);
  const importRef = useRef(null);

  const [attrs, setAttrs] = useState(() => tilthStore.loadFieldAttrs(farm?.id));
  const [plantings, setPlantings] = useState(() => tilthStore.loadPlantings(farm?.id));
  useEffect(() => {
    setAttrs(tilthStore.loadFieldAttrs(farm?.id));
    setPlantings(tilthStore.loadPlantings(farm?.id));
  }, [farm?.id]);

  const saveAttr = (fieldId, patch) => {
    setAttrs((prev) => {
      const next = { ...prev, [fieldId]: { ...(prev[fieldId] || {}), ...patch } };
      tilthStore.saveFieldAttrs(farm?.id, next);
      return next;
    });
  };

  const refreshPlantings = () => setPlantings(tilthStore.loadPlantings(farm?.id));

  // Auto-fill soil type for any fields that don't have one yet.
  useEffect(() => {
    if (!farm?.id || !fields?.length) return;
    const current = tilthStore.loadFieldAttrs(farm.id);
    for (const f of fields) {
      if (current[f.id]?.soil) continue;
      if (!Array.isArray(f.boundary) || f.boundary.length < 3) continue;
      autoFillFieldSoil(farm.id, f.id, f.boundary)
        .then(() => setAttrs(tilthStore.loadFieldAttrs(farm.id)))
        .catch(() => {});
    }
  }, [farm?.id, fields]);

  useEffect(() => {
    if (!fields?.length) {
      setSelectedId(null);
      return;
    }
    if (selectedId && fields.some((f) => f.id === selectedId)) return;
    const last = fields[fields.length - 1];
    if (last) setSelectedId(last.id);
  }, [fields, selectedId]);

  // Fit to selected field whenever selection changes (and map is ready).
  useEffect(() => {
    const sel = fields?.find((f) => f.id === selectedId);
    if (!sel) return;
    const ring = Array.isArray(sel.boundary) ? sel.boundary : [];
    if (ring.length < 3) return;
    // Defer to next frame to let map initialise on first mount.
    const id = requestAnimationFrame(() => {
      mapRef.current?.fitRing?.(ring, { padding: 0.35 });
    });
    return () => cancelAnimationFrame(id);
  }, [selectedId, fields]);

  // Geocode the farm address as an initial fallback view when there are no fields.
  const [initialView, setInitialView] = useState(() => {
    const first = (fields || []).find(
      (f) => Array.isArray(f.boundary) && f.boundary.length >= 3
    );
    if (first) {
      const c = ringCentroid(first.boundary);
      return { lat: c.lat, lng: c.lng, zoom: 16 };
    }
    return { lat: 54, lng: -2, zoom: 6 };
  });
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    if (fields?.length) return () => ac.abort();
    setNote("Locating farm…");
    (async () => {
      try {
        const v = await geocodeFarmToView(farm, ac.signal);
        if (cancelled || !v) return;
        setInitialView(v);
        setNote(null);
      } catch {
        if (!cancelled) setNote("Could not locate farm — pan the map manually.");
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [farm, fields?.length]);

  const items = useMemo(() => {
    const arr = Array.isArray(fields) ? fields : [];
    return arr.map((f) => {
      const hasRing = Array.isArray(f.boundary) && f.boundary.length >= 3;
      const centroid = hasRing ? ringCentroid(f.boundary) : null;
      return {
        id: f.id,
        name: f.name,
        boundary: f.boundary || [],
        centroid,
        hectares: hasRing ? approxHectares(f.boundary) : 0,
        perimeter: hasRing ? approxPerimeterM(f.boundary) : 0,
        created_at: f.created_at,
      };
    });
  }, [fields]);

  const selected = useMemo(
    () => items.find((f) => f.id === selectedId) || null,
    [items, selectedId]
  );

  useEffect(() => {
    setRenameValue(selected?.name || "");
  }, [selected?.id, selected?.name]);

  const totalArea = items.reduce((acc, f) => acc + f.hectares, 0);

  // Tint fields on the map by land-use classification so farmers can see
  // grass paddocks, woodland etc. at a glance.
  const landUseChoropleth = useMemo(() => {
    const out = {};
    for (const f of items) {
      const use = attrs[f.id]?.landUse;
      if (!use) continue;
      out[f.id] = { value: landUseLabel(use), color: landUseColor(use) };
    }
    return out;
  }, [items, attrs]);

  const landUseBreakdown = useMemo(() => {
    const map = new Map();
    for (const u of LAND_USES) map.set(u.id, { ...u, count: 0, ha: 0 });
    let classified = 0;
    for (const f of items) {
      const use = attrs[f.id]?.landUse;
      if (!use || !map.has(use)) continue;
      const entry = map.get(use);
      entry.count += 1;
      entry.ha += f.hectares;
      classified += 1;
    }
    return {
      rows: [...map.values()].filter((r) => r.count > 0),
      classified,
    };
  }, [items, attrs]);

  const attrCoverage = useMemo(() => {
    const total = items.length;
    if (!total) return { land: 0, crop: 0, soil: 0, planted: 0, total: 0 };
    let land = 0;
    let crop = 0;
    let soil = 0;
    let planted = 0;
    for (const f of items) {
      const a = attrs[f.id] || {};
      if (a.landUse) land += 1;
      if (a.crop) crop += 1;
      if (a.soil) soil += 1;
      const fp = plantings[f.id];
      if (Array.isArray(fp) && fp.length && fp[0].plantingDate) planted += 1;
    }
    return { land, crop, soil, planted, total };
  }, [items, attrs, plantings]);

  const handleSelect = useCallback((id) => {
    if (editingId && id !== editingId) return; // avoid dropping edits
    setSelectedId(id);
  }, [editingId]);

  const handleDelete = async (id) => {
    if (!supabase || !id) return;
    if (!window.confirm("Delete this field? This cannot be undone.")) return;
    setDeleteBusy(id);
    try {
      const { error } = await supabase.from("tilth_fields").delete().eq("id", id);
      if (error) throw new Error(error.message);
      if (selectedId === id) setSelectedId(null);
      if (editingId === id) {
        setEditingId(null);
        setEditRing(null);
      }
      await onFieldsUpdated?.();
    } catch (e) {
      window.alert(e?.message || "Delete failed");
    } finally {
      setDeleteBusy(null);
    }
  };

  const handleRename = async () => {
    if (!supabase || !selected) return;
    const name = renameValue.trim();
    if (!name || name === selected.name) return;
    setRenameBusy(true);
    try {
      const { error } = await supabase
        .from("tilth_fields")
        .update({ name })
        .eq("id", selected.id);
      if (error) throw new Error(error.message);
      await onFieldsUpdated?.();
    } catch (e) {
      window.alert(e?.message || "Rename failed");
    } finally {
      setRenameBusy(false);
    }
  };

  const startEdit = () => {
    if (!selected) return;
    setEditingId(selected.id);
    setEditRing(selected.boundary.map((p) => ({ lat: p.lat, lng: p.lng })));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditRing(null);
  };

  const saveEdit = async () => {
    if (!supabase || !editingId || !Array.isArray(editRing) || editRing.length < 3) return;
    setSaveBusy(true);
    const editedId = editingId;
    try {
      const { error } = await supabase
        .from("tilth_fields")
        .update({ boundary: editRing })
        .eq("id", editedId);
      if (error) throw new Error(error.message);
      setEditingId(null);
      setEditRing(null);
      // Boundary changed → invalidate cached NDVI and SAR and re-ingest
      // both. The existing rows for this field stay in place (we don't
      // delete on shape change because old scenes are still valid
      // context for overlap), but new scenes computed against the new
      // polygon will upsert over them as the queue catches up.
      triggerNdviRefresh(editedId).catch(() => {});
      triggerSarRefresh(editedId).catch(() => {});
      autoFillFieldSoil(farm?.id, editedId, editRing).catch(() => {});
      await onFieldsUpdated?.();
    } catch (e) {
      window.alert(e?.message || "Save failed");
    } finally {
      setSaveBusy(false);
    }
  };

  const polygonToRing = (coordinates) => {
    const outer = Array.isArray(coordinates?.[0]) ? coordinates[0] : [];
    return outer
      .map((pair) => ({ lat: Number(pair?.[1]), lng: Number(pair?.[0]) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  };

  const parseKmlRows = (text) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "application/xml");
    const placemarks = [...doc.querySelectorAll("Placemark")];
    const targets = placemarks.length ? placemarks : [...doc.querySelectorAll("Polygon")];
    return targets.flatMap((node, idx) => {
      const name = node.querySelector("name")?.textContent?.trim() || `Imported field ${idx + 1}`;
      const polygons = node.matches?.("Polygon") ? [node] : [...node.querySelectorAll("Polygon")];
      return polygons.map((poly, polyIdx) => {
        const coordsText = poly.querySelector("outerBoundaryIs coordinates, coordinates")?.textContent || "";
        const ring = coordsText
          .trim()
          .split(/\s+/)
          .map((chunk) => {
            const [lng, lat] = chunk.split(",").map(Number);
            return { lat, lng };
          })
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
        return ring.length >= 3
          ? { farm_id: farm.id, name: polygons.length > 1 ? `${name} ${polyIdx + 1}` : name, boundary: ring }
          : null;
      }).filter(Boolean);
    });
  };

  const importBoundaryFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !supabase || !farm?.id) return;
    try {
      const text = await file.text();
      let rows = [];
      if (file.name.toLowerCase().endsWith(".kml") || text.trim().startsWith("<")) {
        rows = parseKmlRows(text);
      } else {
        const geojson = JSON.parse(text);
        const features = geojson.type === "FeatureCollection"
          ? geojson.features || []
          : geojson.type === "Feature"
            ? [geojson]
            : [{ type: "Feature", properties: {}, geometry: geojson }];
        for (const [idx, feature] of features.entries()) {
          const geometry = feature.geometry || {};
          const baseName =
            feature.properties?.name ||
            feature.properties?.Name ||
            feature.properties?.field_name ||
            `Imported field ${idx + 1}`;
          if (geometry.type === "Polygon") {
            const ring = polygonToRing(geometry.coordinates);
            if (ring.length >= 3) rows.push({ farm_id: farm.id, name: baseName, boundary: ring });
          }
          if (geometry.type === "MultiPolygon") {
            for (const [polyIdx, polygon] of (geometry.coordinates || []).entries()) {
              const ring = polygonToRing(polygon);
              if (ring.length >= 3) {
                rows.push({
                  farm_id: farm.id,
                  name: geometry.coordinates.length > 1 ? `${baseName} ${polyIdx + 1}` : baseName,
                  boundary: ring,
                });
              }
            }
          }
        }
      }
      if (!rows.length) {
        window.alert("No Polygon or MultiPolygon field boundaries found in that file.");
        return;
      }
      const { error } = await supabase.from("tilth_fields").insert(rows);
      if (error) throw new Error(error.message);
      await onFieldsUpdated?.();
      setNote(`Imported ${rows.length} field${rows.length === 1 ? "" : "s"}.`);
    } catch (e) {
      window.alert(e?.message || "Import failed. Please check the file is valid GeoJSON or KML.");
    }
  };

  const fitSelected = () => {
    const ring = selected?.boundary;
    if (Array.isArray(ring) && ring.length >= 3) {
      mapRef.current?.fitRing?.(ring, { padding: 0.35 });
    }
  };

  const selectedAttr = (selected && attrs[selected.id]) || {};

  const vertexCount = Array.isArray(editRing) ? editRing.length : 0;

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Mapping"
          title="Fields"
          description="Registry-backed map. Hover to highlight, click to select. Edit the boundary or attributes from the side panel."
          actions={
            <>
              <input
                ref={importRef}
                type="file"
                accept=".geojson,.json,.kml,application/geo+json,application/json,application/vnd.google-earth.kml+xml"
                onChange={importBoundaryFile}
                style={{ display: "none" }}
              />
              <Button
                variant={adding ? "secondary" : "primary"}
                size="sm"
                onClick={() => setAdding((v) => !v)}
              >
                {adding ? "Close mapper" : "Map new field"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => importRef.current?.click()}
                title="Import GeoJSON or KML field boundaries"
              >
                Import
              </Button>
            </>
          }
        />
      }
    >
      {adding ? (
        <div
          className="tilth-fields-setup-scroll tilth-scroll"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          <FieldsSetup
            farm={farm}
            fields={fields}
            onFieldsUpdated={async () => {
              await onFieldsUpdated?.();
            }}
            onSkip={() => setAdding(false)}
            onDone={() => setAdding(false)}
          />
        </div>
      ) : (
        <div
          className="tilth-fields-layout"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 320px",
            gap: 12,
            overflow: "hidden",
          }}
        >
          <div className="tilth-fields-map-column" style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, gap: 8 }}>
            <div className="tilth-fields-map-wrap" style={{ flex: "1 1 auto", minHeight: 0 }}>
              <FieldMapThree2D
                center={[initialView.lat, initialView.lng]}
                zoom={initialView.zoom}
                savedFields={items}
                draftRing={[]}
                mapMode="pan"
                basemap="satellite"
                selectedFieldId={selectedId}
                editingFieldId={editingId}
                editRing={editRing}
                choropleth={landUseChoropleth}
                onSelectField={handleSelect}
                onEditRingChange={setEditRing}
                onReady={(ctx) => {
                  mapRef.current = ctx;
                }}
                height="100%"
              />
            </div>

            <FieldsInfoStrip
              items={items}
              totalArea={totalArea}
              landUseBreakdown={landUseBreakdown}
              attrCoverage={attrCoverage}
              note={note}
            />
          </div>

          <div
            className="tilth-fields-panel tilth-scroll"
            style={{
              minHeight: 0,
              minWidth: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              paddingRight: 4,
            }}
          >
            <Card padding={12}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <Kicker>Registry ({items.length})</Kicker>
                {items.length ? <Pill tone="neutral">{fmtHa(totalArea)} total</Pill> : null}
              </div>
              {items.length ? (
                <div className="tilth-fields-registry-list tilth-scroll" style={{ display: "grid", gap: 4, maxHeight: 190, overflowY: "auto" }}>
                  {items.map((f) => (
                    <Row
                      key={f.id}
                      active={f.id === selectedId}
                      onClick={() => handleSelect(f.id)}
                      style={{ padding: "8px 10px" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          justifyContent: "space-between",
                          gap: 8,
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
                          {f.name || "Unnamed field"}
                        </div>
                        <div
                          style={{
                            fontFamily: fonts.mono,
                            fontSize: 10,
                            color: brand.muted,
                          }}
                        >
                          {fmtHa(f.hectares)}
                        </div>
                      </div>
                    </Row>
                  ))}
                </div>
              ) : (
                <Body size="sm">No fields yet — use <strong>Map new field</strong>.</Body>
              )}
            </Card>

            {selected ? (
              <Card padding={12}>
                {editingId === selected.id ? (
                  <EditPanel
                    vertexCount={vertexCount}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                    saving={saveBusy}
                  />
                ) : (
                  <DetailsPanel
                    selected={selected}
                    selectedAttr={selectedAttr}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    onRename={handleRename}
                    renameBusy={renameBusy}
                    onSaveAttr={saveAttr}
                    onEdit={startEdit}
                    onFit={fitSelected}
                    onDelete={() => handleDelete(selected.id)}
                    deleteBusy={deleteBusy === selected.id}
                    farmId={farm?.id}
                    plantings={plantings[selected?.id] || []}
                    onPlantingsChanged={refreshPlantings}
                  />
                )}
              </Card>
            ) : (
              <Card padding={14}>
                <EmptyState
                  kicker="No selection"
                  title="Pick a field"
                  description="Click a field on the map or in the registry to see its details."
                />
              </Card>
            )}
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 1250px) {
          .tilth-fields-layout { grid-template-columns: 1fr !important; grid-template-rows: minmax(300px, 1fr) minmax(200px, 40%) !important; }
        }
        @media (max-width: 700px) {
          .tilth-fields-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
            gap: 12px !important;
            padding-bottom: 18px !important;
          }
          .tilth-fields-map-column,
          .tilth-fields-panel {
            flex: 0 0 auto !important;
            min-height: auto !important;
            overflow: visible !important;
            padding-right: 0 !important;
          }
          .tilth-fields-map-wrap {
            flex: 0 0 auto !important;
            height: min(58vh, 420px) !important;
            min-height: 300px !important;
          }
          .tilth-fields-registry-list {
            max-height: none !important;
            overflow: visible !important;
          }
          .tilth-fields-setup-scroll {
            overflow: visible !important;
            padding-right: 0 !important;
          }
          .tilth-fields-rename-row,
          .tilth-fields-planting-header,
          .tilth-fields-detail-actions {
            display: grid !important;
            grid-template-columns: 1fr !important;
          }
          .tilth-fields-rename-row button,
          .tilth-fields-detail-actions button {
            width: 100% !important;
          }
          .tilth-fields-detail-stats,
          .tilth-fields-land-use-grid {
            grid-template-columns: 1fr !important;
          }
          .tilth-fields-planting-history {
            max-height: none !important;
            overflow: visible !important;
          }
        }
        @media (max-width: 430px) {
          .tilth-fields-map-wrap {
            height: 52vh !important;
            min-height: 280px !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

function MiniStat({ label, value }) {
  return (
    <div
      style={{
        border: `1px solid ${brand.border}`,
        background: brand.bgSection,
        borderRadius: radius.base,
        padding: "6px 8px",
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.muted,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 12,
          fontWeight: 500,
          color: brand.forest,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function DetailsPanel({
  selected,
  selectedAttr,
  renameValue,
  setRenameValue,
  onRename,
  renameBusy,
  onSaveAttr,
  onEdit,
  onFit,
  onDelete,
  deleteBusy,
  farmId,
  plantings,
  onPlantingsChanged,
}) {
  const [showPlantForm, setShowPlantForm] = useState(false);
  const [plantCrop, setPlantCrop] = useState("");
  const [plantDate, setPlantDate] = useState("");
  const [plantNotes, setPlantNotes] = useState("");

  const perim = selected.perimeter
    ? selected.perimeter >= 1000
      ? `${(selected.perimeter / 1000).toFixed(2)} km`
      : `${Math.round(selected.perimeter)} m`
    : "—";

  const currentPlanting = plantings[0] || null;
  const dsp = currentPlanting ? daysSincePlanting(currentPlanting.plantingDate) : null;
  const stage = currentPlanting ? expectedStage(currentPlanting.crop, dsp) : null;
  const timeline = currentPlanting ? cropTimeline(currentPlanting.crop) : null;

  const handleAddPlanting = () => {
    if (!plantCrop || !plantDate) return;
    tilthStore.addPlanting(farmId, selected.id, {
      crop: plantCrop,
      plantingDate: plantDate,
      notes: plantNotes,
    });
    onPlantingsChanged();
    setShowPlantForm(false);
    setPlantCrop("");
    setPlantDate("");
    setPlantNotes("");
  };

  const handleRemovePlanting = (pid) => {
    if (!window.confirm("Remove this planting record?")) return;
    tilthStore.removePlanting(farmId, selected.id, pid);
    onPlantingsChanged();
  };

  return (
    <>
      <Kicker style={{ marginBottom: 6 }}>Selected field</Kicker>
      <div className="tilth-fields-rename-row" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          style={{ ...inputStyle, padding: "7px 9px", fontSize: 13 }}
          placeholder="Field name"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onRename}
          disabled={renameBusy || !renameValue.trim() || renameValue.trim() === selected.name}
        >
          {renameBusy ? "…" : "Save"}
        </Button>
      </div>

      <div className="tilth-fields-detail-stats" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
        <MiniStat label="Area" value={fmtHa(selected.hectares)} />
        <MiniStat label="Perimeter" value={perim} />
        <MiniStat
          label="Centroid"
          value={
            selected.centroid
              ? `${selected.centroid.lat.toFixed(4)}, ${selected.centroid.lng.toFixed(4)}`
              : "—"
          }
        />
        <MiniStat label="Mapped" value={formatDate(selected.created_at)} />
      </div>

      {/* ── Planting / Crop section ── */}
      <div
        style={{
          padding: "8px 10px",
          border: `1px solid ${brand.forest}44`,
          background: "#f0f6f0",
          borderRadius: radius.base,
          marginBottom: 10,
        }}
      >
        <div className="tilth-fields-planting-header" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
          <Kicker>Planting</Kicker>
          <button
            type="button"
            onClick={() => setShowPlantForm((v) => !v)}
            style={{
              fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
              color: brand.forest, background: "transparent", border: "none", cursor: "pointer", padding: 0,
            }}
          >
            {showPlantForm ? "Cancel" : "+ New planting"}
          </button>
        </div>

        {showPlantForm && (
          <div style={{ display: "grid", gap: 6, marginBottom: 8, padding: "6px 0", borderBottom: `1px solid ${brand.border}` }}>
            <div>
              <FieldLabel>Crop</FieldLabel>
              <select
                value={plantCrop}
                onChange={(e) => setPlantCrop(e.target.value)}
                style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5, width: "100%", minWidth: 0 }}
              >
                <option value="">Select crop…</option>
                {CROP_NAMES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel>Planting date</FieldLabel>
              <input
                type="date"
                value={plantDate}
                onChange={(e) => setPlantDate(e.target.value)}
                style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5, width: "100%" }}
              />
            </div>
            <div>
              <FieldLabel>Notes (optional)</FieldLabel>
              <input
                value={plantNotes}
                onChange={(e) => setPlantNotes(e.target.value)}
                placeholder="e.g. Seed rate, variety"
                style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddPlanting}
              disabled={!plantCrop || !plantDate}
            >
              Log planting
            </Button>
          </div>
        )}

        {currentPlanting ? (
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest }}>
                {currentPlanting.crop}
              </span>
              <Pill tone="ok" style={{ fontSize: 9 }}>Current</Pill>
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
              Planted {formatDate(currentPlanting.plantingDate)}
              {dsp != null ? ` · ${dsp} days ago` : ""}
            </div>
            {stage && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 8px", background: brand.white, borderRadius: radius.base,
                border: `1px solid ${brand.border}`, marginTop: 2,
              }}>
                <span style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: brand.muted }}>
                  Stage
                </span>
                <span style={{ fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600, color: brand.forest }}>
                  {stage.stageName}
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>
                  ({stage.stageIndex + 1}/{stage.totalStages})
                </span>
                {stage.isLate && (
                  <Pill tone="warn" style={{ fontSize: 8 }}>Behind schedule</Pill>
                )}
              </div>
            )}
            {stage && (
              <div style={{ marginTop: 2 }}>
                <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, marginBottom: 2 }}>
                  Expected NDVI: {stage.ndviExpected[0].toFixed(2)} – {stage.ndviExpected[1].toFixed(2)}
                </div>
                <StageProgressBar
                  stageIndex={stage.stageIndex}
                  totalStages={stage.totalStages}
                  progress={stage.progress}
                  stages={timeline?.stages}
                />
              </div>
            )}
            {timeline?.keyRisks?.length > 0 && (
              <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, marginTop: 2 }}>
                Key risks: {timeline.keyRisks.join(", ")}
              </div>
            )}
          </div>
        ) : (
          <Body size="sm" style={{ color: brand.muted }}>
            No planting recorded. Use <strong>+ New planting</strong> to log when and what was planted.
          </Body>
        )}

        {plantings.length > 1 && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${brand.border}`, paddingTop: 6 }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted, marginBottom: 4 }}>
              History ({plantings.length})
            </div>
            <div className="tilth-fields-planting-history tilth-scroll" style={{ display: "grid", gap: 3, maxHeight: 100, overflowY: "auto" }}>
              {plantings.slice(1).map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "3px 6px", background: brand.white, borderRadius: radius.base, border: `1px solid ${brand.border}` }}>
                  <div>
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 500, color: brand.forest }}>{p.crop}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, marginLeft: 6 }}>{formatDate(p.plantingDate)}</span>
                  </div>
                  <button
                    type="button"
                    className="tilth-icon-button"
                    onClick={() => handleRemovePlanting(p.id)}
                    title="Remove"
                    style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px" }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Other attributes ── */}
      <div
        style={{
          padding: "8px 10px",
          border: `1px solid ${brand.border}`,
          background: brand.bgSection,
          borderRadius: radius.base,
          marginBottom: 10,
        }}
      >
        <Kicker style={{ marginBottom: 6 }}>Attributes</Kicker>
        <div style={{ display: "grid", gap: 6 }}>
          <div>
            <FieldLabel>Land use</FieldLabel>
            <LandUsePicker
              value={selectedAttr.landUse || DEFAULT_LAND_USE}
              onChange={(id) => onSaveAttr(selected.id, { landUse: id })}
            />
          </div>
          <div>
            <FieldLabel>Soil type</FieldLabel>
            <select
              value={selectedAttr.soil || ""}
              onChange={(e) => onSaveAttr(selected.id, { soil: e.target.value || null })}
              style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5, width: "100%", minWidth: 0 }}
            >
              <option value="">—</option>
              {SOIL_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>Tenure</FieldLabel>
            <select
              value={selectedAttr.tenure || ""}
              onChange={(e) => onSaveAttr(selected.id, { tenure: e.target.value || null })}
              style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5, width: "100%", minWidth: 0 }}
            >
              <option value="">—</option>
              {TENURE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>Notes</FieldLabel>
            <textarea
              value={selectedAttr.notes || ""}
              onChange={(e) => onSaveAttr(selected.id, { notes: e.target.value || null })}
              rows={2}
              style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5, resize: "vertical" }}
            />
          </div>
        </div>
      </div>

      <div className="tilth-fields-detail-actions" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Button variant="primary" size="sm" onClick={onEdit}>
          Edit boundary
        </Button>
        <Button variant="secondary" size="sm" onClick={onFit}>
          Recenter
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete} disabled={deleteBusy}>
          {deleteBusy ? "…" : "Delete"}
        </Button>
      </div>
    </>
  );
}

function StageProgressBar({ stageIndex, totalStages, progress, stages }) {
  return (
    <div style={{ display: "flex", gap: 2, height: 6, borderRadius: 3, overflow: "hidden" }}>
      {Array.from({ length: totalStages }, (_, i) => {
        const isActive = i === stageIndex;
        const isPast = i < stageIndex;
        let bg = brand.border;
        if (isPast) bg = brand.forest;
        else if (isActive) bg = `linear-gradient(to right, ${brand.forest} ${Math.round(progress * 100)}%, ${brand.border} ${Math.round(progress * 100)}%)`;
        return (
          <div
            key={i}
            title={stages?.[i]?.name || `Stage ${i + 1}`}
            style={{
              flex: 1,
              background: bg,
              borderRadius: 2,
              transition: "background 200ms ease",
            }}
          />
        );
      })}
    </div>
  );
}

function LandUsePicker({ value, onChange }) {
  return (
    <div
      className="tilth-fields-land-use-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 4,
      }}
    >
      {LAND_USES.map((u) => {
        const active = value === u.id;
        return (
          <button
            key={u.id}
            type="button"
            onClick={() => onChange(u.id)}
            title={u.blurb}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 6px",
              borderRadius: radius.base,
              border: `1px solid ${active ? brand.forest : brand.border}`,
              background: active ? brand.bgSection : brand.white,
              color: brand.forest,
              cursor: "pointer",
              fontFamily: fonts.sans,
              fontSize: 11,
              textAlign: "left",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                background: u.color,
                borderRadius: 2,
                flex: "0 0 auto",
              }}
            />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {u.short}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FieldsInfoStrip({ items, totalArea, landUseBreakdown, attrCoverage, note }) {
  const fmtAreaInline = (ha) => {
    if (!Number.isFinite(ha) || ha <= 0) return "—";
    return ha < 10 ? `${ha.toFixed(1)}` : `${Math.round(ha)}`;
  };
  const hasItems = items.length > 0;
  return (
    <div
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
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingRight: 10,
          borderRight: `1px solid ${brand.border}`,
          flex: "0 0 auto",
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
          Registry
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: brand.forest }}>
          {items.length} field{items.length === 1 ? "" : "s"} · {fmtAreaInline(totalArea)} ha
        </span>
      </div>

      {hasItems ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {landUseBreakdown.rows.length ? (
            landUseBreakdown.rows.map((r) => (
              <span
                key={r.id}
                title={r.blurb}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 7px",
                  background: brand.bgSection,
                  border: `1px solid ${brand.border}`,
                  borderRadius: radius.base,
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  color: brand.forest,
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 9,
                    height: 9,
                    background: r.color,
                    borderRadius: 2,
                  }}
                />
                {r.short} · {r.count} · {fmtAreaInline(r.ha)} ha
              </span>
            ))
          ) : (
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                letterSpacing: "0.08em",
                color: brand.muted,
              }}
            >
              Classify fields with <span style={{ color: brand.forest }}>Land use</span> to tint the map.
            </span>
          )}
        </div>
      ) : null}

      <div style={{ flex: 1 }} />

      {hasItems ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "0 0 auto" }}>
          <MiniCoverage label="Use" value={attrCoverage.land} total={attrCoverage.total} />
          <MiniCoverage label="Crop" value={attrCoverage.crop} total={attrCoverage.total} />
          <MiniCoverage label="Soil" value={attrCoverage.soil} total={attrCoverage.total} />
          <MiniCoverage label="Planted" value={attrCoverage.planted} total={attrCoverage.total} />
        </div>
      ) : null}

      {note && !hasItems ? (
        <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>{note}</span>
      ) : null}
    </div>
  );
}

function MiniCoverage({ label, value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const tone = pct === 100 ? "ok" : pct > 0 ? "warn" : "neutral";
  const toneMap = {
    ok: { fg: brand.ok, bg: brand.okSoft, border: brand.ok },
    warn: { fg: brand.warn, bg: brand.warnSoft, border: brand.warn },
    neutral: { fg: brand.forest, bg: brand.bgSection, border: brand.border },
  };
  const t = toneMap[tone];
  return (
    <span
      title={`${label} set on ${value} of ${total}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 7px",
        border: `1px solid ${t.border}`,
        background: t.bg,
        color: t.fg,
        borderRadius: radius.base,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {label} {value}/{total}
    </span>
  );
}

function EditPanel({ vertexCount, onSave, onCancel, saving }) {
  return (
    <>
      <Kicker style={{ marginBottom: 6 }}>Edit boundary</Kicker>
      <Body size="sm" style={{ marginBottom: 10, lineHeight: 1.5 }}>
        <strong style={{ color: brand.forest }}>Drag</strong> a handle to move it.
        Click a <strong style={{ color: brand.forest }}>midpoint</strong> to add a vertex.
        <strong style={{ color: brand.forest }}> Shift-click</strong> or right-click a vertex to delete.
      </Body>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 10px",
          border: `1px solid ${brand.border}`,
          background: brand.bgSection,
          borderRadius: radius.base,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: brand.muted,
          }}
        >
          Vertices
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: brand.forest }}>
          {vertexCount}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving || vertexCount < 3}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </>
  );
}

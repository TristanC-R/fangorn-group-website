import { useState, useMemo, useCallback, useRef } from "react";
import { brand, fonts, radius, inputStyle } from "../ui/theme.js";
import {
  Card,
  Button,
  Kicker,
  Body,
  SectionHeader,
  WorkspaceFrame,
  Stat,
  EmptyState,
  Subpanel,
  FieldLabel,
  Divider,
} from "../ui/primitives.jsx";
import { useLocalValue } from "../state/localStore.js";

const OBS_TYPES = [
  { key: "disease",       label: "Disease",       color: brand.danger },
  { key: "pest",          label: "Pest",          color: brand.warn },
  { key: "weed",          label: "Weed",          color: "#649A5C" },
  { key: "waterlogging",  label: "Waterlogging",  color: brand.info },
  { key: "lodging",       label: "Lodging",       color: "#8A7B5B" },
  { key: "wildlife",      label: "Wildlife",      color: "#2F6077" },
  { key: "general",       label: "General",       color: brand.muted },
];

const TYPE_MAP = Object.fromEntries(OBS_TYPES.map((t) => [t.key, t]));

function fieldName(f) {
  return f?.name || f?.id?.slice(0, 8) || "Field";
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function groupByDate(obs) {
  const groups = new Map();
  for (const o of obs) {
    const d = fmtDate(o.datetime);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(o);
  }
  return groups;
}

function resizeImage(file, maxWidth = 800) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        if (img.width <= maxWidth) { resolve(e.target.result); return; }
        const scale = maxWidth / img.width;
        const canvas = document.createElement("canvas");
        canvas.width = maxWidth;
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function toLocalDatetime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_OBS = [];

export function ObservationsWorkspace({ farm, fields }) {
  const farmId = farm?.id || "default";
  const [observations, setObservations] = useLocalValue("observations", farmId, EMPTY_OBS);

  const [formFieldId, setFormFieldId] = useState("");
  const [formType, setFormType] = useState("general");
  const [formDatetime, setFormDatetime] = useState(() => toLocalDatetime(new Date()));
  const [formNotes, setFormNotes] = useState("");
  const [formPhotos, setFormPhotos] = useState([]);
  const [formLocation, setFormLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const [filterField, setFilterField] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const fileRef = useRef(null);

  const fieldMap = useMemo(() => {
    const m = new Map();
    for (const f of fields || []) if (f?.id) m.set(f.id, f);
    return m;
  }, [fields]);

  const sorted = useMemo(() => {
    let list = Array.isArray(observations) ? [...observations] : [];
    if (filterField) list = list.filter((o) => o.fieldId === filterField);
    if (filterType) list = list.filter((o) => o.type === filterType);
    if (filterFrom) {
      const t = new Date(filterFrom).getTime();
      if (Number.isFinite(t)) list = list.filter((o) => new Date(o.datetime).getTime() >= t);
    }
    if (filterTo) {
      const t = new Date(filterTo).getTime() + 86_400_000;
      if (Number.isFinite(t)) list = list.filter((o) => new Date(o.datetime).getTime() < t);
    }
    list.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    return list;
  }, [observations, filterField, filterType, filterFrom, filterTo]);

  const grouped = useMemo(() => groupByDate(sorted), [sorted]);

  const stats = useMemo(() => {
    const all = Array.isArray(observations) ? observations : [];
    const weekAgo = Date.now() - 7 * 86_400_000;
    const thisWeek = all.filter((o) => new Date(o.datetime).getTime() >= weekAgo).length;
    const typeCounts = {};
    const fieldSet = new Set();
    for (const o of all) {
      typeCounts[o.type] = (typeCounts[o.type] || 0) + 1;
      if (o.fieldId) fieldSet.add(o.fieldId);
    }
    let mostType = null;
    let mostCount = 0;
    for (const [k, v] of Object.entries(typeCounts)) { if (v > mostCount) { mostType = k; mostCount = v; } }
    return { total: all.length, thisWeek, mostType, fieldsWithObs: fieldSet.size };
  }, [observations]);

  const handlePhotos = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const remaining = 3 - formPhotos.length;
    const toProcess = files.slice(0, remaining);
    try {
      const resized = await Promise.all(toProcess.map((f) => resizeImage(f)));
      setFormPhotos((prev) => [...prev, ...resized].slice(0, 3));
    } catch { /* silent */ }
    if (fileRef.current) fileRef.current.value = "";
  }, [formPhotos.length]);

  const removePhoto = useCallback((idx) => {
    setFormPhotos((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const getLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setFormLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  const resetForm = useCallback(() => {
    setFormFieldId("");
    setFormType("general");
    setFormDatetime(toLocalDatetime(new Date()));
    setFormNotes("");
    setFormPhotos([]);
    setFormLocation(null);
    setEditingId(null);
  }, []);

  const saveObservation = useCallback(() => {
    if (!formFieldId) return;
    setSaving(true);
    try {
      const entry = {
        id: editingId || crypto.randomUUID(),
        fieldId: formFieldId,
        type: formType,
        notes: formNotes,
        photos: formPhotos,
        datetime: new Date(formDatetime).toISOString(),
        location: formLocation,
      };
      setObservations((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        if (editingId) return list.map((o) => (o.id === editingId ? entry : o));
        return [entry, ...list];
      });
      resetForm();
    } finally { setSaving(false); }
  }, [formFieldId, formType, formNotes, formPhotos, formDatetime, formLocation, editingId, setObservations, resetForm]);

  const deleteObservation = useCallback((id) => {
    setObservations((prev) => (Array.isArray(prev) ? prev : []).filter((o) => o.id !== id));
    if (expandedId === id) setExpandedId(null);
  }, [setObservations, expandedId]);

  const startEdit = useCallback((obs) => {
    setEditingId(obs.id);
    setFormFieldId(obs.fieldId);
    setFormType(obs.type);
    setFormDatetime(toLocalDatetime(new Date(obs.datetime)));
    setFormNotes(obs.notes || "");
    setFormPhotos(obs.photos || []);
    setFormLocation(obs.location || null);
  }, []);

  const header = (
    <SectionHeader
      kicker="Field notes"
      title="Observations"
      description="Log what you see in the field \u2014 disease, pests, waterlogging, or anything else worth recording."
    />
  );

  return (
    <WorkspaceFrame header={header}>
      {/* Stats bar */}
      <div className="tilth-observations-stats" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, flex: "0 0 auto" }}>
        <Stat kicker="Total" value={stats.total} />
        <Stat kicker="This week" value={stats.thisWeek} />
        <Stat kicker="Most observed" value={stats.mostType ? (TYPE_MAP[stats.mostType]?.label || stats.mostType) : "\u2014"} />
        <Stat kicker="Fields logged" value={stats.fieldsWithObs} />
      </div>

      {/* Two-column layout */}
      <div className="tilth-observations-layout" style={{ display: "flex", gap: 14, flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* Left: timeline */}
        <div className="tilth-observations-timeline" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Filters */}
          <Card padding={10} style={{ marginBottom: 8, flex: "0 0 auto" }}>
            <div className="tilth-observations-filters" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
              <FilterSelect
                label="Field"
                value={filterField}
                onChange={setFilterField}
                options={[{ value: "", label: "All fields" }, ...(fields || []).map((f) => ({ value: f.id, label: fieldName(f) }))]}
              />
              <FilterSelect
                label="Type"
                value={filterType}
                onChange={setFilterType}
                options={[{ value: "", label: "All types" }, ...OBS_TYPES.map((t) => ({ value: t.key, label: t.label }))]}
              />
              <div>
                <FieldLabel>From</FieldLabel>
                <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} style={{ ...inputStyle, width: 130, padding: "6px 8px", fontSize: 12 }} />
              </div>
              <div>
                <FieldLabel>To</FieldLabel>
                <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} style={{ ...inputStyle, width: 130, padding: "6px 8px", fontSize: 12 }} />
              </div>
              {(filterField || filterType || filterFrom || filterTo) && (
                <Button variant="ghost" size="sm" onClick={() => { setFilterField(""); setFilterType(""); setFilterFrom(""); setFilterTo(""); }}>
                  Clear
                </Button>
              )}
            </div>
          </Card>

          {/* Observation list */}
          <div className="tilth-observations-list tilth-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {sorted.length === 0 ? (
              <EmptyState
                kicker="Observations"
                title="Nothing logged yet"
                description="Use the form on the right to record your first field observation."
              />
            ) : (
              Array.from(grouped.entries()).map(([dateLabel, items]) => (
                <div key={dateLabel} style={{ marginBottom: 14 }}>
                  <Kicker style={{ marginBottom: 6 }}>{dateLabel}</Kicker>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {items.map((obs) => {
                      const expanded = expandedId === obs.id;
                      const f = fieldMap.get(obs.fieldId);
                      return (
                        <Card
                          key={obs.id}
                          padding={12}
                          interactive
                          onClick={() => setExpandedId(expanded ? null : obs.id)}
                          style={{ cursor: "pointer" }}
                        >
                          <div className="tilth-observation-card-row" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            {obs.photos?.[0] && (
                              <img
                                src={obs.photos[0]}
                                alt=""
                                style={{ width: 48, height: 48, objectFit: "cover", borderRadius: radius.base, flexShrink: 0 }}
                              />
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="tilth-observation-card-meta" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                                <ObsTypePill type={obs.type} />
                                <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>
                                  {f ? fieldName(f) : obs.fieldId?.slice(0, 8)}
                                </span>
                                <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginLeft: "auto" }}>
                                  {fmtTime(obs.datetime)}
                                </span>
                              </div>
                              {obs.notes && (
                                <Body size="sm" style={{
                                  overflow: "hidden", textOverflow: "ellipsis",
                                  display: "-webkit-box", WebkitLineClamp: expanded ? 999 : 2,
                                  WebkitBoxOrient: "vertical", lineHeight: 1.45,
                                }}>
                                  {obs.notes}
                                </Body>
                              )}
                            </div>
                          </div>

                          {expanded && (
                            <div style={{ marginTop: 10, borderTop: `1px solid ${brand.borderSoft}`, paddingTop: 10 }}>
                              {obs.photos?.length > 0 && (
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                                  {obs.photos.map((p, i) => (
                                    <img key={i} src={p} alt="" style={{ width: 120, height: 90, objectFit: "cover", borderRadius: radius.base }} />
                                  ))}
                                </div>
                              )}
                              {obs.location && (
                                <Body size="sm" color={brand.muted} style={{ marginBottom: 6 }}>
                                  Location: {obs.location.lat.toFixed(5)}, {obs.location.lng.toFixed(5)}
                                </Body>
                              )}
                              <div className="tilth-observations-actions" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); startEdit(obs); }}>
                                  Edit
                                </Button>
                                <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); deleteObservation(obs.id); }}>
                                  Delete
                                </Button>
                              </div>
                            </div>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: log form */}
        <div className="tilth-observations-form-column tilth-scroll" style={{ flex: "0 0 320px", width: 320, overflowY: "auto" }}>
          <Card className="tilth-mobile-card" padding={16}>
            <Subpanel kicker="New observation" title={editingId ? "Editing" : "Log"}>
              {/* Field selector */}
              <FieldLabel htmlFor="obs-field">Field</FieldLabel>
              <select
                id="obs-field"
                value={formFieldId}
                onChange={(e) => setFormFieldId(e.target.value)}
                style={{ ...inputStyle, marginBottom: 12 }}
              >
                <option value="">Select a field\u2026</option>
                {(fields || []).map((f) => (
                  <option key={f.id} value={f.id}>{fieldName(f)}</option>
                ))}
              </select>

              {/* Type picker */}
              <FieldLabel>Type</FieldLabel>
              <div className="tilth-observations-type-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginBottom: 12 }}>
                {OBS_TYPES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setFormType(t.key)}
                    style={{
                      fontFamily: fonts.sans, fontSize: 10, fontWeight: formType === t.key ? 700 : 400,
                      padding: "6px 2px", borderRadius: radius.base, cursor: "pointer",
                      border: `2px solid ${formType === t.key ? t.color : brand.border}`,
                      background: formType === t.key ? `${t.color}18` : brand.white,
                      color: formType === t.key ? t.color : brand.bodySoft,
                      textTransform: "uppercase", letterSpacing: "0.06em",
                      transition: "border-color 120ms ease, background 120ms ease",
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Date/time */}
              <FieldLabel htmlFor="obs-datetime">Date &amp; time</FieldLabel>
              <input
                id="obs-datetime"
                type="datetime-local"
                value={formDatetime}
                onChange={(e) => setFormDatetime(e.target.value)}
                style={{ ...inputStyle, marginBottom: 12 }}
              />

              {/* Photos */}
              <FieldLabel>Photos ({formPhotos.length}/3)</FieldLabel>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                {formPhotos.map((src, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    <img src={src} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: radius.base }} />
                    <button
                      type="button"
                      className="tilth-icon-button"
                      onClick={() => removePhoto(i)}
                      style={{
                        position: "absolute", top: -4, right: -4, width: 18, height: 18,
                        borderRadius: "50%", border: "none", background: brand.danger, color: brand.white,
                        fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                        padding: 0, lineHeight: 1,
                      }}
                    >
                      \u00d7
                    </button>
                  </div>
                ))}
              </div>
              {formPhotos.length < 3 && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handlePhotos}
                    style={{ display: "none" }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} style={{ marginBottom: 12 }}>
                    Add photo
                  </Button>
                </>
              )}

              {/* Notes */}
              <FieldLabel htmlFor="obs-notes">Notes</FieldLabel>
              <textarea
                id="obs-notes"
                rows={3}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="What did you observe?"
                style={{ ...inputStyle, resize: "vertical", marginBottom: 12 }}
              />

              {/* Location */}
              <FieldLabel>Location</FieldLabel>
              {formLocation ? (
                <Body size="sm" style={{ marginBottom: 8 }}>
                  {formLocation.lat.toFixed(5)}, {formLocation.lng.toFixed(5)}
                  <button
                    type="button"
                    onClick={() => setFormLocation(null)}
                    style={{
                      marginLeft: 8, background: "none", border: "none",
                      color: brand.danger, cursor: "pointer", fontFamily: fonts.sans, fontSize: 11,
                    }}
                  >
                    Remove
                  </button>
                </Body>
              ) : (
                <Button variant="secondary" size="sm" onClick={getLocation} disabled={locating} style={{ marginBottom: 12 }}>
                  {locating ? "Locating\u2026" : "Use my location"}
                </Button>
              )}

              <Divider style={{ margin: "10px 0" }} />

              <div className="tilth-observations-actions" style={{ display: "flex", gap: 8 }}>
                <Button onClick={saveObservation} disabled={!formFieldId || saving}>
                  {editingId ? "Update observation" : "Save observation"}
                </Button>
                {editingId && (
                  <Button variant="ghost" onClick={resetForm}>Cancel</Button>
                )}
              </div>
            </Subpanel>
          </Card>
        </div>
      </div>
      <style>{`
        @media (max-width: 760px) {
          .tilth-observations-stats {
            grid-template-columns: 1fr 1fr !important;
          }
          .tilth-observations-layout {
            display: flex !important;
            flex-direction: column-reverse !important;
            gap: 12px !important;
            overflow-y: auto !important;
            min-height: 0 !important;
            padding-bottom: 18px !important;
          }
          .tilth-observations-timeline,
          .tilth-observations-form-column {
            width: 100% !important;
            flex: 0 0 auto !important;
            overflow: visible !important;
            min-height: auto !important;
          }
          .tilth-observations-list {
            flex: 0 0 auto !important;
            min-height: auto !important;
            overflow: visible !important;
          }
          .tilth-observations-filters {
            display: grid !important;
            grid-template-columns: 1fr !important;
            align-items: stretch !important;
          }
          .tilth-observations-filters > *,
          .tilth-observations-filters select,
          .tilth-observations-filters input {
            width: 100% !important;
          }
          .tilth-observations-type-grid {
            grid-template-columns: 1fr 1fr !important;
            gap: 8px !important;
          }
          .tilth-observations-type-grid button {
            min-height: 44px !important;
            border-radius: 8px !important;
            font-size: 11px !important;
          }
          .tilth-observation-card-row {
            display: grid !important;
            grid-template-columns: auto minmax(0, 1fr) !important;
            align-items: flex-start !important;
          }
          .tilth-observation-card-row img {
            width: 56px !important;
            height: 56px !important;
          }
          .tilth-observation-card-meta {
            display: grid !important;
            grid-template-columns: 1fr auto !important;
            align-items: start !important;
            gap: 6px !important;
          }
          .tilth-observation-card-meta > :first-child {
            grid-column: 1 / -1;
            width: max-content;
            max-width: 100%;
          }
          .tilth-observation-card-meta > :nth-child(2) {
            min-width: 0;
            overflow-wrap: anywhere;
          }
          .tilth-observations-actions {
            display: grid !important;
            grid-template-columns: 1fr !important;
            width: 100% !important;
          }
          .tilth-observations-actions button {
            width: 100% !important;
          }
          .tilth-observations-form-column .tilth-mobile-card {
            padding: 14px !important;
          }
        }
        @media (max-width: 430px) {
          .tilth-observations-stats,
          .tilth-observations-type-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

function ObsTypePill({ type }) {
  const def = TYPE_MAP[type] || TYPE_MAP.general;
  return (
    <span style={{
      display: "inline-block", fontFamily: fonts.mono, fontSize: 9,
      letterSpacing: "0.12em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: radius.base,
      border: `1px solid ${def.color}`,
      background: `${def.color}14`,
      color: def.color,
    }}>
      {def.label}
    </span>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, width: 140, padding: "6px 8px", fontSize: 12 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

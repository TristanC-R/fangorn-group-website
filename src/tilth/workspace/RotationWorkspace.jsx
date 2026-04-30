import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { brand, fonts, radius, inputStyle } from "../ui/theme.js";
import {
  WorkspaceFrame,
  SectionHeader,
  Button,
  Pill,
  EmptyState,
  Subpanel,
  Kicker,
  Body,
  Divider,
  FieldLabel,
} from "../ui/primitives.jsx";
import { useLocalValue } from "../state/localStore.js";
import { tilthStore } from "../state/localStore.js";
import { CROP_CATALOGUE, CROP_NAMES } from "../../lib/cropPhenology.js";

/* ── constants ──────────────────────────────────────────────────────── */

const FAMILY_COLORS = {
  cereal: "#104E3F",
  oilseed: "#8A7B5B",
  pulse: "#649A5C",
  root: "#C07C12",
  grass: "#8FB86A",
  cover: "#839788",
};

const SEASONS = ["autumn", "spring", "summer"];
const SEASON_LABELS = { autumn: "Aut", spring: "Spr", summer: "Sum" };
const SEASON_MONTHS = { autumn: 9, spring: 3, summer: 6 };

const N_RATES = {
  cereal: 180,
  oilseed: 180,
  pulse: 0,
  root: 120,
  grass: 100,
  cover: 0,
};

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR + i);

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function cropFamily(cropName) {
  return CROP_CATALOGUE[cropName]?.family || "cover";
}

function familyColor(cropName) {
  return FAMILY_COLORS[cropFamily(cropName)] || FAMILY_COLORS.cover;
}

function currentSeason() {
  const m = new Date().getMonth() + 1;
  if (m >= 9 || m <= 11) return "autumn";
  if (m >= 3 && m <= 5) return "spring";
  return "summer";
}

function getEntry(rotations, fieldId, year, season) {
  const arr = rotations[fieldId];
  if (!Array.isArray(arr)) return null;
  return arr.find((e) => e.year === year && e.season === season) || null;
}

/* ── rotation validation ─────────────────────────────────────────────── */

function validateField(entries) {
  if (!entries?.length) return [];
  const warnings = [];
  const sorted = [...entries].sort(
    (a, b) => a.year - b.year || SEASONS.indexOf(a.season) - SEASONS.indexOf(b.season),
  );

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];

    if (
      cur.crop?.toLowerCase().includes("wheat") &&
      prev.crop?.toLowerCase().includes("wheat")
    ) {
      warnings.push({
        year: cur.year,
        season: cur.season,
        type: "danger",
        msg: "Wheat after wheat — yield & disease risk",
      });
    }
  }

  let cerealRun = 0;
  for (const e of sorted) {
    if (cropFamily(e.crop) === "cereal") {
      cerealRun++;
      if (cerealRun >= 3) {
        warnings.push({
          year: e.year,
          season: e.season,
          type: "warn",
          msg: "3+ continuous cereals — break crop needed",
        });
      }
    } else {
      cerealRun = 0;
    }
  }

  const osrEntries = sorted.filter(
    (e) => e.crop?.toLowerCase().includes("oilseed rape"),
  );
  for (let i = 1; i < osrEntries.length; i++) {
    const gap = osrEntries[i].year - osrEntries[i - 1].year;
    if (gap < 4) {
      warnings.push({
        year: osrEntries[i].year,
        season: osrEntries[i].season,
        type: "danger",
        msg: `OSR returning after ${gap}yr gap — min 4yr break`,
      });
    }
  }

  for (const e of sorted) {
    if (cropFamily(e.crop) === "pulse") {
      warnings.push({
        year: e.year,
        season: e.season,
        type: "ok",
        msg: "Pulse crop — N fixation benefit",
      });
    }
  }

  return warnings;
}

function allWarnings(rotations) {
  const out = {};
  for (const fid of Object.keys(rotations)) {
    out[fid] = validateField(rotations[fid]);
  }
  return out;
}

function cellWarnings(warnings, fieldId, year, season) {
  const fw = warnings[fieldId];
  if (!fw) return [];
  return fw.filter((w) => w.year === year && w.season === season);
}

/* ── CSV export ──────────────────────────────────────────────────────── */

function exportCsv(rotations, fields) {
  const fieldMap = {};
  for (const f of fields) fieldMap[f.id] = f.name || f.id;

  const rows = [["Field", "Year", "Season", "Crop", "Notes"]];
  for (const fid of Object.keys(rotations)) {
    const entries = rotations[fid] || [];
    const sorted = [...entries].sort(
      (a, b) => a.year - b.year || SEASONS.indexOf(a.season) - SEASONS.indexOf(b.season),
    );
    for (const e of sorted) {
      rows.push([fieldMap[fid] || fid, e.year, e.season, e.crop, e.notes || ""]);
    }
  }

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "rotation_plan.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/* ── summary computations ────────────────────────────────────────────── */

function computeSummary(rotations, fields, warnings) {
  const fieldAreaMap = {};
  for (const f of fields) fieldAreaMap[f.id] = f.area_ha ?? f.areaHa ?? 10;

  const cropMixByYear = {};
  for (const yr of YEARS) {
    const mix = {};
    for (const fid of Object.keys(rotations)) {
      const entries = rotations[fid] || [];
      const yearEntries = entries.filter((e) => e.year === yr);
      const ha = fieldAreaMap[fid] || 10;
      for (const e of yearEntries) {
        if (!e.crop) continue;
        mix[e.crop] = (mix[e.crop] || 0) + ha;
      }
    }
    cropMixByYear[yr] = mix;
  }

  let totalViolations = 0;
  for (const fid of Object.keys(warnings)) {
    totalViolations += warnings[fid].filter((w) => w.type === "danger" || w.type === "warn").length;
  }

  const nBudget = {};
  for (const yr of YEARS) {
    let total = 0;
    for (const fid of Object.keys(rotations)) {
      const entries = (rotations[fid] || []).filter((e) => e.year === yr);
      const ha = fieldAreaMap[fid] || 10;
      for (const e of entries) {
        const fam = cropFamily(e.crop);
        total += (N_RATES[fam] ?? 100) * ha;
      }
    }
    nBudget[yr] = total;
  }

  const coverFields = new Set();
  for (const fid of Object.keys(rotations)) {
    const entries = rotations[fid] || [];
    if (entries.some((e) => cropFamily(e.crop) === "cover")) coverFields.add(fid);
  }
  const fieldsWithoutCover = fields.filter((f) => !coverFields.has(f.id));

  return { cropMixByYear, totalViolations, nBudget, fieldsWithoutCover };
}

/* ── sub-components ──────────────────────────────────────────────────── */

function InlineForm({ cropName, notes, onSave, onDelete, onClose }) {
  const [crop, setCrop] = useState(cropName || "");
  const [note, setNote] = useState(notes || "");
  const ref = useRef(null);

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        zIndex: 100,
        background: brand.bgCard,
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        padding: 12,
        width: 220,
        boxShadow: "0 12px 40px rgba(16,78,63,0.12)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <FieldLabel>Crop</FieldLabel>
      <select
        value={crop}
        onChange={(e) => setCrop(e.target.value)}
        style={{ ...inputStyle, fontSize: 12, padding: "8px 10px" }}
      >
        <option value="">Select crop…</option>
        {CROP_NAMES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <FieldLabel>Notes</FieldLabel>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional notes"
        style={{ ...inputStyle, fontSize: 12, padding: "8px 10px" }}
      />

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <Button
          size="sm"
          disabled={!crop}
          onClick={() => onSave(crop, note)}
          style={{ flex: 1 }}
        >
          Save
        </Button>
        {onDelete && (
          <Button size="sm" variant="danger" onClick={onDelete}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function WarningDots({ items }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", gap: 3, marginTop: 2 }}>
      {items.map((w, i) => (
        <span
          key={i}
          title={w.msg}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background:
              w.type === "danger"
                ? brand.danger
                : w.type === "warn"
                  ? brand.warn
                  : brand.ok,
            flexShrink: 0,
          }}
        />
      ))}
    </div>
  );
}

function CropCell({ entry, warnings, onOpen }) {
  if (!entry) {
    return (
      <div
        onClick={onOpen}
        style={{
          width: "100%",
          height: "100%",
          minHeight: 36,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.base,
          transition: "background 120ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = brand.bgSection)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span
          style={{
            fontSize: 14,
            color: brand.border,
            fontWeight: 300,
          }}
        >
          +
        </span>
      </div>
    );
  }

  const bg = familyColor(entry.crop);
  return (
    <div
      onClick={onOpen}
      style={{
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        width: "100%",
      }}
    >
      <span
        title={`${entry.crop}${entry.notes ? ` — ${entry.notes}` : ""}`}
        style={{
          display: "inline-block",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          padding: "3px 6px",
          borderRadius: radius.base,
          background: bg,
          color: "#fff",
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        {entry.crop}
      </span>
      <WarningDots items={warnings} />
    </div>
  );
}

function MiniBar({ mix, maxHa }) {
  const entries = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <Body size="sm" color={brand.muted}>—</Body>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {entries.map(([crop, ha]) => (
        <div key={crop} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: Math.max(4, (ha / maxHa) * 80),
              height: 10,
              borderRadius: 2,
              background: familyColor(crop),
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: fonts.sans,
              fontSize: 10,
              color: brand.body,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 120,
            }}
          >
            {crop} ({Math.round(ha)} ha)
          </span>
        </div>
      ))}
    </div>
  );
}

function SummaryPanel({ rotations, fields, warnings }) {
  const { cropMixByYear, totalViolations, nBudget, fieldsWithoutCover } = useMemo(
    () => computeSummary(rotations, fields, warnings),
    [rotations, fields, warnings],
  );

  const allHa = Object.values(cropMixByYear).flatMap((m) => Object.values(m));
  const maxHa = Math.max(1, ...allHa);

  return (
    <div
      style={{
        width: 280,
        minWidth: 280,
        height: "100%",
        overflowY: "auto",
        borderLeft: `1px solid ${brand.border}`,
        padding: "14px 16px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      <Subpanel kicker="Summary" title="Rotation health">
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 6,
          }}
        >
          <Pill tone={totalViolations ? "danger" : "ok"}>
            {totalViolations} violation{totalViolations !== 1 ? "s" : ""}
          </Pill>
        </div>
      </Subpanel>

      <Divider />

      <Subpanel kicker="Crop mix" title="Area by year">
        {YEARS.map((yr) => (
          <div key={yr} style={{ marginBottom: 10 }}>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: brand.muted,
                letterSpacing: "0.12em",
                marginBottom: 4,
              }}
            >
              {yr}
            </div>
            <MiniBar mix={cropMixByYear[yr] || {}} maxHa={maxHa} />
          </div>
        ))}
      </Subpanel>

      <Divider />

      <Subpanel kicker="Nitrogen" title="N budget projection">
        {YEARS.map((yr) => (
          <div
            key={yr}
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: fonts.sans,
              fontSize: 12,
              color: brand.body,
              padding: "3px 0",
            }}
          >
            <span>{yr}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11 }}>
              {nBudget[yr] ? `${Math.round(nBudget[yr]).toLocaleString()} kg N` : "—"}
            </span>
          </div>
        ))}
      </Subpanel>

      <Divider />

      <Subpanel kicker="SFI Compatibility" title="Cover crop check">
        {fieldsWithoutCover.length === 0 ? (
          <Pill tone="ok">All fields have cover planned</Pill>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Body size="sm" color={brand.warn}>
              SAM2 cover crop required on {fieldsWithoutCover.length} field
              {fieldsWithoutCover.length !== 1 ? "s" : ""}:
            </Body>
            {fieldsWithoutCover.slice(0, 6).map((f) => (
              <span
                key={f.id}
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 11,
                  color: brand.body,
                }}
              >
                • {f.name || f.id}
              </span>
            ))}
            {fieldsWithoutCover.length > 6 && (
              <span
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 11,
                  color: brand.muted,
                }}
              >
                + {fieldsWithoutCover.length - 6} more
              </span>
            )}
          </div>
        )}
      </Subpanel>
    </div>
  );
}

/* ── main component ──────────────────────────────────────────────────── */

export function RotationWorkspace({ farm, fields }) {
  const farmId = farm?.id;
  const [rotations, setRotations] = useLocalValue("rotations", farmId, {});
  const [editCell, setEditCell] = useState(null);

  const plantings = useMemo(() => {
    if (!farmId) return {};
    return tilthStore.loadPlantings(farmId);
  }, [farmId]);

  const merged = useMemo(() => {
    const base = { ...rotations };
    if (!fields) return base;
    const now = new Date();
    const yr = now.getFullYear();
    const season = currentSeason();

    for (const f of fields) {
      const pArr = plantings[f.id];
      if (!Array.isArray(pArr) || !pArr.length) continue;
      const current = pArr[0];
      if (!current?.crop) continue;

      if (!base[f.id]) base[f.id] = [];
      const exists = base[f.id].some((e) => e.year === yr && e.season === season);
      if (!exists) {
        base[f.id] = [
          ...base[f.id],
          {
            id: uid(),
            crop: current.crop,
            year: yr,
            season,
            startMonth: SEASON_MONTHS[season],
            notes: "Auto-populated from planting",
          },
        ];
      }
    }
    return base;
  }, [rotations, plantings, fields]);

  const warnings = useMemo(() => allWarnings(merged), [merged]);

  const saveEntry = useCallback(
    (fieldId, year, season, crop, notes) => {
      setRotations((prev) => {
        const arr = Array.isArray(prev[fieldId]) ? [...prev[fieldId]] : [];
        const idx = arr.findIndex((e) => e.year === year && e.season === season);
        if (idx >= 0) {
          arr[idx] = { ...arr[idx], crop, notes };
        } else {
          arr.push({
            id: uid(),
            crop,
            year,
            season,
            startMonth: SEASON_MONTHS[season],
            notes,
          });
        }
        return { ...prev, [fieldId]: arr };
      });
      setEditCell(null);
    },
    [setRotations],
  );

  const deleteEntry = useCallback(
    (fieldId, year, season) => {
      setRotations((prev) => {
        const arr = (prev[fieldId] || []).filter(
          (e) => !(e.year === year && e.season === season),
        );
        return { ...prev, [fieldId]: arr };
      });
      setEditCell(null);
    },
    [setRotations],
  );

  if (!fields || !fields.length) {
    return (
      <WorkspaceFrame>
        <EmptyState
          kicker="Rotation planner"
          title="No fields yet"
          description="Add fields in the Fields workspace first, then come back to plan your rotations."
        />
      </WorkspaceFrame>
    );
  }

  const isEditing = (fid, yr, s) =>
    editCell && editCell.fieldId === fid && editCell.year === yr && editCell.season === s;

  const FIELD_COL = 180;
  const CELL_W = 78;
  const HEADER_H = 52;
  const ROW_H = 50;

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Planning"
          title="Rotation planner"
          description="Map out your cropping plan five years ahead. Visualise rotation rules, nitrogen budgets, and SFI cover-crop requirements at a glance."
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => exportCsv(merged, fields)}
            >
              Export cropping plan
            </Button>
          }
        />
      }
    >
      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
        {/* gantt grid */}
        <div
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "auto",
            border: `1px solid ${brand.border}`,
            borderRadius: radius.base,
            background: brand.bgCard,
          }}
        >
          <div style={{ display: "inline-flex", flexDirection: "column", minWidth: "100%" }}>
            {/* header row */}
            <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 10, background: brand.bgCard }}>
              {/* field label column header */}
              <div
                style={{
                  width: FIELD_COL,
                  minWidth: FIELD_COL,
                  height: HEADER_H,
                  position: "sticky",
                  left: 0,
                  zIndex: 11,
                  background: brand.bgCard,
                  borderBottom: `1px solid ${brand.border}`,
                  borderRight: `1px solid ${brand.border}`,
                  display: "flex",
                  alignItems: "flex-end",
                  padding: "0 12px 8px",
                  boxSizing: "border-box",
                }}
              >
                <Kicker>Field</Kicker>
              </div>

              {/* year / season headers */}
              {YEARS.map((yr) => (
                <div key={yr} style={{ display: "flex", flexDirection: "column" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      fontWeight: 600,
                      color: yr === CURRENT_YEAR ? brand.forest : brand.bodySoft,
                      letterSpacing: "0.08em",
                      borderBottom: `1px solid ${brand.borderSoft}`,
                      padding: "8px 0 4px",
                      width: CELL_W * 3,
                      background: yr === CURRENT_YEAR ? brand.bgSection : "transparent",
                    }}
                  >
                    {yr}
                  </div>
                  <div style={{ display: "flex" }}>
                    {SEASONS.map((s) => (
                      <div
                        key={s}
                        style={{
                          width: CELL_W,
                          textAlign: "center",
                          fontFamily: fonts.mono,
                          fontSize: 9,
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                          color: brand.muted,
                          padding: "6px 0 8px",
                          borderBottom: `1px solid ${brand.border}`,
                          borderRight: `1px solid ${brand.borderSoft}`,
                          background: yr === CURRENT_YEAR ? brand.bgSection : "transparent",
                          boxSizing: "border-box",
                        }}
                      >
                        {SEASON_LABELS[s]}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* data rows */}
            {fields.map((field, fi) => {
              const fid = field.id;
              return (
                <div
                  key={fid}
                  style={{
                    display: "flex",
                    borderBottom:
                      fi < fields.length - 1 ? `1px solid ${brand.borderSoft}` : "none",
                  }}
                >
                  {/* field label */}
                  <div
                    style={{
                      width: FIELD_COL,
                      minWidth: FIELD_COL,
                      height: ROW_H,
                      position: "sticky",
                      left: 0,
                      zIndex: 5,
                      background: brand.bgCard,
                      borderRight: `1px solid ${brand.border}`,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      padding: "0 12px",
                      boxSizing: "border-box",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 12,
                        fontWeight: 600,
                        color: brand.forest,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {field.name || fid}
                    </div>
                    {(field.area_ha ?? field.areaHa) != null && (
                      <div
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 9,
                          color: brand.muted,
                          marginTop: 2,
                          letterSpacing: "0.06em",
                        }}
                      >
                        {Math.round((field.area_ha ?? field.areaHa) * 10) / 10} ha
                      </div>
                    )}
                  </div>

                  {/* season cells */}
                  {YEARS.map((yr) =>
                    SEASONS.map((s) => {
                      const entry = getEntry(merged, fid, yr, s);
                      const cw = cellWarnings(warnings, fid, yr, s);
                      const editing = isEditing(fid, yr, s);

                      return (
                        <div
                          key={`${yr}-${s}`}
                          style={{
                            width: CELL_W,
                            minWidth: CELL_W,
                            height: ROW_H,
                            borderRight: `1px solid ${brand.borderSoft}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "4px 3px",
                            boxSizing: "border-box",
                            position: "relative",
                            background:
                              yr === CURRENT_YEAR
                                ? "rgba(195,211,196,0.12)"
                                : "transparent",
                          }}
                        >
                          <CropCell
                            entry={entry}
                            warnings={cw}
                            onOpen={() =>
                              setEditCell(
                                editing ? null : { fieldId: fid, year: yr, season: s },
                              )
                            }
                          />
                          {editing && (
                            <InlineForm
                              cropName={entry?.crop || ""}
                              notes={entry?.notes || ""}
                              onSave={(crop, notes) => saveEntry(fid, yr, s, crop, notes)}
                              onDelete={
                                entry ? () => deleteEntry(fid, yr, s) : undefined
                              }
                              onClose={() => setEditCell(null)}
                            />
                          )}
                        </div>
                      );
                    }),
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* summary sidebar */}
        <SummaryPanel rotations={merged} fields={fields} warnings={warnings} />
      </div>
    </WorkspaceFrame>
  );
}

export default RotationWorkspace;

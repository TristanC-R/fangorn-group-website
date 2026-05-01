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
import { COMMODITY_PRICES } from "../../lib/costAnalysis.js";

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
const STATUS_OPTIONS = ["planned", "drilled", "growing", "harvested", "failed"];
const STATUS_LABELS = {
  planned: "Planned",
  drilled: "Drilled",
  growing: "Growing",
  harvested: "Harvested",
  failed: "Failed",
};

const N_RATES = {
  cereal: 180,
  oilseed: 180,
  pulse: 0,
  root: 120,
  grass: 100,
  cover: 0,
};

const VARIABLE_COSTS = {
  cereal: 520,
  oilseed: 620,
  pulse: 360,
  root: 1_250,
  grass: 240,
  cover: 80,
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
  if (m >= 9 || m <= 2) return "autumn";
  if (m >= 3 && m <= 5) return "spring";
  return "summer";
}

function getEntry(rotations, fieldId, year, season) {
  const arr = rotations[fieldId];
  if (!Array.isArray(arr)) return null;
  return arr.find((e) => e.year === year && e.season === season) || null;
}

function approxHectares(field) {
  const explicit = Number(field?.area_ha ?? field?.areaHa ?? field?.hectares);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const ring = field?.boundary;
  if (!Array.isArray(ring) || ring.length < 3) return 10;
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += (Number(a.lng) || 0) * (Number(b.lat) || 0) - (Number(b.lng) || 0) * (Number(a.lat) || 0);
  }
  const sqDeg = Math.abs(sum) / 2;
  const midLat = ring.reduce((acc, p) => acc + (Number(p.lat) || 0), 0) / ring.length;
  return Math.max(0, (sqDeg * 111_132 * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 10_000);
}

function dateForSeason(year, season) {
  return `${year}-${String(SEASON_MONTHS[season] || 3).padStart(2, "0")}-15`;
}

function rotationEntryPatch({
  crop,
  status,
  variety,
  plantingDate,
  harvestDate,
  targetYield,
  expectedPrice,
  variableCostPerHa,
  nitrogenKgHa,
  complianceUse,
  notes,
}) {
  const clean = {
    crop,
    status: status || "planned",
    variety: variety?.trim() || "",
    plantingDate: plantingDate || "",
    harvestDate: harvestDate || "",
    targetYield: targetYield === "" ? null : Number(targetYield),
    expectedPrice: expectedPrice === "" ? null : Number(expectedPrice),
    variableCostPerHa: variableCostPerHa === "" ? null : Number(variableCostPerHa),
    nitrogenKgHa: nitrogenKgHa === "" ? null : Number(nitrogenKgHa),
    complianceUse: complianceUse?.trim() || "",
    notes: notes?.trim() || "",
  };
  for (const key of ["targetYield", "expectedPrice", "variableCostPerHa", "nitrogenKgHa"]) {
    if (!Number.isFinite(clean[key])) clean[key] = null;
  }
  return clean;
}

function projectedMargin(entry, hectares = 0) {
  const yieldTHa = Number(entry?.targetYield);
  const price = Number(entry?.expectedPrice ?? COMMODITY_PRICES[entry?.crop]);
  const cost = Number(entry?.variableCostPerHa ?? VARIABLE_COSTS[cropFamily(entry?.crop)]);
  if (!Number.isFinite(yieldTHa) || !Number.isFinite(price)) return null;
  const marginPerHa = yieldTHa * price - (Number.isFinite(cost) ? cost : 0);
  return {
    revenue: yieldTHa * price * hectares,
    variableCost: (Number.isFinite(cost) ? cost : 0) * hectares,
    margin: marginPerHa * hectares,
    marginPerHa,
  };
}

function currentRotationEntry(entries) {
  const currentIdx = SEASONS.indexOf(currentSeason());
  const usable = (entries || [])
    .filter((entry) => {
      if (entry.year !== CURRENT_YEAR || !entry.crop || entry.status === "failed") return false;
      if (["drilled", "growing", "harvested"].includes(entry.status)) return true;
      return SEASONS.indexOf(entry.season) <= currentIdx;
    })
    .sort((a, b) => SEASONS.indexOf(b.season) - SEASONS.indexOf(a.season));
  return usable.find((entry) => ["drilled", "growing", "harvested"].includes(entry.status)) || usable[0] || null;
}

function syncCurrentPlantingFromRotation(farmId, fieldId, entries) {
  if (!farmId || !fieldId) return;
  const current = currentRotationEntry(entries);
  if (!current?.crop) return;

  const all = tilthStore.loadPlantings(farmId);
  const existing = Array.isArray(all[fieldId]) ? [...all[fieldId]] : [];
  const sourceKey = `rotation:${fieldId}:${current.year}`;
  const planting = {
    id: existing.find((item) => item.sourceKey === sourceKey)?.id || sourceKey,
    sourceKey,
    source: "rotation",
    rotationEntryId: current.id,
    crop: current.crop,
    cropYear: current.year,
    season: current.season,
    status: current.status || "planned",
    variety: current.variety || "",
    plantingDate: current.plantingDate || dateForSeason(current.year, current.season),
    harvestDate: current.harvestDate || "",
    targetYield: current.targetYield ?? null,
    expectedPrice: current.expectedPrice ?? null,
    variableCostPerHa: current.variableCostPerHa ?? null,
    nitrogenKgHa: current.nitrogenKgHa ?? null,
    complianceUse: current.complianceUse || "",
    notes: current.notes || "Synced from rotation plan",
    updatedAt: new Date().toISOString(),
    createdAt: existing.find((item) => item.sourceKey === sourceKey)?.createdAt || new Date().toISOString(),
  };
  all[fieldId] = [planting, ...existing.filter((item) => item.sourceKey !== sourceKey && item.id !== planting.id)];
  tilthStore.savePlantings(farmId, all);

  const attrs = tilthStore.loadFieldAttrs(farmId);
  attrs[fieldId] = {
    ...(attrs[fieldId] || {}),
    crop: current.crop,
    cropYear: current.year,
    rotationStatus: current.status || "planned",
    variety: current.variety || "",
    targetYield: current.targetYield ?? attrs[fieldId]?.targetYield,
    expectedPrice: current.expectedPrice ?? attrs[fieldId]?.expectedPrice,
    variableCostPerHa: current.variableCostPerHa ?? attrs[fieldId]?.variableCostPerHa,
    nitrogenKgHa: current.nitrogenKgHa ?? attrs[fieldId]?.nitrogenKgHa,
    complianceUse: current.complianceUse || attrs[fieldId]?.complianceUse || "",
  };
  tilthStore.saveFieldAttrs(farmId, attrs);
}

function removeRotationPlanting(farmId, fieldId) {
  if (!farmId || !fieldId) return;
  const all = tilthStore.loadPlantings(farmId);
  const existing = Array.isArray(all[fieldId]) ? all[fieldId] : [];
  const next = existing.filter((item) => item.source !== "rotation" && item.sourceKey !== `rotation:${fieldId}:${CURRENT_YEAR}`);
  if (next.length !== existing.length) {
    all[fieldId] = next;
    tilthStore.savePlantings(farmId, all);
  }
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
    if (!e.crop) continue;
    if (cropFamily(e.crop) === "pulse") {
      warnings.push({
        year: e.year,
        season: e.season,
        type: "ok",
        msg: "Pulse crop — N fixation benefit",
      });
    }
    if (e.status === "planned" && e.year === CURRENT_YEAR) {
      warnings.push({
        year: e.year,
        season: e.season,
        type: "warn",
        msg: "Current crop is still marked planned — confirm drilling/growing status",
      });
    }
    if (!e.plantingDate && e.year === CURRENT_YEAR) {
      warnings.push({
        year: e.year,
        season: e.season,
        type: "warn",
        msg: "Missing drilling/planting date — crop stage analysis will be weaker",
      });
    }
    if (e.targetYield != null && e.expectedPrice != null && e.variableCostPerHa == null) {
      warnings.push({
        year: e.year,
        season: e.season,
        type: "warn",
        msg: "Add variable cost/ha to improve margin projections",
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

  const rows = [[
    "Field",
    "Year",
    "Season",
    "Crop",
    "Status",
    "Variety",
    "Planting date",
    "Harvest date",
    "Target yield t/ha",
    "Expected price",
    "Variable cost/ha",
    "Nitrogen kg/ha",
    "Compliance use",
    "Notes",
  ]];
  for (const fid of Object.keys(rotations)) {
    const entries = rotations[fid] || [];
    const sorted = [...entries].sort(
      (a, b) => a.year - b.year || SEASONS.indexOf(a.season) - SEASONS.indexOf(b.season),
    );
    for (const e of sorted) {
      rows.push([
        fieldMap[fid] || fid,
        e.year,
        e.season,
        e.crop,
        e.status || "",
        e.variety || "",
        e.plantingDate || "",
        e.harvestDate || "",
        e.targetYield ?? "",
        e.expectedPrice ?? "",
        e.variableCostPerHa ?? "",
        e.nitrogenKgHa ?? "",
        e.complianceUse || "",
        e.notes || "",
      ]);
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
  for (const f of fields) fieldAreaMap[f.id] = approxHectares(f);

  const cropMixByYear = {};
  const marginByYear = {};
  const missingAnalysisInputs = [];
  for (const yr of YEARS) {
    const mix = {};
    const margin = { revenue: 0, variableCost: 0, margin: 0, fields: 0, completeFields: 0 };
    for (const fid of Object.keys(rotations)) {
      const entries = rotations[fid] || [];
      const yearEntries = entries.filter((e) => e.year === yr);
      const ha = fieldAreaMap[fid] || 10;
      for (const e of yearEntries) {
        if (!e.crop) continue;
        mix[e.crop] = (mix[e.crop] || 0) + ha;
        margin.fields += 1;
        const projected = projectedMargin(e, ha);
        if (projected) {
          margin.revenue += projected.revenue;
          margin.variableCost += projected.variableCost;
          margin.margin += projected.margin;
          margin.completeFields += 1;
        } else if (yr === CURRENT_YEAR) {
          missingAnalysisInputs.push({ fieldId: fid, crop: e.crop });
        }
      }
    }
    cropMixByYear[yr] = mix;
    marginByYear[yr] = margin;
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

  const currentEntries = Object.entries(rotations)
    .map(([fieldId, entries]) => ({ fieldId, entry: currentRotationEntry(entries || []) }))
    .filter((row) => row.entry?.crop);

  return {
    cropMixByYear,
    totalViolations,
    nBudget,
    fieldsWithoutCover,
    marginByYear,
    missingAnalysisInputs,
    currentEntries,
  };
}

/* ── sub-components ──────────────────────────────────────────────────── */

function InlineForm({ entry, year, season, onSave, onDelete, onClose }) {
  const [crop, setCrop] = useState(entry?.crop || "");
  const [status, setStatus] = useState(entry?.status || "planned");
  const [variety, setVariety] = useState(entry?.variety || "");
  const [plantingDate, setPlantingDate] = useState(entry?.plantingDate || dateForSeason(year, season));
  const [harvestDate, setHarvestDate] = useState(entry?.harvestDate || "");
  const [targetYield, setTargetYield] = useState(entry?.targetYield ?? "");
  const [expectedPrice, setExpectedPrice] = useState(entry?.expectedPrice ?? "");
  const [variableCostPerHa, setVariableCostPerHa] = useState(entry?.variableCostPerHa ?? "");
  const [nitrogenKgHa, setNitrogenKgHa] = useState(entry?.nitrogenKgHa ?? "");
  const [complianceUse, setComplianceUse] = useState(entry?.complianceUse || "");
  const [note, setNote] = useState(entry?.notes || "");
  const ref = useRef(null);

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    if (!crop) return;
    if (expectedPrice === "" && COMMODITY_PRICES[crop] != null) setExpectedPrice(COMMODITY_PRICES[crop]);
    if (variableCostPerHa === "") setVariableCostPerHa(VARIABLE_COSTS[cropFamily(crop)] ?? "");
    if (nitrogenKgHa === "") setNitrogenKgHa(N_RATES[cropFamily(crop)] ?? "");
  }, [crop, expectedPrice, nitrogenKgHa, variableCostPerHa]);

  return (
    <div
      ref={ref}
      className="tilth-rotation-inline-form tilth-scroll"
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        zIndex: 100,
        background: brand.bgCard,
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        padding: 12,
        width: 300,
        maxWidth: "calc(100vw - 32px)",
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label>
          <FieldLabel>Status</FieldLabel>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 10px", width: "100%" }}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>{STATUS_LABELS[option]}</option>
            ))}
          </select>
        </label>
        <label>
          <FieldLabel>Variety</FieldLabel>
          <input
            type="text"
            value={variety}
            onChange={(e) => setVariety(e.target.value)}
            placeholder="e.g. Extase"
            style={{ ...inputStyle, fontSize: 12, padding: "8px 10px", width: "100%" }}
          />
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label>
          <FieldLabel>Drilled / planted</FieldLabel>
          <input
            type="date"
            value={plantingDate}
            onChange={(e) => setPlantingDate(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 10px", width: "100%" }}
          />
        </label>
        <label>
          <FieldLabel>Harvest</FieldLabel>
          <input
            type="date"
            value={harvestDate}
            onChange={(e) => setHarvestDate(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 10px", width: "100%" }}
          />
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
        <label>
          <FieldLabel>t/ha</FieldLabel>
          <input
            type="number"
            min="0"
            step="0.1"
            value={targetYield}
            onChange={(e) => setTargetYield(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 8px", width: "100%" }}
          />
        </label>
        <label>
          <FieldLabel>£/t</FieldLabel>
          <input
            type="number"
            min="0"
            step="1"
            value={expectedPrice}
            onChange={(e) => setExpectedPrice(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 8px", width: "100%" }}
          />
        </label>
        <label>
          <FieldLabel>£/ha</FieldLabel>
          <input
            type="number"
            min="0"
            step="1"
            value={variableCostPerHa}
            onChange={(e) => setVariableCostPerHa(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 8px", width: "100%" }}
          />
        </label>
        <label>
          <FieldLabel>N kg</FieldLabel>
          <input
            type="number"
            min="0"
            step="1"
            value={nitrogenKgHa}
            onChange={(e) => setNitrogenKgHa(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: "8px 8px", width: "100%" }}
          />
        </label>
      </div>

      <FieldLabel>Compliance / scheme use</FieldLabel>
      <input
        type="text"
        value={complianceUse}
        onChange={(e) => setComplianceUse(e.target.value)}
        placeholder="e.g. SFI cover, stewardship, NVZ"
        style={{ ...inputStyle, fontSize: 12, padding: "8px 10px" }}
      />

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
          onClick={() =>
            onSave(
              rotationEntryPatch({
                crop,
                status,
                variety,
                plantingDate,
                harvestDate,
                targetYield,
                expectedPrice,
                variableCostPerHa,
                nitrogenKgHa,
                complianceUse,
                notes: note,
              }),
            )
          }
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
  const margin = projectedMargin(entry, 1);
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
        title={[
          entry.crop,
          entry.variety,
          STATUS_LABELS[entry.status],
          entry.plantingDate ? `Planted ${entry.plantingDate}` : "",
          margin ? `Projected ${Math.round(margin.marginPerHa).toLocaleString()} per ha` : "",
          entry.notes,
        ].filter(Boolean).join(" - ")}
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
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 8,
          color: brand.muted,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.status ? STATUS_LABELS[entry.status] : "Plan"}
        {margin ? ` · £${Math.round(margin.marginPerHa).toLocaleString()}/ha` : ""}
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
  const {
    cropMixByYear,
    totalViolations,
    nBudget,
    fieldsWithoutCover,
    marginByYear,
    missingAnalysisInputs,
    currentEntries,
  } = useMemo(
    () => computeSummary(rotations, fields, warnings),
    [rotations, fields, warnings],
  );

  const allHa = Object.values(cropMixByYear).flatMap((m) => Object.values(m));
  const maxHa = Math.max(1, ...allHa);

  return (
    <div
      className="tilth-rotation-summary tilth-scroll"
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
          <Pill tone={currentEntries.length === fields.length ? "ok" : "warn"}>
            {currentEntries.length}/{fields.length} current crops
          </Pill>
        </div>
        <Body size="sm" color={brand.muted}>
          Current crop-year plans feed crop health, notifications, finance, and compliance checks.
        </Body>
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

      <Subpanel kicker="Finance" title="Margin projection">
        {YEARS.map((yr) => {
          const row = marginByYear[yr];
          const value = row?.completeFields ? row.margin : null;
          return (
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
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: value == null ? brand.muted : value >= 0 ? brand.ok : brand.danger }}>
                {value == null ? "Add yield/price" : `£${Math.round(value).toLocaleString()}`}
              </span>
            </div>
          );
        })}
        {missingAnalysisInputs.length ? (
          <Body size="sm" color={brand.muted} style={{ marginTop: 6 }}>
            Add yield, price, and cost to {missingAnalysisInputs.length} current crop
            {missingAnalysisInputs.length !== 1 ? "s" : ""} for better margins.
          </Body>
        ) : null}
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
            status: current.status || "growing",
            variety: current.variety || "",
            plantingDate: current.plantingDate || dateForSeason(yr, season),
            harvestDate: current.harvestDate || "",
            targetYield: current.targetYield ?? null,
            expectedPrice: current.expectedPrice ?? COMMODITY_PRICES[current.crop] ?? null,
            variableCostPerHa: current.variableCostPerHa ?? VARIABLE_COSTS[cropFamily(current.crop)] ?? null,
            nitrogenKgHa: current.nitrogenKgHa ?? N_RATES[cropFamily(current.crop)] ?? null,
            complianceUse: current.complianceUse || "",
            notes: "Auto-populated from planting",
          },
        ];
      }
    }
    return base;
  }, [rotations, plantings, fields]);

  const warnings = useMemo(() => allWarnings(merged), [merged]);

  const saveEntry = useCallback(
    (fieldId, year, season, patch) => {
      const arr = Array.isArray(rotations[fieldId]) ? [...rotations[fieldId]] : [];
      const idx = arr.findIndex((e) => e.year === year && e.season === season);
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], ...patch, year, season, startMonth: SEASON_MONTHS[season] };
      } else {
        arr.push({
          id: uid(),
          ...patch,
          year,
          season,
          startMonth: SEASON_MONTHS[season],
        });
      }
      const next = { ...rotations, [fieldId]: arr };
      setRotations(next);
      syncCurrentPlantingFromRotation(farmId, fieldId, arr);
      setEditCell(null);
    },
    [farmId, rotations, setRotations],
  );

  const deleteEntry = useCallback(
    (fieldId, year, season) => {
      const arr = (rotations[fieldId] || []).filter(
        (e) => !(e.year === year && e.season === season),
      );
      setRotations({ ...rotations, [fieldId]: arr });
      if (currentRotationEntry(arr)) syncCurrentPlantingFromRotation(farmId, fieldId, arr);
      else removeRotationPlanting(farmId, fieldId);
      setEditCell(null);
    },
    [farmId, rotations, setRotations],
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
  const CELL_W = 102;
  const HEADER_H = 52;
  const ROW_H = 62;

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
      <div className="tilth-rotation-layout" style={{ display: "flex", flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
        {/* gantt grid */}
        <div
          className="tilth-rotation-grid"
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
                className="tilth-rotation-field-header"
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
                    className="tilth-rotation-year-header"
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
                        className="tilth-rotation-season-header"
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
                    className="tilth-rotation-field-label"
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
                            className="tilth-rotation-season-cell"
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
                              entry={entry}
                              year={yr}
                              season={s}
                              onSave={(patch) => saveEntry(fid, yr, s, patch)}
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
      <style>{`
        @media (max-width: 760px) {
          .tilth-rotation-layout {
            flex-direction: column !important;
            overflow-y: auto !important;
            gap: 12px !important;
            padding-bottom: 18px !important;
          }
          .tilth-rotation-grid {
            flex: 0 0 auto !important;
            max-height: 56dvh !important;
            min-height: 320px !important;
          }
          .tilth-rotation-field-header,
          .tilth-rotation-field-label {
            width: 104px !important;
            min-width: 104px !important;
            padding-left: 8px !important;
            padding-right: 8px !important;
          }
          .tilth-rotation-field-label > div:first-child {
            font-size: 11px !important;
          }
          .tilth-rotation-season-cell {
            width: 86px !important;
            min-width: 86px !important;
          }
          .tilth-rotation-year-header {
            width: 258px !important;
          }
          .tilth-rotation-season-header {
            width: 86px !important;
          }
          .tilth-rotation-summary {
            width: 100% !important;
            min-width: 0 !important;
            height: auto !important;
            overflow: visible !important;
            border-left: 0 !important;
            border-top: 1px solid ${brand.border} !important;
            padding: 14px 4px 0 !important;
          }
          .tilth-rotation-inline-form {
            position: fixed !important;
            left: max(10px, env(safe-area-inset-left, 0px)) !important;
            right: max(10px, env(safe-area-inset-right, 0px)) !important;
            bottom: max(10px, env(safe-area-inset-bottom, 0px)) !important;
            top: auto !important;
            transform: none !important;
            z-index: 2400 !important;
            width: auto !important;
            max-width: none !important;
            max-height: min(84dvh, 720px) !important;
            overflow-y: auto !important;
            border-radius: 16px 16px 8px 8px !important;
            box-shadow: 0 -18px 70px rgba(14,42,36,0.22) !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

export default RotationWorkspace;

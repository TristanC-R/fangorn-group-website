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
  Stat,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { tilthStore, useLocalValue } from "../state/localStore.js";
import { addDays, cancelFarmTaskBySourceKey, titleWithSubject, upsertFarmTask } from "../../lib/farmTaskAutomation.js";

// ─── Product catalogue ───────────────────────────────────────────────

const PRODUCTS = [
  // Fertilisers
  { id: "nitram",          name: "Nitram 34.5%",          ai: "Ammonium nitrate",                   category: "Fertiliser",     unit: "kg/ha", defaultRate: 250, nFraction: 0.345, pFraction: 0,    kFraction: 0 },
  { id: "yara-yaramila",   name: "YaraMila Actyva S",     ai: "Compound N-P-K-S (16-15-15+9S)",    category: "Fertiliser",     unit: "kg/ha", defaultRate: 300, nFraction: 0.16,  pFraction: 0.15, kFraction: 0.15 },
  { id: "urea-46",         name: "Urea 46%",              ai: "Urea",                               category: "Fertiliser",     unit: "kg/ha", defaultRate: 200, nFraction: 0.46,  pFraction: 0,    kFraction: 0 },
  { id: "can-27",          name: "CAN 27%",               ai: "Calcium ammonium nitrate",            category: "Fertiliser",     unit: "kg/ha", defaultRate: 280, nFraction: 0.27,  pFraction: 0,    kFraction: 0 },
  { id: "uan-28",          name: "UAN 28%",               ai: "Urea ammonium nitrate solution",      category: "Fertiliser",     unit: "L/ha",  defaultRate: 150, nFraction: 0.28,  pFraction: 0,    kFraction: 0 },
  { id: "tsp",             name: "Triple superphosphate",  ai: "Monocalcium phosphate",              category: "Fertiliser",     unit: "kg/ha", defaultRate: 120, nFraction: 0,     pFraction: 0.46, kFraction: 0 },
  { id: "mop-60",          name: "Muriate of potash",      ai: "Potassium chloride (60% K₂O)",       category: "Fertiliser",     unit: "kg/ha", defaultRate: 100, nFraction: 0,     pFraction: 0,    kFraction: 0.60 },
  { id: "lime-calcium",    name: "Ground limestone",       ai: "Calcium carbonate",                  category: "Lime",           unit: "t/ha",  defaultRate: 2.5, nFraction: 0,     pFraction: 0,    kFraction: 0 },
  { id: "fym",             name: "Farmyard manure",        ai: "FYM (cattle)",                       category: "Organic manure", unit: "t/ha",  defaultRate: 25,  nFraction: 6,     pFraction: 3.5,  kFraction: 8, notePerTonne: true },
  { id: "slurry-cattle",   name: "Cattle slurry",          ai: "Cattle slurry (6% DM)",              category: "Organic manure", unit: "m³/ha", defaultRate: 30,  nFraction: 2.6,   pFraction: 0.6,  kFraction: 3.2, notePerTonne: true },
  { id: "slurry-pig",      name: "Pig slurry",             ai: "Pig slurry (4% DM)",                 category: "Organic manure", unit: "m³/ha", defaultRate: 25,  nFraction: 3.6,   pFraction: 0.8,  kFraction: 2.4, notePerTonne: true },
  { id: "digestate",       name: "Anaerobic digestate",    ai: "Whole digestate",                    category: "Organic manure", unit: "m³/ha", defaultRate: 30,  nFraction: 3.0,   pFraction: 0.4,  kFraction: 2.0, notePerTonne: true },

  // Herbicides
  { id: "roundup-flex",    name: "Roundup Flex",           ai: "Glyphosate 480 g/L",                category: "Herbicide",      unit: "L/ha",  defaultRate: 1.5, nFraction: 0, phi: 7 },
  { id: "atlantis-od",     name: "Atlantis OD",            ai: "Mesosulfuron + iodosulfuron",        category: "Herbicide",      unit: "L/ha",  defaultRate: 0.3, nFraction: 0 },
  { id: "stomp-aqua",      name: "Stomp Aqua",             ai: "Pendimethalin 455 g/L",             category: "Herbicide",      unit: "L/ha",  defaultRate: 2.9, nFraction: 0 },
  { id: "broadway-star",   name: "Broadway Star",          ai: "Florasulam + pyroxsulam",           category: "Herbicide",      unit: "pack/ha", defaultRate: 1, nFraction: 0 },
  { id: "pixxaro",         name: "Pixxaro EC",             ai: "Arylex + fluroxypyr",               category: "Herbicide",      unit: "L/ha",  defaultRate: 0.5, nFraction: 0 },
  { id: "mcpa-750",        name: "MCPA 750",               ai: "MCPA 750 g/L",                      category: "Herbicide",      unit: "L/ha",  defaultRate: 1.0, nFraction: 0 },

  // Fungicides
  { id: "proline-275",     name: "Proline 275",            ai: "Prothioconazole 275 g/L",           category: "Fungicide",      unit: "L/ha",  defaultRate: 0.72, nFraction: 0, phi: 35 },
  { id: "revystar-xpro",   name: "Revystar XPro",         ai: "Mefentrifluconazole + fluxapyroxad", category: "Fungicide",     unit: "L/ha",  defaultRate: 1.0,  nFraction: 0, phi: 35 },
  { id: "ascra-xpro",      name: "Ascra Xpro",            ai: "Bixafen + fluopyram + prothioconazole", category: "Fungicide",  unit: "L/ha",  defaultRate: 1.5,  nFraction: 0, phi: 35 },
  { id: "aviator-xpro",    name: "Aviator Xpro",          ai: "Bixafen + prothioconazole",         category: "Fungicide",      unit: "L/ha",  defaultRate: 1.0,  nFraction: 0, phi: 35 },
  { id: "elatus-era",      name: "Elatus Era",             ai: "Benzovindiflupyr + prothioconazole", category: "Fungicide",    unit: "L/ha",  defaultRate: 1.0,  nFraction: 0, phi: 35 },
  { id: "adexar",          name: "Adexar",                 ai: "Epoxiconazole + fluxapyroxad",      category: "Fungicide",      unit: "L/ha",  defaultRate: 1.5,  nFraction: 0, phi: 35 },

  // Insecticides
  { id: "decis-forte",     name: "Decis Forte",            ai: "Deltamethrin 100 g/L",              category: "Insecticide",    unit: "L/ha",  defaultRate: 0.075, nFraction: 0, phi: 30 },
  { id: "hallmark-zeon",   name: "Hallmark Zeon",          ai: "Lambda-cyhalothrin 100 g/L",        category: "Insecticide",    unit: "L/ha",  defaultRate: 0.075, nFraction: 0, phi: 28 },
  { id: "biscaya",         name: "Biscaya",                ai: "Thiacloprid 240 g/L",               category: "Insecticide",    unit: "L/ha",  defaultRate: 0.3,   nFraction: 0, phi: 14 },

  // PGRs
  { id: "moddus",          name: "Moddus",                 ai: "Trinexapac-ethyl 250 g/L",          category: "PGR",            unit: "L/ha",  defaultRate: 0.4, nFraction: 0 },
  { id: "manipulator",     name: "Manipulator 730 EC",     ai: "Chlormequat 730 g/L",               category: "PGR",            unit: "L/ha",  defaultRate: 1.5, nFraction: 0 },
  { id: "canopy",          name: "Canopy",                 ai: "Mepiquat chloride + prohexadione",  category: "PGR",            unit: "L/ha",  defaultRate: 1.0, nFraction: 0 },

  // Micronutrients / foliar
  { id: "manganese-foliar", name: "Manganese sulphate (foliar)", ai: "MnSO₄",                      category: "Micronutrient",  unit: "L/ha",  defaultRate: 2.0, nFraction: 0 },
  { id: "copper-foliar",    name: "Copper EDTA (foliar)",        ai: "Cu EDTA",                     category: "Micronutrient",  unit: "L/ha",  defaultRate: 1.0, nFraction: 0 },
  { id: "trace-element",    name: "Headland Trace",              ai: "Mn + Zn + Cu + Mg",           category: "Micronutrient",  unit: "L/ha",  defaultRate: 2.0, nFraction: 0 },

  // Seed
  { id: "seed",             name: "Seed (general)",              ai: "—",                            category: "Seed",           unit: "kg/ha", defaultRate: 160, nFraction: 0 },

  // Adjuvants
  { id: "biopower",         name: "BioPower",                    ai: "Alkyl polyglucoside surfactant", category: "Adjuvant",    unit: "L/ha",  defaultRate: 1.0, nFraction: 0 },
];

const N_MAX_CAP = 220;
const WIND_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "Variable"];
const DEFAULT_CUSTOM_PRODUCT = {
  ai: "Custom product",
  category: "Herbicide",
  unit: "L/ha",
  defaultRate: 1,
  nFraction: 0,
};

// ─── NVZ closed periods (England) ────────────────────────────────────

const NVZ_CLOSED = {
  "Organic manure (grassland)": { start: [9, 15], end: [1, 15] },
  "Organic manure (arable)":    { start: [10, 1],  end: [1, 15] },
  "Manufactured N (grassland)": { start: [9, 15], end: [1, 15] },
  "Manufactured N (arable)":    { start: [9, 1],  end: [1, 15] },
};

function isInNvzClosedPeriod(dateStr, category) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const periods = Object.entries(NVZ_CLOSED);
  for (const [label, { start, end }] of periods) {
    if (category === "Organic manure" && !label.startsWith("Organic")) continue;
    if (category === "Fertiliser" && !label.startsWith("Manufactured")) continue;
    if (start[0] > end[0]) {
      if (m > start[0] || (m === start[0] && day >= start[1]) || m < end[0] || (m === end[0] && day <= end[1])) return label;
    } else {
      if ((m > start[0] || (m === start[0] && day >= start[1])) && (m < end[0] || (m === end[0] && day <= end[1]))) return label;
    }
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function approxHectares(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) return 0;
  const ring = boundary;
  const midLat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
  const mLat = 111_132, mLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
  let twice = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; twice += (a.lng * mLng) * (b.lat * mLat) - (b.lng * mLng) * (a.lat * mLat); }
  return Math.abs(twice) / 2 / 10_000;
}

function fmtDate(iso) { if (!iso) return "—"; try { return new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }); } catch { return iso; } }

function makeProductId(name) {
  const base = String(name || "custom-product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "custom-product";
  return `custom-${base}`;
}

function nApplied(rateKgLPerHa, productId, products = PRODUCTS) {
  const prod = products.find((p) => p.id === productId);
  if (!prod) return 0;
  if (prod.notePerTonne) return (Number(rateKgLPerHa) || 0) * prod.nFraction / 1000;
  return (Number(rateKgLPerHa) || 0) * prod.nFraction;
}

function productById(id, products = PRODUCTS) { return products.find((p) => p.id === id) || PRODUCTS[0]; }

function triggerDownload(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function daysBetween(d1, d2) { return Math.round((new Date(d2).getTime() - new Date(d1).getTime()) / 86_400_000); }

function formatProductNames(record, products = PRODUCTS) {
  if (Array.isArray(record.blendProducts) && record.blendProducts.length) {
    return record.blendProducts.map((item) => productById(item.productId, products).name).join(" + ");
  }
  return productById(record.productId, products).name;
}

function blendNApplied(record, products = PRODUCTS) {
  if (Array.isArray(record.blendProducts) && record.blendProducts.length) {
    return record.blendProducts.reduce((sum, item) => sum + nApplied(item.rate, item.productId, products), 0);
  }
  return nApplied(record.rate, record.productId, products);
}

// ─── CSV export ──────────────────────────────────────────────────────

function toCsv(rows, products = PRODUCTS) {
  const header = ["date","start_time","end_time","field","product","active_ingredient","category","rate","unit","area_ha","n_applied_kg_ha","operator","wind_direction","notes"];
  const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  const lines = [header.join(",")];
  for (const r of rows) {
    const prod = productById(r.productId, products);
    const productNames = formatProductNames(r, products);
    const activeIngredients = Array.isArray(r.blendProducts) && r.blendProducts.length
      ? r.blendProducts.map((item) => productById(item.productId, products).ai).join(" + ")
      : prod.ai;
    const rates = Array.isArray(r.blendProducts) && r.blendProducts.length
      ? r.blendProducts.map((item) => `${item.rate} ${productById(item.productId, products).unit}`).join(" + ")
      : r.rate;
    lines.push([r.date, r.startTime || "", r.endTime || "", r.fieldName, productNames, activeIngredients, prod.category, rates, prod.unit, r.area?.toFixed?.(2) || "", blendNApplied(r, products).toFixed(2), r.operator || "", r.windDirection || "", r.notes || ""].map(esc).join(","));
  }
  return lines.join("\n");
}

// ─── CSV import parser ───────────────────────────────────────────────

function parseCsvImport(text, fieldLookup, fieldAreas, products = PRODUCTS) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim().replace(/^"/, "").replace(/"$/, ""));
  const dateIdx = header.findIndex((h) => h === "date");
  const fieldIdx = header.findIndex((h) => h === "field" || h === "field_name");
  const prodIdx = header.findIndex((h) => h === "product" || h === "product_name");
  const rateIdx = header.findIndex((h) => h === "rate");
  const opIdx = header.findIndex((h) => h === "operator");
  const notesIdx = header.findIndex((h) => h === "notes");
  if (dateIdx < 0 || fieldIdx < 0) return [];

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim().replace(/^"/, "").replace(/"$/, ""));
    const fieldName = cells[fieldIdx] || "";
    let fieldId = null;
    for (const [id, name] of fieldLookup) { if (name?.toLowerCase() === fieldName.toLowerCase()) { fieldId = id; break; } }
    if (!fieldId) continue;

    const prodName = (cells[prodIdx] || "").toLowerCase();
    const prod = products.find((p) => p.name.toLowerCase() === prodName || p.id === prodName) || PRODUCTS[0];

    records.push({
      id: `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${i}`,
      createdAt: new Date().toISOString(),
      fieldId,
      fieldName: fieldLookup.get(fieldId) || fieldName,
      productId: prod.id,
      rate: Number(cells[rateIdx]) || prod.defaultRate,
      date: cells[dateIdx] || new Date().toISOString().slice(0, 10),
      operator: cells[opIdx] || "",
      notes: cells[notesIdx] || "",
      area: fieldAreas[fieldId] || 0,
    });
  }
  return records;
}

// ─── Record row ──────────────────────────────────────────────────────

function RecordRow({ record, fieldName, products, onDelete, onEdit }) {
  const prod = productById(record.productId, products);
  const productNames = formatProductNames(record, products);
  const nPer = blendNApplied(record, products);
  const phiDays = prod.phi ? prod.phi - daysBetween(record.date, new Date().toISOString().slice(0, 10)) : null;
  const phiActive = phiDays != null && phiDays > 0;
  const timeLabel = record.startTime || record.endTime ? `${record.startTime || "?"}-${record.endTime || "?"}` : null;

  const warnings = [];
  if (!record.operator) warnings.push("Operator missing");
  if (nPer > 120) warnings.push("High N");
  const nvz = isInNvzClosedPeriod(record.date, prod.category);
  if (nvz) warnings.push("NVZ closed period");
  if (phiActive) warnings.push(`PHI ${phiDays}d left`);

  const tone = warnings.some((w) => w.includes("NVZ")) ? "danger" : warnings.length ? "warn" : "ok";
  const label = warnings.length ? warnings[0] : "OK";

  return (
    <Row className="tilth-record-row" style={{ padding: "8px 10px" }}>
      <div className="tilth-record-row-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 0.8fr) auto auto auto", gap: 10, alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: brand.forest, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12.5 }}>{fieldName || "—"}</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, letterSpacing: "0.04em" }}>{fmtDate(record.date)}{timeLabel ? ` · ${timeLabel}` : ""} · {record.operator || "no operator"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, color: brand.forest, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{productNames}</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, letterSpacing: "0.04em" }}>
            {record.isBlend ? "Blend" : `${record.rate} ${prod.unit}`} · {prod.category}{record.windDirection ? ` · wind ${record.windDirection}` : ""}
          </div>
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: brand.bodySoft }}>
          {record.area?.toFixed?.(1) || "—"} ha
          {nPer > 0 && <div style={{ fontSize: 10, color: brand.muted }}>{nPer.toFixed(0)} kg N/ha</div>}
        </div>
        <Pill tone={tone} style={{ justifySelf: "start" }}>{label}</Pill>
        <button className="tilth-icon-button" type="button" onClick={onEdit} title="Edit" style={{ background: "transparent", border: `1px solid ${brand.border}`, borderRadius: radius.base, width: 30, height: 30, cursor: "pointer", color: brand.forest, fontFamily: fonts.mono, fontSize: 11 }}>✎</button>
        <button className="tilth-icon-button" type="button" onClick={onDelete} title="Delete" style={{ background: "transparent", border: `1px solid ${brand.border}`, borderRadius: radius.base, width: 30, height: 30, cursor: "pointer", color: brand.muted }}>×</button>
      </div>
      {record.notes && <div style={{ fontFamily: fonts.sans, fontSize: 10.5, color: brand.muted, marginTop: 4, paddingLeft: 2 }}>{record.notes}</div>}
    </Row>
  );
}

// ─── N budget bar ────────────────────────────────────────────────────

function NBudgetBar({ current, cap, label }) {
  const pct = Math.min(100, (current / cap) * 100);
  const color = pct >= 100 ? brand.danger : pct >= 85 ? brand.warn : brand.ok;
  return (
    <div style={{ padding: "6px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>{label}</span>
        <span style={{ fontFamily: fonts.mono, fontSize: 10, color, fontWeight: 600 }}>{current.toFixed(0)} / {cap} kg N/ha</span>
      </div>
      <div style={{ height: 6, background: brand.bgSection, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3, transition: "width 300ms ease" }} />
      </div>
    </div>
  );
}

// ─── Main workspace ──────────────────────────────────────────────────

export function RecordsWorkspace({ farm, fields }) {
  const farmId = farm?.id || null;
  const mappedFields = useMemo(() => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3), [fields]);
  const fieldAreas = useMemo(() => { const m = {}; for (const f of mappedFields) m[f.id] = approxHectares(f.boundary); return m; }, [mappedFields]);
  const fieldLookup = useMemo(() => { const m = new Map(); for (const f of fields || []) m.set(f.id, f.name); return m; }, [fields]);

  const [records, setRecords] = useState(() => tilthStore.loadRecords(farmId));
  useEffect(() => { setRecords(tilthStore.loadRecords(farmId)); }, [farmId]);
  const persist = useCallback((next) => { setRecords(next); tilthStore.saveRecords(farmId, next); }, [farmId]);
  const [customProducts, setCustomProducts] = useLocalValue("custom_products", farmId, []);
  const allProducts = useMemo(() => [...PRODUCTS, ...(Array.isArray(customProducts) ? customProducts : [])], [customProducts]);
  const categories = useMemo(() => [...new Set(allProducts.map((p) => p.category))].sort(), [allProducts]);

  // Form state
  const [fieldId, setFieldId] = useState(mappedFields[0]?.id || "");
  useEffect(() => { if (!fieldId && mappedFields[0]) setFieldId(mappedFields[0].id); }, [mappedFields, fieldId]);
  const [productId, setProductId] = useState(PRODUCTS[0].id);
  const [rate, setRate] = useState(PRODUCTS[0].defaultRate);
  const [isBlend, setIsBlend] = useState(false);
  const [blendProducts, setBlendProducts] = useState([{ productId: PRODUCTS[0].id, rate: PRODUCTS[0].defaultRate }]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [windDirection, setWindDirection] = useState("");
  const [operator, setOperator] = useState("");
  const [notes, setNotes] = useState("");
  const [editId, setEditId] = useState(null);
  const [catFilter, setCatFilter] = useState("all");
  const [newProductName, setNewProductName] = useState("");
  const [newProductCategory, setNewProductCategory] = useState(DEFAULT_CUSTOM_PRODUCT.category);
  const [newProductUnit, setNewProductUnit] = useState(DEFAULT_CUSTOM_PRODUCT.unit);
  const [newProductAi, setNewProductAi] = useState("");

  // Filter & sort
  const [filterField, setFilterField] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [sortBy, setSortBy] = useState("date-desc");

  // CSV import
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const fileRef = useRef(null);

  const product = productById(productId, allProducts);
  const selectedField = mappedFields.find((f) => f.id === fieldId);
  const area = selectedField ? fieldAreas[selectedField.id] : 0;
  const nPerHa = isBlend
    ? blendProducts.reduce((sum, item) => sum + nApplied(item.rate, item.productId, allProducts), 0)
    : nApplied(rate, productId, allProducts);
  const nAbsolute = nPerHa * (area || 0);

  // Season N for selected field
  const thisYear = new Date().getFullYear();
  const seasonNForField = useMemo(() => records.filter((r) => r.fieldId === fieldId).filter((r) => new Date(r.date).getFullYear() === thisYear).reduce((a, r) => a + blendNApplied(r, allProducts), 0), [records, fieldId, thisYear, allProducts]);
  const projectedN = seasonNForField + (editId ? 0 : nPerHa);
  const nTone = projectedN > N_MAX_CAP ? "danger" : projectedN > N_MAX_CAP * 0.85 ? "warn" : "ok";

  // NVZ check
  const nvzWarning = isInNvzClosedPeriod(date, product.category);

  // Filtered product list
  const filteredProducts = catFilter === "all" ? allProducts : allProducts.filter((p) => p.category === catFilter);

  const addCustomProduct = () => {
    const name = newProductName.trim();
    if (!name) return;
    const baseId = makeProductId(name);
    let id = baseId;
    let n = 2;
    while (allProducts.some((p) => p.id === id)) {
      id = `${baseId}-${n}`;
      n += 1;
    }
    const entry = {
      ...DEFAULT_CUSTOM_PRODUCT,
      id,
      name,
      ai: newProductAi.trim() || DEFAULT_CUSTOM_PRODUCT.ai,
      category: newProductCategory,
      unit: newProductUnit.trim() || DEFAULT_CUSTOM_PRODUCT.unit,
      defaultRate: Number(rate) > 0 ? Number(rate) : DEFAULT_CUSTOM_PRODUCT.defaultRate,
      custom: true,
    };
    setCustomProducts((prev) => [...(Array.isArray(prev) ? prev : []), entry]);
    setProductId(entry.id);
    setRate(entry.defaultRate);
    setNewProductName("");
    setNewProductAi("");
  };

  const setBlendProduct = (idx, patch) => {
    setBlendProducts((prev) => prev.map((item, i) => {
      if (i !== idx) return item;
      const next = { ...item, ...patch };
      if (patch.productId) {
        next.rate = productById(patch.productId, allProducts).defaultRate;
      }
      return next;
    }));
  };

  const addBlendLine = () => {
    setBlendProducts((prev) => [...prev, { productId: productId || PRODUCTS[0].id, rate: productById(productId, allProducts).defaultRate }]);
  };

  const removeBlendLine = (idx) => {
    setBlendProducts((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  };

  // Save / update record
  const saveRecord = () => {
    if (!fieldId || (!isBlend && !rate)) return;
    const cleanBlend = blendProducts
      .filter((item) => item.productId && Number(item.rate) > 0)
      .map((item) => ({ productId: item.productId, rate: Number(item.rate) }));
    if (isBlend && !cleanBlend.length) return;
    const mainProductId = isBlend ? cleanBlend[0].productId : productId;
    const mainProduct = productById(mainProductId, allProducts);
    const id = editId || `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      id,
      createdAt: new Date().toISOString(),
      fieldId,
      fieldName: selectedField?.name || "",
      productId: mainProductId,
      rate: isBlend ? cleanBlend[0].rate : Number(rate),
      isBlend,
      blendProducts: isBlend ? cleanBlend : [],
      date,
      startTime,
      endTime,
      windDirection,
      operator: operator.trim(),
      notes: notes.trim(),
      area,
    };
    if (editId) {
      const next = records.map((r) => r.id === editId ? { ...r, ...record, createdAt: r.createdAt } : r);
      persist(next);
      setEditId(null);
    } else {
      const next = [record, ...records];
      persist(next);
    }
    if (mainProduct.phi) {
      const dueDate = addDays(date, mainProduct.phi);
      upsertFarmTask(farmId, {
        sourceKey: `record:${id}:phi`,
        source: "record",
        sourceId: id,
        title: titleWithSubject("PHI ends", `${formatProductNames(record, allProducts)} on ${selectedField?.name || "field"}`),
        dueDate,
        category: "records",
        priority: "medium",
        notes: "Automatically created from an input record with a harvest interval.",
      });
    } else if (editId) {
      cancelFarmTaskBySourceKey(farmId, `record:${id}:phi`);
    }
    setOperator("");
    setNotes("");
    setStartTime("");
    setEndTime("");
    setWindDirection("");
  };

  const startEdit = (rec) => {
    setEditId(rec.id);
    setFieldId(rec.fieldId);
    setProductId(rec.productId);
    setRate(rec.rate);
    setIsBlend(!!rec.isBlend);
    setBlendProducts(Array.isArray(rec.blendProducts) && rec.blendProducts.length ? rec.blendProducts : [{ productId: rec.productId, rate: rec.rate }]);
    setDate(rec.date);
    setStartTime(rec.startTime || "");
    setEndTime(rec.endTime || "");
    setWindDirection(rec.windDirection || "");
    setOperator(rec.operator || "");
    setNotes(rec.notes || "");
  };

  const cancelEdit = () => {
    setEditId(null);
    setOperator("");
    setNotes("");
    setStartTime("");
    setEndTime("");
    setWindDirection("");
    setIsBlend(false);
    setBlendProducts([{ productId: productId || PRODUCTS[0].id, rate: productById(productId, allProducts).defaultRate }]);
  };

  const removeRecord = (id) => {
    if (!window.confirm("Delete this record?")) return;
    persist(records.filter((r) => r.id !== id));
    cancelFarmTaskBySourceKey(farmId, `record:${id}:phi`);
  };

  // CSV import
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(reader.result || "");
    reader.readAsText(file);
  };

  const doImport = () => {
    const imported = parseCsvImport(importText, fieldLookup, fieldAreas, allProducts);
    if (!imported.length) { alert("No valid records found. Ensure CSV has 'date' and 'field' columns."); return; }
    persist([...imported, ...records]);
    setImportText("");
    setShowImport(false);
    alert(`${imported.length} record${imported.length > 1 ? "s" : ""} imported.`);
  };

  // Filtered & sorted diary
  const displayRecords = useMemo(() => {
    let list = records;
    if (filterField !== "all") list = list.filter((r) => r.fieldId === filterField);
    if (filterCat !== "all") { const catProducts = new Set(allProducts.filter((p) => p.category === filterCat).map((p) => p.id)); list = list.filter((r) => catProducts.has(r.productId)); }
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "date-asc": return new Date(a.date) - new Date(b.date);
        case "field": return (a.fieldName || "").localeCompare(b.fieldName || "");
        case "product": return (formatProductNames(a, allProducts)).localeCompare(formatProductNames(b, allProducts));
        case "n-desc": return blendNApplied(b, allProducts) - blendNApplied(a, allProducts);
        default: return new Date(b.date) - new Date(a.date);
      }
    });
    return list;
  }, [records, filterField, filterCat, sortBy, allProducts]);

  // Analytics
  const analytics = useMemo(() => {
    const totalN = records.reduce((a, r) => a + blendNApplied(r, allProducts) * (r.area || 0), 0);
    const totalArea = records.reduce((a, r) => a + (r.area || 0), 0);
    const byCat = {};
    for (const r of records) {
      const cat = productById(r.productId, allProducts).category;
      if (!byCat[cat]) byCat[cat] = { count: 0, totalArea: 0 };
      byCat[cat].count++;
      byCat[cat].totalArea += r.area || 0;
    }
    const byField = {};
    for (const r of records) {
      if (!byField[r.fieldId]) byField[r.fieldId] = { name: r.fieldName, n: 0, count: 0 };
      byField[r.fieldId].n += blendNApplied(r, allProducts);
      byField[r.fieldId].count++;
    }
    const byMonth = {};
    for (const r of records) {
      const m = r.date?.slice(0, 7) || "unknown";
      if (!byMonth[m]) byMonth[m] = { count: 0, n: 0 };
      byMonth[m].count++;
      byMonth[m].n += blendNApplied(r, allProducts) * (r.area || 0);
    }
    const flagged = records.filter((r) => {
      if (!r.operator) return true;
      if (blendNApplied(r, allProducts) > 120) return true;
      const p = productById(r.productId, allProducts);
      if (isInNvzClosedPeriod(r.date, p.category)) return true;
      return false;
    });
    return { totalN, totalArea, byCat, byField, byMonth, flagged, unique: new Set(records.map((r) => r.fieldId)).size };
  }, [records, allProducts]);

  // N budgets per field
  const fieldNBudgets = useMemo(() => {
    const budgets = [];
    for (const f of mappedFields) {
      const seasonN = records.filter((r) => r.fieldId === f.id && new Date(r.date).getFullYear() === thisYear).reduce((a, r) => a + blendNApplied(r, allProducts), 0);
      if (seasonN > 0) budgets.push({ id: f.id, name: f.name || "Unnamed", n: seasonN });
    }
    return budgets.sort((a, b) => b.n - a.n);
  }, [mappedFields, records, thisYear, allProducts]);

  const exportCsv = () => { if (!records.length) return; triggerDownload(`tilth-records-${farmId || "farm"}-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", toCsv(records, allProducts)); };
  const canSave = !!fieldId && (isBlend ? blendProducts.some((item) => item.productId && Number(item.rate) > 0) : Number(rate) > 0);

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Operations"
          title="Inputs & spray diary"
          description="Track fertiliser, sprays, manures and seed per field. NMax validation, NVZ closed-period checks, PHI countdowns and compliance flags."
          actions={<>
            <Button variant="secondary" size="sm" onClick={() => setShowImport(!showImport)}>{showImport ? "Cancel import" : "Import CSV"}</Button>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!records.length}>Export CSV</Button>
          </>}
        />
      }
    >
      {!mappedFields.length ? (
        <Card padding={24}><EmptyState kicker="No fields" title="Map fields first" description="Records are attached to field boundaries. Head to Fields to map or import." /></Card>
      ) : (
        <div className="tilth-records-layout" style={{ flex: "1 1 auto", minHeight: 0, display: "grid", gridTemplateColumns: "340px minmax(0, 1fr)", gap: 12, overflow: "hidden" }}>
          {/* Left: form + analytics */}
          <div className="tilth-records-form-column tilth-scroll" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 10, overflowY: "auto", paddingRight: 4 }}>
            {/* CSV import */}
            {showImport && (
              <Card padding={12}>
                <Kicker style={{ marginBottom: 6 }}>Import CSV</Kicker>
                <Body size="sm" style={{ marginBottom: 8 }}>CSV needs <strong>date</strong> and <strong>field</strong> columns. Optional: product, rate, operator, notes.</Body>
                <input ref={fileRef} type="file" accept=".csv" onChange={handleFileUpload} style={{ fontFamily: fonts.sans, fontSize: 11, marginBottom: 8 }} />
                <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Or paste CSV here..." rows={4} style={{ ...inputStyle, fontSize: 11, fontFamily: fonts.mono, resize: "vertical" }} />
                <Button variant="primary" size="sm" onClick={doImport} disabled={!importText.trim()} style={{ marginTop: 8 }}>Import records</Button>
              </Card>
            )}

            {/* Log form */}
            <Card className="tilth-mobile-card" padding={12} style={{ display: "flex", flexDirection: "column" }}>
              <Kicker style={{ marginBottom: 6 }}>{editId ? "Edit record" : "Log application"}</Kicker>

              <div style={{ marginBottom: 8 }}>
                <FieldLabel>Field</FieldLabel>
                <select value={fieldId} onChange={(e) => setFieldId(e.target.value)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }}>
                  {mappedFields.map((f) => <option key={f.id} value={f.id}>{f.name || "Unnamed"} · {fieldAreas[f.id]?.toFixed(1) || "—"} ha</option>)}
                </select>
              </div>

              <div style={{ marginBottom: 8 }}>
                <FieldLabel>Category</FieldLabel>
                <select value={catFilter} onChange={(e) => { setCatFilter(e.target.value); const first = (e.target.value === "all" ? allProducts : allProducts.filter((p) => p.category === e.target.value))[0]; if (first) { setProductId(first.id); setRate(first.defaultRate); } }} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }}>
                  <option value="all">All categories</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div style={{ marginBottom: 8 }}>
                <FieldLabel>Product</FieldLabel>
                <select value={productId} onChange={(e) => { setProductId(e.target.value); setRate(productById(e.target.value, allProducts).defaultRate); }} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }}>
                  {filteredProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginTop: 3 }}>{product.ai}</div>
              </div>

              <div style={{ display: "grid", gap: 6, padding: "8px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.bgSection, marginBottom: 8 }}>
                <FieldLabel>Add chemical to dropdown</FieldLabel>
                <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <input value={newProductName} onChange={(e) => setNewProductName(e.target.value)} placeholder="Product name" style={{ ...inputStyle, padding: "7px 9px", fontSize: 12 }} />
                  <input value={newProductAi} onChange={(e) => setNewProductAi(e.target.value)} placeholder="Active ingredient" style={{ ...inputStyle, padding: "7px 9px", fontSize: 12 }} />
                  <select value={newProductCategory} onChange={(e) => setNewProductCategory(e.target.value)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12 }}>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input value={newProductUnit} onChange={(e) => setNewProductUnit(e.target.value)} placeholder="Unit e.g. L/ha" style={{ ...inputStyle, padding: "7px 9px", fontSize: 12 }} />
                </div>
                <Button variant="secondary" size="sm" onClick={addCustomProduct} disabled={!newProductName.trim()}>Add chemical</Button>
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontFamily: fonts.sans, fontSize: 12, color: brand.forest }}>
                <input type="checkbox" checked={isBlend} onChange={(e) => setIsBlend(e.target.checked)} />
                Blend for sprayer
              </label>

              {isBlend && (
                <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                  {blendProducts.map((item, idx) => {
                    const blendProduct = productById(item.productId, allProducts);
                    return (
                      <div className="tilth-mobile-stack" key={`${item.productId}-${idx}`} style={{ display: "grid", gridTemplateColumns: "1fr 90px auto", gap: 6, alignItems: "end" }}>
                        <div>
                          <FieldLabel>{idx === 0 ? "Blend products" : " "}</FieldLabel>
                          <select value={item.productId} onChange={(e) => setBlendProduct(idx, { productId: e.target.value })} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }}>
                            {allProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <FieldLabel>Rate ({blendProduct.unit})</FieldLabel>
                          <input value={item.rate} type="number" step="0.01" min="0" onChange={(e) => setBlendProduct(idx, { rate: e.target.value })} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                        </div>
                        <button type="button" onClick={() => removeBlendLine(idx)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 11, cursor: "pointer" }} disabled={blendProducts.length <= 1}>Remove</button>
                      </div>
                    );
                  })}
                  <Button variant="secondary" size="sm" onClick={addBlendLine}>Add product to blend</Button>
                </div>
              )}

              <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div>
                  <FieldLabel>Rate ({product.unit})</FieldLabel>
                  <input value={rate} type="number" step="0.01" min="0" onChange={(e) => setRate(e.target.value)} disabled={isBlend} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5, opacity: isBlend ? 0.55 : 1 }} />
                </div>
                <div>
                  <FieldLabel>Date</FieldLabel>
                  <input value={date} type="date" onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                </div>
              </div>

              <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div>
                  <FieldLabel>Start time</FieldLabel>
                  <input value={startTime} type="time" onChange={(e) => setStartTime(e.target.value)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                </div>
                <div>
                  <FieldLabel>End time</FieldLabel>
                  <input value={endTime} type="time" onChange={(e) => setEndTime(e.target.value)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                </div>
                <div>
                  <FieldLabel>Wind direction</FieldLabel>
                  <select value={windDirection} onChange={(e) => setWindDirection(e.target.value)} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }}>
                    <option value="">Not recorded</option>
                    {WIND_DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>

              <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div>
                  <FieldLabel>Operator</FieldLabel>
                  <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="e.g. T. Jenkins" style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                </div>
                <div>
                  <FieldLabel>Notes</FieldLabel>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                </div>
              </div>

              {/* Validation preview */}
              <div style={{ padding: "8px 10px", border: `1px solid ${brand.border}`, background: brand.bgSection, borderRadius: radius.base, marginBottom: 10 }}>
                <Kicker style={{ marginBottom: 6 }}>Validation</Kicker>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <Pill tone="neutral">Area {area?.toFixed(1) || "—"} ha</Pill>
                  {nPerHa > 0 && <Pill tone="neutral">N {nPerHa.toFixed(0)} kg/ha</Pill>}
                  {nAbsolute > 0 && <Pill tone="neutral">{nAbsolute.toFixed(0)} kg total</Pill>}
                  <Pill tone={nTone}>Season N {projectedN.toFixed(0)}/{N_MAX_CAP}</Pill>
                  {product.phi && <Pill tone="info">PHI {product.phi}d</Pill>}
                  {!operator && <Pill tone="warn">Operator missing</Pill>}
                  {nvzWarning && <Pill tone="danger">NVZ closed</Pill>}
                </div>
              </div>

              <div className="tilth-mobile-actions" style={{ display: "flex", gap: 8 }}>
                <Button variant="primary" size="sm" onClick={saveRecord} disabled={!canSave}>{editId ? "Update" : "Save record"}</Button>
                {editId && <Button variant="secondary" size="sm" onClick={cancelEdit}>Cancel</Button>}
              </div>
            </Card>

            {/* N budgets per field */}
            {fieldNBudgets.length > 0 && (
              <Card padding={12}>
                <Kicker style={{ marginBottom: 6 }}>Nitrogen budget ({thisYear})</Kicker>
                <div style={{ display: "grid", gap: 4 }}>
                  {fieldNBudgets.slice(0, 8).map((b) => <NBudgetBar key={b.id} current={b.n} cap={N_MAX_CAP} label={b.name} />)}
                  {fieldNBudgets.length > 8 && <Body size="sm" color={brand.muted}>+ {fieldNBudgets.length - 8} more fields</Body>}
                </div>
              </Card>
            )}
          </div>

          {/* Right: diary + analytics */}
          <div className="tilth-records-diary-column" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 10 }}>
            {/* Stats row */}
            <div className="tilth-records-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, flex: "0 0 auto" }}>
              <Stat kicker="Records" value={records.length} sub={`${analytics.unique} fields`} />
              <Stat kicker="Total N" value={`${(analytics.totalN / 1000).toFixed(1)}t`} sub={`${analytics.totalArea.toFixed(0)} ha covered`} />
              <Stat kicker="Flags" value={analytics.flagged.length} sub={analytics.flagged.length ? "Review needed" : "All clear"} tone={analytics.flagged.length ? undefined : undefined} />
              <Stat kicker="Categories" value={Object.keys(analytics.byCat).length} sub={Object.keys(analytics.byCat).join(", ").slice(0, 40)} />
            </div>

            {/* Filters */}
            <div className="tilth-records-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: "0 0 auto" }}>
              <select value={filterField} onChange={(e) => setFilterField(e.target.value)} style={{ fontFamily: fonts.sans, fontSize: 11, padding: "5px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, color: brand.forest }}>
                <option value="all">All fields</option>
                {mappedFields.map((f) => <option key={f.id} value={f.id}>{f.name || "Unnamed"}</option>)}
              </select>
              <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={{ fontFamily: fonts.sans, fontSize: 11, padding: "5px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, color: brand.forest }}>
                <option value="all">All categories</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ fontFamily: fonts.sans, fontSize: 11, padding: "5px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, color: brand.forest }}>
                <option value="date-desc">Newest first</option>
                <option value="date-asc">Oldest first</option>
                <option value="field">By field</option>
                <option value="product">By product</option>
                <option value="n-desc">Highest N first</option>
              </select>
              <Pill tone="neutral">{displayRecords.length} shown</Pill>
            </div>

            {/* Diary list */}
            <Card padding={12} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                <Kicker>Diary</Kicker>
              </div>
              <div className="tilth-scroll" style={{ display: "grid", gap: 4, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
                {displayRecords.length ? displayRecords.map((r) => (
                  <RecordRow key={r.id} record={r} products={allProducts} fieldName={fieldLookup.get(r.fieldId) || r.fieldName || "—"} onDelete={() => removeRecord(r.id)} onEdit={() => startEdit(r)} />
                )) : <Body size="sm">No records match your filters.</Body>}
              </div>
            </Card>

            {/* Compliance flags */}
            {analytics.flagged.length > 0 && (
              <Card padding={12} tone="section" style={{ flex: "0 0 auto" }}>
                <Kicker style={{ marginBottom: 6 }}>Compliance flags · {analytics.flagged.length}</Kicker>
                <div style={{ display: "grid", gap: 4, maxHeight: 120, overflowY: "auto" }} className="tilth-scroll">
                  {analytics.flagged.slice(0, 8).map((r) => {
                    const prod = productById(r.productId, allProducts);
                    const nvz = isInNvzClosedPeriod(r.date, prod.category);
                    const reason = nvz ? "NVZ closed period" : !r.operator ? "Operator missing" : "High N rate";
                    const t = nvz ? "danger" : !r.operator ? "danger" : "warn";
                    return (
                      <div key={r.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "6px 9px", border: `1px solid ${t === "danger" ? brand.danger : brand.warn}`, background: t === "danger" ? brand.dangerSoft : brand.warnSoft, borderRadius: radius.base }}>
                        <span style={{ color: t === "danger" ? brand.danger : brand.warn, fontWeight: 600, fontSize: 12 }}>{fieldLookup.get(r.fieldId) || "—"} · {prod.name} — {reason}</span>
                        <Pill tone={t}>{t === "danger" ? "Fix" : "Review"}</Pill>
                      </div>
                    );
                  })}
                  {analytics.flagged.length > 8 && <Body size="sm" color={brand.muted}>+ {analytics.flagged.length - 8} more flags</Body>}
                </div>
              </Card>
            )}

            {/* Monthly activity breakdown */}
            {Object.keys(analytics.byMonth).length > 0 && (
              <Card padding={12} style={{ flex: "0 0 auto" }}>
                <Kicker style={{ marginBottom: 6 }}>Monthly activity</Kicker>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 6 }}>
                  {Object.entries(analytics.byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, data]) => (
                    <div key={month} style={{ padding: "6px 8px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white }}>
                      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, letterSpacing: "0.10em", textTransform: "uppercase" }}>{month}</div>
                      <div style={{ fontFamily: fonts.serif, fontSize: 16, color: brand.forest }}>{data.count}</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>{data.n.toFixed(0)} kg N</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 1250px) { .tilth-records-layout { grid-template-columns: 1fr !important; grid-template-rows: auto minmax(200px, 1fr) !important; } }
        @media (max-width: 760px) {
          .tilth-records-layout {
            display: flex !important;
            flex-direction: column !important;
            gap: 12px !important;
            overflow-y: auto !important;
            padding-bottom: 18px !important;
          }
          .tilth-records-form-column,
          .tilth-records-diary-column {
            overflow: visible !important;
            padding-right: 0 !important;
            min-height: auto !important;
          }
          .tilth-records-stats {
            grid-template-columns: 1fr 1fr !important;
          }
          .tilth-records-filters {
            display: grid !important;
            grid-template-columns: 1fr !important;
          }
          .tilth-records-filters select {
            width: 100% !important;
          }
          .tilth-record-row {
            padding: 10px !important;
          }
          .tilth-record-row-grid {
            grid-template-columns: 1fr auto auto !important;
            gap: 8px !important;
            align-items: start !important;
          }
          .tilth-record-row-grid > *:nth-child(1),
          .tilth-record-row-grid > *:nth-child(2),
          .tilth-record-row-grid > *:nth-child(3),
          .tilth-record-row-grid > *:nth-child(4) {
            grid-column: 1 / -1;
          }
          .tilth-record-row-grid > *:nth-child(5) {
            grid-column: 2;
          }
          .tilth-record-row-grid > *:nth-child(6) {
            grid-column: 3;
          }
          .tilth-record-row-grid .tilth-icon-button {
            width: 40px !important;
            height: 40px !important;
            min-height: 40px !important;
            border-radius: 8px !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

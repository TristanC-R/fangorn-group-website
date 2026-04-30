import { useCallback, useMemo, useState } from "react";
import { brand, fonts, radius, inputStyle } from "../ui/theme.js";
import {
  Button,
  Card,
  EmptyState,
  FieldLabel,
  Kicker,
  Pill,
  SectionHeader,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { useLocalValue } from "../state/localStore.js";
import { cancelFarmTaskBySourceKey, titleWithSubject, upsertFarmTask } from "../../lib/farmTaskAutomation.js";

const CATEGORIES = [
  { value: "chemical", label: "Chemical" },
  { value: "fertiliser", label: "Fertiliser" },
  { value: "seed", label: "Seed" },
  { value: "fuel", label: "Fuel" },
  { value: "feed", label: "Feed" },
  { value: "veterinary", label: "Veterinary" },
  { value: "other", label: "Other" },
];

const UNITS = ["L", "kg", "units", "bags", "t"];

const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

const uid = () =>
  crypto.randomUUID?.() ||
  Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_FORM = {
  name: "",
  category: "chemical",
  unit: "L",
  quantity: "",
  unitCost: "",
  batchNumber: "",
  supplier: "",
  purchaseDate: today(),
  expiryDate: "",
  storageLocation: "",
  mappNumber: "",
  lowStockThreshold: "",
  notes: "",
};

function daysBetween(a, b) {
  return Math.floor(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function downloadCsv(items) {
  const headers = [
    "Name",
    "Category",
    "Quantity",
    "Unit",
    "Unit Cost",
    "Total Value",
    "Batch Number",
    "Supplier",
    "Purchase Date",
    "Expiry Date",
    "Storage Location",
    "MAPP Number",
    "Low Stock Threshold",
    "Notes",
  ];
  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const rows = items.map((it) => [
    it.name,
    CAT_MAP[it.category] || it.category,
    it.quantity,
    it.unit,
    it.unitCost,
    ((Number(it.quantity) || 0) * (Number(it.unitCost) || 0)).toFixed(2),
    it.batchNumber,
    it.supplier,
    it.purchaseDate,
    it.expiryDate,
    it.storageLocation,
    it.mappNumber,
    it.lowStockThreshold,
    it.notes,
  ]);
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventory-${today()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

function TabChip({ label, active, count, onClick }) {
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
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
      {count != null && (
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            opacity: 0.7,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function StatBox({ label, value, tone }) {
  const colors = {
    neutral: brand.forest,
    danger: brand.danger,
    warn: brand.warn,
    ok: brand.ok,
  };
  return (
    <div
      style={{
        border: `1px solid ${brand.border}`,
        background: brand.white,
        borderRadius: radius.base,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.muted,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 2,
          fontFamily: fonts.serif,
          fontSize: 22,
          color: colors[tone] || brand.forest,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function FormField({ label, htmlFor, children }) {
  return (
    <div>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
    </div>
  );
}

export function InventoryWorkspace({ farm }) {
  const farmId = farm?.id || null;
  const [items, setItems] = useLocalValue("inventory", farmId, []);
  const [catFilter, setCatFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [adjustId, setAdjustId] = useState(null);
  const [adjustAmt, setAdjustAmt] = useState("");

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const nowIso = today();

  const stats = useMemo(() => {
    let expired = 0;
    let expiringSoon = 0;
    let totalValue = 0;
    for (const it of items) {
      const q = Number(it.quantity) || 0;
      const c = Number(it.unitCost) || 0;
      totalValue += q * c;
      if (it.expiryDate) {
        const d = daysBetween(nowIso, it.expiryDate);
        if (d < 0) expired++;
        else if (d <= 30) expiringSoon++;
      }
    }
    return {
      total: items.length,
      expired,
      expiringSoon,
      totalValue,
    };
  }, [items, nowIso]);

  const filtered = useMemo(() => {
    if (catFilter === "all") return items;
    return items.filter((it) => it.category === catFilter);
  }, [items, catFilter]);

  const catCounts = useMemo(() => {
    const counts = { all: items.length };
    for (const c of CATEGORIES) counts[c.value] = 0;
    for (const it of items) {
      if (counts[it.category] != null) counts[it.category]++;
    }
    return counts;
  }, [items]);

  const openAdd = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (it) => {
    setEditId(it.id);
    setForm({
      name: it.name || "",
      category: it.category || "other",
      unit: it.unit || "L",
      quantity: it.quantity != null ? String(it.quantity) : "",
      unitCost: it.unitCost != null ? String(it.unitCost) : "",
      batchNumber: it.batchNumber || "",
      supplier: it.supplier || "",
      purchaseDate: it.purchaseDate || "",
      expiryDate: it.expiryDate || "",
      storageLocation: it.storageLocation || "",
      mappNumber: it.mappNumber || "",
      lowStockThreshold:
        it.lowStockThreshold != null ? String(it.lowStockThreshold) : "",
      notes: it.notes || "",
    });
    setShowForm(true);
  };

  const save = () => {
    if (!form.name.trim()) return;
    const id = editId || uid();
    const entry = {
      ...form,
      quantity: Number(form.quantity) || 0,
      unitCost: Number(form.unitCost) || 0,
      lowStockThreshold: form.lowStockThreshold
        ? Number(form.lowStockThreshold)
        : null,
    };
    if (editId) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === editId
            ? { ...it, ...entry, updatedAt: new Date().toISOString() }
            : it
        )
      );
    } else {
      setItems((prev) => [
        ...prev,
        {
          id,
          ...entry,
          adjustments: [],
          createdAt: new Date().toISOString(),
        },
      ]);
    }
    if (entry.expiryDate) {
      upsertFarmTask(farmId, {
        sourceKey: `inventory:${id}:expiry`,
        source: "inventory",
        sourceId: id,
        title: titleWithSubject("Stock expires", entry.name.trim()),
        dueDate: entry.expiryDate,
        category: "inventory",
        priority: "medium",
        notes: "Automatically created from an inventory expiry date.",
      });
    } else if (editId) {
      cancelFarmTaskBySourceKey(farmId, `inventory:${id}:expiry`);
    }
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_FORM);
  };

  const remove = (id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    cancelFarmTaskBySourceKey(farmId, `inventory:${id}:expiry`);
    if (editId === id) {
      setShowForm(false);
      setEditId(null);
    }
  };

  const applyAdjust = (id, delta) => {
    const d = Number(delta);
    if (!d) return;
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const newQty = Math.max(0, (Number(it.quantity) || 0) + d);
        const adj = {
          date: new Date().toISOString(),
          delta: d,
          resultQty: newQty,
        };
        return {
          ...it,
          quantity: newQty,
          adjustments: [...(it.adjustments || []), adj],
        };
      })
    );
    setAdjustId(null);
    setAdjustAmt("");
  };

  const expiryTone = useCallback(
    (expiryDate) => {
      if (!expiryDate) return null;
      const d = daysBetween(nowIso, expiryDate);
      if (d < 0) return "danger";
      if (d <= 30) return "warn";
      return null;
    },
    [nowIso]
  );

  const lowStockTone = (it) => {
    if (it.lowStockThreshold == null) return null;
    return (Number(it.quantity) || 0) < it.lowStockThreshold ? "warn" : null;
  };

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Inventory"
          title="Chemical store & inventory"
          description="Track chemicals, fertilisers, seed, fuel and feed stock. Expiry alerts, low-stock warnings and full adjustment history for Red Tractor / NRoSO compliance."
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => downloadCsv(items)}
                disabled={!items.length}
              >
                Export CSV
              </Button>
              <Button variant="primary" size="sm" onClick={openAdd}>
                Add product
              </Button>
            </>
          }
        />
      }
    >
      <div
        className="tilth-scroll"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <div
          className="tilth-inventory-stats"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <StatBox label="Total items" value={stats.total} tone="neutral" />
          <StatBox label="Expired" value={stats.expired} tone={stats.expired ? "danger" : "neutral"} />
          <StatBox
            label="Expiring ≤ 30d"
            value={stats.expiringSoon}
            tone={stats.expiringSoon ? "warn" : "neutral"}
          />
          <StatBox
            label="Est. value"
            value={`£${stats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            tone="neutral"
          />
        </div>

        <div
          className="tilth-inventory-tabs"
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <TabChip
            label="All"
            count={catCounts.all}
            active={catFilter === "all"}
            onClick={() => setCatFilter("all")}
          />
          {CATEGORIES.map((c) => (
            <TabChip
              key={c.value}
              label={c.label}
              count={catCounts[c.value]}
              active={catFilter === c.value}
              onClick={() => setCatFilter(c.value)}
            />
          ))}
        </div>

        {showForm && (
          <Card className="tilth-inventory-form-card" padding={16} style={{ marginBottom: 14 }}>
            <div
              className="tilth-inventory-form-header"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <Kicker>{editId ? "Edit product" : "Add product"}</Kicker>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 16,
                  color: brand.muted,
                }}
              >
                ×
              </button>
            </div>
            <div
              className="tilth-inventory-form-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 12,
              }}
            >
              <FormField label="Product name" htmlFor="inv-name">
                <input
                  id="inv-name"
                  style={inputStyle}
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Roundup ProActive"
                />
              </FormField>
              <FormField label="Category" htmlFor="inv-cat">
                <select
                  id="inv-cat"
                  style={inputStyle}
                  value={form.category}
                  onChange={(e) => set("category", e.target.value)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Unit" htmlFor="inv-unit">
                <select
                  id="inv-unit"
                  style={inputStyle}
                  value={form.unit}
                  onChange={(e) => set("unit", e.target.value)}
                >
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Quantity" htmlFor="inv-qty">
                <input
                  id="inv-qty"
                  type="number"
                  min="0"
                  style={inputStyle}
                  value={form.quantity}
                  onChange={(e) => set("quantity", e.target.value)}
                />
              </FormField>
              <FormField label="Unit cost (£)" htmlFor="inv-cost">
                <input
                  id="inv-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  style={inputStyle}
                  value={form.unitCost}
                  onChange={(e) => set("unitCost", e.target.value)}
                />
              </FormField>
              <FormField label="Batch number" htmlFor="inv-batch">
                <input
                  id="inv-batch"
                  style={inputStyle}
                  value={form.batchNumber}
                  onChange={(e) => set("batchNumber", e.target.value)}
                />
              </FormField>
              <FormField label="Supplier" htmlFor="inv-sup">
                <input
                  id="inv-sup"
                  style={inputStyle}
                  value={form.supplier}
                  onChange={(e) => set("supplier", e.target.value)}
                />
              </FormField>
              <FormField label="Purchase date" htmlFor="inv-pdate">
                <input
                  id="inv-pdate"
                  type="date"
                  style={inputStyle}
                  value={form.purchaseDate}
                  onChange={(e) => set("purchaseDate", e.target.value)}
                />
              </FormField>
              <FormField label="Expiry date" htmlFor="inv-exp">
                <input
                  id="inv-exp"
                  type="date"
                  style={inputStyle}
                  value={form.expiryDate}
                  onChange={(e) => set("expiryDate", e.target.value)}
                />
              </FormField>
              <FormField label="Storage location" htmlFor="inv-loc">
                <input
                  id="inv-loc"
                  style={inputStyle}
                  value={form.storageLocation}
                  onChange={(e) => set("storageLocation", e.target.value)}
                  placeholder="e.g. Barn 2, Shelf A"
                />
              </FormField>
              <FormField label="MAPP number" htmlFor="inv-mapp">
                <input
                  id="inv-mapp"
                  style={inputStyle}
                  value={form.mappNumber}
                  onChange={(e) => set("mappNumber", e.target.value)}
                  placeholder="For chemicals"
                />
              </FormField>
              <FormField label="Low stock threshold" htmlFor="inv-thresh">
                <input
                  id="inv-thresh"
                  type="number"
                  min="0"
                  style={inputStyle}
                  value={form.lowStockThreshold}
                  onChange={(e) => set("lowStockThreshold", e.target.value)}
                />
              </FormField>
            </div>
            <FormField label="Notes" htmlFor="inv-notes">
              <textarea
                id="inv-notes"
                style={{ ...inputStyle, minHeight: 52, resize: "vertical", marginTop: 4 }}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </FormField>
            <div
              className="tilth-inventory-form-actions"
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 12,
              }}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                disabled={!form.name.trim()}
              >
                {editId ? "Update" : "Add"}
              </Button>
            </div>
          </Card>
        )}

        {!filtered.length ? (
          <EmptyState
            kicker="No products"
            title={
              catFilter === "all"
                ? "Your inventory is empty"
                : `No ${CAT_MAP[catFilter] || catFilter} products`
            }
            description="Add products to track stock levels, expiry dates and storage locations."
            actions={
              <Button variant="primary" size="sm" onClick={openAdd}>
                Add first product
              </Button>
            }
          />
        ) : (
          <Card padding={0} style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: fonts.sans,
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr>
                    {[
                      "Product",
                      "Category",
                      "Qty",
                      "Unit",
                      "Expiry",
                      "Location",
                      "Value",
                      "",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 12px",
                          textAlign: "left",
                          fontFamily: fonts.mono,
                          fontSize: 9,
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                          color: brand.muted,
                          fontWeight: 400,
                          background: brand.bgSection,
                          borderBottom: `1px solid ${brand.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => {
                    const eTone = expiryTone(it.expiryDate);
                    const lTone = lowStockTone(it);
                    const rowBg =
                      eTone === "danger"
                        ? brand.dangerSoft
                        : eTone === "warn"
                          ? brand.warnSoft
                          : lTone === "warn"
                            ? brand.warnSoft
                            : brand.white;
                    const val =
                      (Number(it.quantity) || 0) *
                      (Number(it.unitCost) || 0);
                    return (
                      <tr key={it.id} style={{ background: rowBg }}>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            fontWeight: 600,
                            color: brand.forest,
                          }}
                        >
                          {it.name}
                          {it.mappNumber && (
                            <span
                              style={{
                                display: "block",
                                fontFamily: fonts.mono,
                                fontSize: 10,
                                color: brand.muted,
                                fontWeight: 400,
                              }}
                            >
                              MAPP {it.mappNumber}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                          }}
                        >
                          <Pill
                            tone={
                              it.category === "chemical"
                                ? "info"
                                : it.category === "fertiliser"
                                  ? "ok"
                                  : "neutral"
                            }
                          >
                            {CAT_MAP[it.category] || it.category}
                          </Pill>
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            fontFamily: fonts.mono,
                            fontSize: 13,
                            fontWeight: 600,
                            color: lTone === "warn" ? brand.warn : brand.forest,
                            whiteSpace: "nowrap",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {adjustId === it.id ? (
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <input
                                  type="number"
                                  style={{
                                    ...inputStyle,
                                    width: 60,
                                    padding: "4px 6px",
                                    fontSize: 12,
                                  }}
                                  value={adjustAmt}
                                  onChange={(e) =>
                                    setAdjustAmt(e.target.value)
                                  }
                                  placeholder="±"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter")
                                      applyAdjust(it.id, adjustAmt);
                                    if (e.key === "Escape") {
                                      setAdjustId(null);
                                      setAdjustAmt("");
                                    }
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    applyAdjust(it.id, adjustAmt)
                                  }
                                  style={{
                                    border: `1px solid ${brand.forest}`,
                                    background: brand.forest,
                                    color: brand.white,
                                    borderRadius: radius.base,
                                    padding: "3px 8px",
                                    fontSize: 10,
                                    cursor: "pointer",
                                  }}
                                >
                                  ✓
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAdjustId(null);
                                    setAdjustAmt("");
                                  }}
                                  style={{
                                    border: `1px solid ${brand.border}`,
                                    background: brand.white,
                                    color: brand.muted,
                                    borderRadius: radius.base,
                                    padding: "3px 8px",
                                    fontSize: 10,
                                    cursor: "pointer",
                                  }}
                                >
                                  ×
                                </button>
                              </div>
                            ) : (
                              <>
                                <span>{Number(it.quantity) || 0}</span>
                                <button
                                  type="button"
                                  onClick={() => applyAdjust(it.id, -1)}
                                  style={{
                                    border: `1px solid ${brand.border}`,
                                    background: brand.white,
                                    borderRadius: radius.base,
                                    width: 22,
                                    height: 22,
                                    fontSize: 14,
                                    cursor: "pointer",
                                    color: brand.forest,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: 0,
                                  }}
                                >
                                  −
                                </button>
                                <button
                                  type="button"
                                  onClick={() => applyAdjust(it.id, 1)}
                                  style={{
                                    border: `1px solid ${brand.border}`,
                                    background: brand.white,
                                    borderRadius: radius.base,
                                    width: 22,
                                    height: 22,
                                    fontSize: 14,
                                    cursor: "pointer",
                                    color: brand.forest,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: 0,
                                  }}
                                >
                                  +
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAdjustId(it.id);
                                    setAdjustAmt("");
                                  }}
                                  style={{
                                    border: `1px solid ${brand.border}`,
                                    background: brand.white,
                                    borderRadius: radius.base,
                                    padding: "2px 6px",
                                    fontSize: 9,
                                    fontFamily: fonts.mono,
                                    letterSpacing: "0.1em",
                                    textTransform: "uppercase",
                                    cursor: "pointer",
                                    color: brand.muted,
                                  }}
                                >
                                  ±
                                </button>
                              </>
                            )}
                          </div>
                          {lTone === "warn" && (
                            <span
                              style={{
                                fontSize: 9,
                                fontFamily: fonts.mono,
                                letterSpacing: "0.10em",
                                color: brand.warn,
                                fontWeight: 400,
                              }}
                            >
                              Below {it.lowStockThreshold}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            color: brand.bodySoft,
                          }}
                        >
                          {it.unit}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            color:
                              eTone === "danger"
                                ? brand.danger
                                : eTone === "warn"
                                  ? brand.warn
                                  : brand.bodySoft,
                            fontWeight: eTone ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmtDate(it.expiryDate)}
                          {eTone === "danger" && (
                            <span
                              style={{
                                display: "block",
                                fontSize: 9,
                                fontFamily: fonts.mono,
                                letterSpacing: "0.10em",
                              }}
                            >
                              EXPIRED
                            </span>
                          )}
                          {eTone === "warn" && (
                            <span
                              style={{
                                display: "block",
                                fontSize: 9,
                                fontFamily: fonts.mono,
                                letterSpacing: "0.10em",
                              }}
                            >
                              {daysBetween(nowIso, it.expiryDate)}d remaining
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            color: brand.bodySoft,
                          }}
                        >
                          {it.storageLocation || "—"}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            fontFamily: fonts.mono,
                            fontSize: 11,
                            color: brand.forest,
                            whiteSpace: "nowrap",
                          }}
                        >
                          £{val.toFixed(2)}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            borderBottom: `1px solid ${brand.border}`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => openEdit(it)}
                              style={{
                                border: `1px solid ${brand.border}`,
                                background: brand.white,
                                borderRadius: radius.base,
                                padding: "4px 8px",
                                fontSize: 10,
                                fontFamily: fonts.mono,
                                letterSpacing: "0.10em",
                                textTransform: "uppercase",
                                cursor: "pointer",
                                color: brand.forest,
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(it.id)}
                              style={{
                                border: `1px solid ${brand.danger}`,
                                background: brand.white,
                                borderRadius: radius.base,
                                padding: "4px 8px",
                                fontSize: 10,
                                fontFamily: fonts.mono,
                                letterSpacing: "0.10em",
                                textTransform: "uppercase",
                                cursor: "pointer",
                                color: brand.danger,
                              }}
                            >
                              Del
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        <style>{`
          @media (max-width: 760px) {
            .tilth-inventory-stats {
              grid-template-columns: 1fr 1fr !important;
              gap: 8px !important;
            }
            .tilth-inventory-tabs {
              overflow-x: auto !important;
              flex-wrap: nowrap !important;
              padding-bottom: 4px !important;
            }
            .tilth-inventory-tabs button {
              flex: 0 0 auto;
              min-height: 40px !important;
              border-radius: 8px !important;
            }
            .tilth-inventory-form-card {
              padding: 14px !important;
              margin-left: 0 !important;
              margin-right: 0 !important;
              max-width: 100% !important;
              overflow: visible !important;
            }
            .tilth-inventory-form-header {
              align-items: flex-start !important;
              gap: 10px !important;
            }
            .tilth-inventory-form-header button {
              width: 40px !important;
              height: 40px !important;
              min-height: 40px !important;
              border: 1px solid ${brand.border} !important;
              border-radius: 8px !important;
              background: ${brand.white} !important;
            }
            .tilth-inventory-form-grid {
              grid-template-columns: 1fr !important;
              gap: 10px !important;
            }
            .tilth-inventory-form-actions {
              display: grid !important;
              grid-template-columns: 1fr !important;
              gap: 8px !important;
            }
            .tilth-inventory-form-actions button {
              width: 100% !important;
            }
          }
          @media (max-width: 430px) {
            .tilth-inventory-stats {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </div>
    </WorkspaceFrame>
  );
}

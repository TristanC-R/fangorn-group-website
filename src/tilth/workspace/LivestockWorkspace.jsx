import { useMemo, useState } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
import {
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
import { useLocalValue } from "../state/localStore.js";
import { addDays, cancelFarmTaskBySourceKey, titleWithSubject, upsertFarmTask } from "../../lib/farmTaskAutomation.js";

const uid = () =>
  crypto.randomUUID?.() ||
  Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const SPECIES = ["cattle", "sheep", "pig", "goat", "poultry", "horse", "other"];
const SEX_OPTIONS = ["male", "female", "castrate"];
const STATUS_OPTIONS = ["active", "sold", "dead", "culled", "missing"];
const DIRECTION_OPTIONS = ["on", "off"];
const ROUTE_OPTIONS = ["oral", "injection", "pour-on", "topical", "intramammary", "other"];
const BREEDING_TYPES = ["service", "scan", "birth", "weaning"];

function fmtDate(d) {
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

function daysRemaining(treatmentDate, withdrawalDays) {
  if (!treatmentDate || !withdrawalDays) return null;
  const treated = new Date(treatmentDate);
  const clearDate = new Date(treated);
  clearDate.setDate(clearDate.getDate() + Number(withdrawalDays));
  const now = new Date();
  const diff = Math.ceil((clearDate - now) / (1000 * 60 * 60 * 24));
  return diff;
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div className="tilth-livestock-tabbar" style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap", maxWidth: "100%" }}>
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            padding: "6px 12px",
            flex: "0 1 auto",
            minWidth: 0,
            borderRadius: radius.base,
            border: `1px solid ${active === t ? brand.forest : brand.border}`,
            background: active === t ? brand.bgSection : brand.white,
            color: brand.forest,
            cursor: "pointer",
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, allLabel = "All" }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: brand.muted,
        }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...inputStyle,
          width: "auto",
          padding: "4px 8px",
          fontSize: 11,
        }}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

// ─── Register Tab ─────────────────────────────────────────────────────

function RegisterTab({ animals, setAnimals }) {
  const [editing, setEditing] = useState(null);
  const [filterSpecies, setFilterSpecies] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [sortKey, setSortKey] = useState("tag");

  const blank = () => ({
    id: uid(),
    tag: "",
    name: "",
    species: "cattle",
    breed: "",
    sex: "female",
    dob: "",
    sireTag: "",
    damTag: "",
    status: "active",
    notes: "",
  });

  const filtered = useMemo(() => {
    let list = [...animals];
    if (filterSpecies) list = list.filter((a) => a.species === filterSpecies);
    if (filterStatus) list = list.filter((a) => a.status === filterStatus);
    list.sort((a, b) => {
      if (sortKey === "tag") return (a.tag || "").localeCompare(b.tag || "");
      if (sortKey === "species") return (a.species || "").localeCompare(b.species || "");
      if (sortKey === "status") return (a.status || "").localeCompare(b.status || "");
      return 0;
    });
    return list;
  }, [animals, filterSpecies, filterStatus, sortKey]);

  const activeCount = animals.filter((a) => a.status === "active").length;
  const speciesCounts = useMemo(() => {
    const map = {};
    for (const a of animals) {
      if (a.status !== "active") continue;
      map[a.species] = (map[a.species] || 0) + 1;
    }
    return map;
  }, [animals]);

  const save = (animal) => {
    setAnimals((prev) => {
      const idx = prev.findIndex((a) => a.id === animal.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = animal;
        return next;
      }
      return [...prev, animal];
    });
    setEditing(null);
  };

  const remove = (id) => {
    if (!window.confirm("Delete this animal record?")) return;
    setAnimals((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <Pill tone="forest">{activeCount} active</Pill>
        {Object.entries(speciesCounts).map(([sp, c]) => (
          <Pill key={sp} tone="neutral">
            {sp} {c}
          </Pill>
        ))}
        <div style={{ flex: 1 }} />
        <Button size="sm" onClick={() => setEditing(blank())}>
          + Add animal
        </Button>
      </div>

      {editing ? (
        <AnimalForm
          animal={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 10,
          alignItems: "center",
        }}
      >
        <FilterSelect
          label="Species"
          value={filterSpecies}
          onChange={setFilterSpecies}
          options={SPECIES}
        />
        <FilterSelect
          label="Status"
          value={filterStatus}
          onChange={setFilterStatus}
          options={STATUS_OPTIONS}
        />
        <div style={{ flex: 1 }} />
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.muted,
            }}
          >
            Sort
          </span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value)}
            style={{
              ...inputStyle,
              width: "auto",
              padding: "4px 8px",
              fontSize: 11,
            }}
          >
            <option value="tag">Tag</option>
            <option value="species">Species</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          kicker="No animals"
          title="Register your livestock"
          description="Add animals to keep track of your herd or flock."
          actions={
            !editing ? (
              <Button size="sm" onClick={() => setEditing(blank())}>
                + Add animal
              </Button>
            ) : null
          }
        />
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {filtered.map((a) => (
            <Row key={a.id} style={{ padding: "8px 10px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 12,
                      fontWeight: 600,
                      color: brand.forest,
                    }}
                  >
                    {a.tag || "—"}
                  </span>
                  {a.name ? (
                    <span
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 12,
                        color: brand.bodySoft,
                      }}
                    >
                      {a.name}
                    </span>
                  ) : null}
                  <Pill tone="neutral" style={{ fontSize: 9 }}>
                    {a.species}
                  </Pill>
                  {a.breed ? (
                    <span
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 11,
                        color: brand.muted,
                      }}
                    >
                      {a.breed}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Pill
                    tone={
                      a.status === "active"
                        ? "ok"
                        : a.status === "sold"
                        ? "info"
                        : a.status === "dead" || a.status === "culled"
                        ? "danger"
                        : "warn"
                    }
                    style={{ fontSize: 9 }}
                  >
                    {a.status}
                  </Pill>
                  <button
                    type="button"
                    onClick={() => setEditing({ ...a })}
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 9,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: brand.forest,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 4px",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      color: brand.muted,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 4px",
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            </Row>
          ))}
        </div>
      )}
    </>
  );
}

function AnimalForm({ animal, onSave, onCancel }) {
  const [form, setForm] = useState({ ...animal });
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Card className="tilth-livestock-form-card" padding={14} style={{ marginBottom: 12 }}>
      <Kicker style={{ marginBottom: 10 }}>
        {animal.tag ? "Edit animal" : "New animal"}
      </Kicker>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <FormField label="Tag number">
          <input
            value={form.tag}
            onChange={(e) => set("tag", e.target.value)}
            style={inputStyle}
            placeholder="UK 123456 00001"
          />
        </FormField>
        <FormField label="Name (optional)">
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Species">
          <select
            value={form.species}
            onChange={(e) => set("species", e.target.value)}
            style={inputStyle}
          >
            {SPECIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Breed">
          <input
            value={form.breed}
            onChange={(e) => set("breed", e.target.value)}
            style={inputStyle}
            placeholder="e.g. Hereford"
          />
        </FormField>
        <FormField label="Sex">
          <select
            value={form.sex}
            onChange={(e) => set("sex", e.target.value)}
            style={inputStyle}
          >
            {SEX_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Date of birth">
          <input
            type="date"
            value={form.dob}
            onChange={(e) => set("dob", e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Sire tag">
          <input
            value={form.sireTag}
            onChange={(e) => set("sireTag", e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Dam tag">
          <input
            value={form.damTag}
            onChange={(e) => set("damTag", e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Status">
          <select
            value={form.status}
            onChange={(e) => set("status", e.target.value)}
            style={inputStyle}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Notes">
          <input
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            style={inputStyle}
          />
        </FormField>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <Button size="sm" onClick={() => onSave(form)} disabled={!form.tag.trim()}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ─── Movements Tab ────────────────────────────────────────────────────

function MovementsTab({ movements, setMovements }) {
  const [showForm, setShowForm] = useState(false);

  const blank = () => ({
    id: uid(),
    direction: "on",
    date: new Date().toISOString().slice(0, 10),
    fromCph: "",
    toCph: "",
    reason: "",
    haulier: "",
    batchRef: "",
    animalCount: "",
    linkedTag: "",
    notes: "",
  });

  const [form, setForm] = useState(blank);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const sorted = useMemo(
    () => [...movements].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [movements]
  );

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const thisMonth = movements.filter((m) => m.date >= monthStart);
  const onCount = thisMonth.filter((m) => m.direction === "on").length;
  const offCount = thisMonth.filter((m) => m.direction === "off").length;

  const save = () => {
    if (!form.date) return;
    setMovements((prev) => [...prev, form]);
    setForm(blank());
    setShowForm(false);
  };

  const remove = (id) => {
    if (!window.confirm("Delete this movement record?")) return;
    setMovements((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <Pill tone="ok">On this month: {onCount}</Pill>
        <Pill tone="warn">Off this month: {offCount}</Pill>
        <div style={{ flex: 1 }} />
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Log movement"}
        </Button>
      </div>

      {showForm ? (
        <Card className="tilth-livestock-form-card" padding={14} style={{ marginBottom: 12 }}>
          <Kicker style={{ marginBottom: 10 }}>New movement</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Direction">
              <select
                value={form.direction}
                onChange={(e) => set("direction", e.target.value)}
                style={inputStyle}
              >
                {DIRECTION_OPTIONS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Date">
              <input
                type="date"
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="From CPH">
              <input
                value={form.fromCph}
                onChange={(e) => set("fromCph", e.target.value)}
                style={inputStyle}
                placeholder="12/345/6789"
              />
            </FormField>
            <FormField label="To CPH">
              <input
                value={form.toCph}
                onChange={(e) => set("toCph", e.target.value)}
                style={inputStyle}
                placeholder="12/345/6789"
              />
            </FormField>
            <FormField label="Reason">
              <input
                value={form.reason}
                onChange={(e) => set("reason", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Haulier">
              <input
                value={form.haulier}
                onChange={(e) => set("haulier", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Batch ref">
              <input
                value={form.batchRef}
                onChange={(e) => set("batchRef", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Animal count">
              <input
                type="number"
                min="0"
                value={form.animalCount}
                onChange={(e) => set("animalCount", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Linked animal tag">
              <input
                value={form.linkedTag}
                onChange={(e) => set("linkedTag", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Notes">
              <input
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                style={inputStyle}
              />
            </FormField>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <Button size="sm" onClick={save} disabled={!form.date}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          kicker="No movements"
          title="Log livestock movements"
          description="Record on-farm and off-farm movements to stay BCMS compliant."
        />
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {sorted.map((m) => (
            <Row key={m.id} style={{ padding: "8px 10px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Pill
                    tone={m.direction === "on" ? "ok" : "warn"}
                    style={{ fontSize: 9 }}
                  >
                    {m.direction}
                  </Pill>
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      color: brand.forest,
                    }}
                  >
                    {fmtDate(m.date)}
                  </span>
                  {m.animalCount ? (
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft }}>
                      {m.animalCount} head
                    </span>
                  ) : null}
                  {m.linkedTag ? (
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                      {m.linkedTag}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {m.fromCph || m.toCph ? (
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                      {m.fromCph || "?"} → {m.toCph || "?"}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => remove(m.id)}
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      color: brand.muted,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 4px",
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            </Row>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Medicines Tab ────────────────────────────────────────────────────

function MedicinesTab({ medicines, setMedicines, farmId }) {
  const [showForm, setShowForm] = useState(false);

  const blank = () => ({
    id: uid(),
    date: new Date().toISOString().slice(0, 10),
    animalTag: "",
    product: "",
    batchNumber: "",
    dosage: "",
    route: "injection",
    withdrawalMeatDays: "",
    withdrawalMilkDays: "",
    administeredBy: "",
    vetName: "",
    reason: "",
    notes: "",
  });

  const [form, setForm] = useState(blank);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const sorted = useMemo(
    () => [...medicines].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [medicines]
  );

  const save = () => {
    if (!form.date || !form.product) return;
    setMedicines((prev) => [...prev, form]);
    const animal = form.animalTag ? ` (${form.animalTag})` : "";
    const meatDue = addDays(form.date, form.withdrawalMeatDays);
    const milkDue = addDays(form.date, form.withdrawalMilkDays);
    if (meatDue) {
      upsertFarmTask(farmId, {
        sourceKey: `livestock_medicine:${form.id}:meat-withdrawal`,
        source: "livestock_medicine",
        sourceId: form.id,
        title: titleWithSubject("Meat withdrawal ends", `${form.product}${animal}`),
        dueDate: meatDue,
        category: "livestock",
        priority: "high",
        notes: "Automatically created from a livestock medicine treatment.",
      });
    }
    if (milkDue) {
      upsertFarmTask(farmId, {
        sourceKey: `livestock_medicine:${form.id}:milk-withdrawal`,
        source: "livestock_medicine",
        sourceId: form.id,
        title: titleWithSubject("Milk withdrawal ends", `${form.product}${animal}`),
        dueDate: milkDue,
        category: "livestock",
        priority: "high",
        notes: "Automatically created from a livestock medicine treatment.",
      });
    }
    setForm(blank());
    setShowForm(false);
  };

  const remove = (id) => {
    if (!window.confirm("Delete this treatment record?")) return;
    setMedicines((prev) => prev.filter((m) => m.id !== id));
    cancelFarmTaskBySourceKey(farmId, `livestock_medicine:${id}:meat-withdrawal`);
    cancelFarmTaskBySourceKey(farmId, `livestock_medicine:${id}:milk-withdrawal`);
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <Pill tone="neutral">{medicines.length} treatments</Pill>
        <div style={{ flex: 1 }} />
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Log treatment"}
        </Button>
      </div>

      {showForm ? (
        <Card className="tilth-livestock-form-card" padding={14} style={{ marginBottom: 12 }}>
          <Kicker style={{ marginBottom: 10 }}>New treatment</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Date">
              <input
                type="date"
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Animal tag (optional)">
              <input
                value={form.animalTag}
                onChange={(e) => set("animalTag", e.target.value)}
                style={inputStyle}
                placeholder="Leave blank for batch"
              />
            </FormField>
            <FormField label="Product name">
              <input
                value={form.product}
                onChange={(e) => set("product", e.target.value)}
                style={inputStyle}
                placeholder="e.g. Alamycin LA"
              />
            </FormField>
            <FormField label="Batch number">
              <input
                value={form.batchNumber}
                onChange={(e) => set("batchNumber", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Dosage">
              <input
                value={form.dosage}
                onChange={(e) => set("dosage", e.target.value)}
                style={inputStyle}
                placeholder="e.g. 10ml"
              />
            </FormField>
            <FormField label="Route">
              <select
                value={form.route}
                onChange={(e) => set("route", e.target.value)}
                style={inputStyle}
              >
                {ROUTE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Withdrawal — meat (days)">
              <input
                type="number"
                min="0"
                value={form.withdrawalMeatDays}
                onChange={(e) => set("withdrawalMeatDays", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Withdrawal — milk (days)">
              <input
                type="number"
                min="0"
                value={form.withdrawalMilkDays}
                onChange={(e) => set("withdrawalMilkDays", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Administered by">
              <input
                value={form.administeredBy}
                onChange={(e) => set("administeredBy", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Vet name">
              <input
                value={form.vetName}
                onChange={(e) => set("vetName", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Reason">
              <input
                value={form.reason}
                onChange={(e) => set("reason", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Notes">
              <input
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                style={inputStyle}
              />
            </FormField>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <Button
              size="sm"
              onClick={save}
              disabled={!form.date || !form.product}
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          kicker="No treatments"
          title="Log medicine treatments"
          description="Record treatments and track withdrawal periods."
        />
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {sorted.map((m) => {
            const meatDays = daysRemaining(m.date, m.withdrawalMeatDays);
            const milkDays = daysRemaining(m.date, m.withdrawalMilkDays);
            const meatActive = meatDays !== null && meatDays > 0;
            const milkActive = milkDays !== null && milkDays > 0;

            return (
              <Row key={m.id} style={{ padding: "8px 10px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 11,
                        color: brand.forest,
                      }}
                    >
                      {fmtDate(m.date)}
                    </span>
                    <span
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 12,
                        fontWeight: 600,
                        color: brand.forest,
                      }}
                    >
                      {m.product}
                    </span>
                    {m.animalTag ? (
                      <Pill tone="neutral" style={{ fontSize: 9 }}>
                        {m.animalTag}
                      </Pill>
                    ) : (
                      <Pill tone="info" style={{ fontSize: 9 }}>
                        batch
                      </Pill>
                    )}
                    <Pill tone="neutral" style={{ fontSize: 9 }}>
                      {m.route}
                    </Pill>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {m.withdrawalMeatDays ? (
                      <span
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: radius.base,
                          background: meatActive ? brand.dangerSoft : brand.okSoft,
                          color: meatActive ? brand.danger : brand.ok,
                          border: `1px solid ${meatActive ? brand.danger : brand.ok}`,
                          fontWeight: 600,
                        }}
                      >
                        Meat: {meatActive ? `${meatDays}d left` : "clear"}
                      </span>
                    ) : null}
                    {m.withdrawalMilkDays ? (
                      <span
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: radius.base,
                          background: milkActive ? brand.dangerSoft : brand.okSoft,
                          color: milkActive ? brand.danger : brand.ok,
                          border: `1px solid ${milkActive ? brand.danger : brand.ok}`,
                          fontWeight: 600,
                        }}
                      >
                        Milk: {milkActive ? `${milkDays}d left` : "clear"}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => remove(m.id)}
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        color: brand.muted,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: "2px 4px",
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              </Row>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Breeding Tab ─────────────────────────────────────────────────────

function BreedingTab({ breeding, setBreeding, farmId }) {
  const [showForm, setShowForm] = useState(false);

  const blank = () => ({
    id: uid(),
    type: "service",
    date: new Date().toISOString().slice(0, 10),
    expectedDate: "",
    damTag: "",
    sireTag: "",
    offspringCount: "",
    offspringAlive: "",
    scanResult: "",
    notes: "",
  });

  const [form, setForm] = useState(blank);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const sorted = useMemo(
    () => [...breeding].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [breeding]
  );

  const upcoming = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return breeding
      .filter((b) => b.expectedDate && b.expectedDate >= today)
      .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  }, [breeding]);

  const save = () => {
    if (!form.date || !form.type) return;
    setBreeding((prev) => [...prev, form]);
    if (form.expectedDate) {
      const subject = form.damTag || form.sireTag || form.type;
      upsertFarmTask(farmId, {
        sourceKey: `livestock_breeding:${form.id}:expected`,
        source: "livestock_breeding",
        sourceId: form.id,
        title: titleWithSubject(`Breeding ${form.type} expected`, subject),
        dueDate: form.expectedDate,
        category: "livestock",
        priority: "medium",
        notes: "Automatically created from a livestock breeding record.",
      });
    }
    setForm(blank());
    setShowForm(false);
  };

  const remove = (id) => {
    if (!window.confirm("Delete this breeding record?")) return;
    setBreeding((prev) => prev.filter((b) => b.id !== id));
    cancelFarmTaskBySourceKey(farmId, `livestock_breeding:${id}:expected`);
  };

  const typeColor = (t) => {
    switch (t) {
      case "service": return "info";
      case "scan": return "neutral";
      case "birth": return "ok";
      case "weaning": return "warn";
      default: return "neutral";
    }
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <Pill tone="neutral">{breeding.length} events</Pill>
        <div style={{ flex: 1 }} />
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Add event"}
        </Button>
      </div>

      {showForm ? (
        <Card className="tilth-livestock-form-card" padding={14} style={{ marginBottom: 12 }}>
          <Kicker style={{ marginBottom: 10 }}>New breeding event</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Event type">
              <select
                value={form.type}
                onChange={(e) => set("type", e.target.value)}
                style={inputStyle}
              >
                {BREEDING_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Date">
              <input
                type="date"
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Expected date">
              <input
                type="date"
                value={form.expectedDate}
                onChange={(e) => set("expectedDate", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Dam tag">
              <input
                value={form.damTag}
                onChange={(e) => set("damTag", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Sire tag">
              <input
                value={form.sireTag}
                onChange={(e) => set("sireTag", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Offspring count">
              <input
                type="number"
                min="0"
                value={form.offspringCount}
                onChange={(e) => set("offspringCount", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Offspring alive">
              <input
                type="number"
                min="0"
                value={form.offspringAlive}
                onChange={(e) => set("offspringAlive", e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Scan result">
              <input
                value={form.scanResult}
                onChange={(e) => set("scanResult", e.target.value)}
                style={inputStyle}
                placeholder="e.g. twins, empty"
              />
            </FormField>
          </div>
          <FormField label="Notes">
            <input
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              style={{ ...inputStyle, marginTop: 8 }}
            />
          </FormField>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <Button size="sm" onClick={save} disabled={!form.date}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {upcoming.length > 0 ? (
        <Card
          padding={12}
          style={{
            marginBottom: 12,
            border: `1px solid ${brand.forest}44`,
            background: "#f0f6f0",
          }}
        >
          <Kicker style={{ marginBottom: 8 }}>Upcoming expected dates</Kicker>
          <div style={{ display: "grid", gap: 4 }}>
            {upcoming.map((b) => {
              const daysUntil = Math.ceil(
                (new Date(b.expectedDate) - new Date()) / (1000 * 60 * 60 * 24)
              );
              return (
                <div
                  key={b.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: brand.white,
                    borderRadius: radius.base,
                    border: `1px solid ${brand.border}`,
                  }}
                >
                  <Pill tone={typeColor(b.type)} style={{ fontSize: 9 }}>
                    {b.type}
                  </Pill>
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      color: brand.forest,
                    }}
                  >
                    {fmtDate(b.expectedDate)}
                  </span>
                  <span
                    style={{
                      fontFamily: fonts.sans,
                      fontSize: 11,
                      color: brand.bodySoft,
                    }}
                  >
                    {daysUntil === 0
                      ? "today"
                      : daysUntil === 1
                      ? "tomorrow"
                      : `in ${daysUntil} days`}
                  </span>
                  {b.damTag ? (
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        color: brand.muted,
                      }}
                    >
                      Dam: {b.damTag}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          kicker="No events"
          title="Track breeding"
          description="Log services, scans, births and weaning events."
        />
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {sorted.map((b) => (
            <Row key={b.id} style={{ padding: "8px 10px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Pill tone={typeColor(b.type)} style={{ fontSize: 9 }}>
                    {b.type}
                  </Pill>
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      color: brand.forest,
                    }}
                  >
                    {fmtDate(b.date)}
                  </span>
                  {b.damTag ? (
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft }}>
                      Dam: {b.damTag}
                    </span>
                  ) : null}
                  {b.sireTag ? (
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft }}>
                      Sire: {b.sireTag}
                    </span>
                  ) : null}
                  {b.offspringCount ? (
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                      {b.offspringAlive || b.offspringCount}/{b.offspringCount} alive
                    </span>
                  ) : null}
                  {b.scanResult ? (
                    <Pill tone="neutral" style={{ fontSize: 9 }}>
                      {b.scanResult}
                    </Pill>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => remove(b.id)}
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    color: brand.muted,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px 4px",
                  }}
                >
                  ×
                </button>
              </div>
            </Row>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Main Workspace ───────────────────────────────────────────────────

export function LivestockWorkspace({ farm }) {
  const farmId = farm?.id;
  const [tab, setTab] = useState("register");

  const [animals, setAnimals] = useLocalValue("livestock", farmId, []);
  const [movements, setMovements] = useLocalValue("livestock_movements", farmId, []);
  const [medicines, setMedicines] = useLocalValue("livestock_medicines", farmId, []);
  const [breeding, setBreeding] = useLocalValue("livestock_breeding", farmId, []);

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Animals"
          title="Livestock"
          description="Register, movements, medicines and breeding records."
        />
      }
    >
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: "0 0 auto" }}>
          <TabBar
            tabs={["register", "movements", "medicines", "breeding"]}
            active={tab}
            onChange={setTab}
          />
        </div>

        <div className="tilth-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          {tab === "register" ? (
            <RegisterTab
              animals={animals}
              setAnimals={setAnimals}
            />
          ) : tab === "movements" ? (
            <MovementsTab movements={movements} setMovements={setMovements} />
          ) : tab === "medicines" ? (
            <MedicinesTab medicines={medicines} setMedicines={setMedicines} farmId={farmId} />
          ) : tab === "breeding" ? (
            <BreedingTab breeding={breeding} setBreeding={setBreeding} farmId={farmId} />
          ) : null}
        </div>
      </div>
    </WorkspaceFrame>
  );
}

import { useMemo, useState } from "react";
import { brand, fonts, radius, inputStyle } from "../ui/theme.js";
import {
  Body,
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
import { downloadXeroBankCsv } from "../../lib/xeroExport.js";

const uid = () =>
  crypto.randomUUID?.() ||
  Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const today = () => new Date().toISOString().slice(0, 10);

const INCOME_CATS = [
  { value: "grain_sale", label: "Grain sale" },
  { value: "livestock_sale", label: "Livestock sale" },
  { value: "subsidy", label: "Subsidy" },
  { value: "contracting_income", label: "Contracting income" },
  { value: "other_income", label: "Other income" },
];

const EXPENSE_CATS = [
  { value: "seed", label: "Seed" },
  { value: "chemical", label: "Chemical" },
  { value: "fertiliser", label: "Fertiliser" },
  { value: "fuel", label: "Fuel" },
  { value: "vet", label: "Vet" },
  { value: "contractor", label: "Contractor" },
  { value: "rent", label: "Rent" },
  { value: "machinery", label: "Machinery" },
  { value: "insurance", label: "Insurance" },
  { value: "labour", label: "Labour" },
  { value: "feed", label: "Feed" },
  { value: "other", label: "Other" },
];

const ALL_CATS = [...INCOME_CATS, ...EXPENSE_CATS];
const CAT_MAP = Object.fromEntries(ALL_CATS.map((c) => [c.value, c.label]));

const TABS = [
  { id: "ledger", label: "Ledger" },
  { id: "summary", label: "Summary" },
  { id: "byfield", label: "By field" },
];

const DATE_FILTERS = [
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "all", label: "All" },
];

function dateFilterRange(filter) {
  const now = new Date();
  if (filter === "all") return { start: null, end: null };
  if (filter === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: s, end: now };
  }
  if (filter === "quarter") {
    const qm = Math.floor(now.getMonth() / 3) * 3;
    const s = new Date(now.getFullYear(), qm, 1);
    return { start: s, end: now };
  }
  const s = new Date(now.getFullYear(), 0, 1);
  return { start: s, end: now };
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

function fmtMoney(v) {
  const n = Number(v) || 0;
  return (
    (n < 0 ? "−" : "") +
    "£" +
    Math.abs(n).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

const EMPTY_FORM = {
  type: "expense",
  date: today(),
  amount: "",
  vatAmount: "",
  category: "seed",
  description: "",
  counterparty: "",
  invoiceRef: "",
  fieldId: "",
  notes: "",
};

function TabChip({ label, active, onClick }) {
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

function StatBox({ label, value, tone }) {
  const colors = {
    neutral: brand.forest,
    ok: brand.ok,
    danger: brand.danger,
    warn: brand.warn,
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

function BarSegment({ value, max, color, label }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 6,
      }}
    >
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 11,
          color: brand.forest,
          minWidth: 120,
          textAlign: "right",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: "1 1 auto",
          height: 16,
          background: brand.bgSection,
          borderRadius: radius.base,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            borderRadius: radius.base,
            transition: "width 200ms ease",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: brand.forest,
          minWidth: 70,
          textAlign: "right",
        }}
      >
        {fmtMoney(value)}
      </span>
    </div>
  );
}

export function FinanceWorkspace({ farm, fields }) {
  const farmId = farm?.id || null;
  const [transactions, setTransactions] = useLocalValue("finances", farmId, []);
  const [tab, setTab] = useState("ledger");
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [typeFilter, setTypeFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("year");
  const [summaryPeriod, setSummaryPeriod] = useState("year");

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const fieldMap = useMemo(() => {
    const m = {};
    for (const f of fields || []) m[f.id] = f.name || "Unnamed";
    return m;
  }, [fields]);

  const dateRange = useMemo(() => dateFilterRange(dateFilter), [dateFilter]);

  const filtered = useMemo(() => {
    let list = [...transactions].sort(
      (a, b) => (b.date || "").localeCompare(a.date || "")
    );
    if (typeFilter !== "all")
      list = list.filter((t) => t.type === typeFilter);
    if (catFilter !== "all")
      list = list.filter((t) => t.category === catFilter);
    if (dateRange.start) {
      const s = dateRange.start.getTime();
      const e = dateRange.end.getTime();
      list = list.filter((t) => {
        const d = new Date(t.date).getTime();
        return d >= s && d <= e;
      });
    }
    return list;
  }, [transactions, typeFilter, catFilter, dateRange]);

  const openAdd = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (t) => {
    setEditId(t.id);
    setForm({
      type: t.type || "expense",
      date: t.date || "",
      amount: t.amount != null ? String(t.amount) : "",
      vatAmount: t.vatAmount != null ? String(t.vatAmount) : "",
      category: t.category || "other",
      description: t.description || "",
      counterparty: t.counterparty || "",
      invoiceRef: t.invoiceRef || "",
      fieldId: t.fieldId || "",
      notes: t.notes || "",
    });
    setShowForm(true);
  };

  const save = () => {
    if (!form.amount) return;
    const entry = {
      ...form,
      amount: Number(form.amount) || 0,
      vatAmount: Number(form.vatAmount) || 0,
    };
    if (editId) {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === editId
            ? { ...t, ...entry, updatedAt: new Date().toISOString() }
            : t
        )
      );
    } else {
      setTransactions((prev) => [
        ...prev,
        { id: uid(), ...entry, createdAt: new Date().toISOString() },
      ]);
    }
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_FORM);
  };

  const remove = (id) => {
    setTransactions((prev) => prev.filter((t) => t.id !== id));
    if (editId === id) {
      setShowForm(false);
      setEditId(null);
    }
  };

  const summaryRange = useMemo(
    () => dateFilterRange(summaryPeriod),
    [summaryPeriod]
  );

  const summaryData = useMemo(() => {
    let list = transactions;
    if (summaryRange.start) {
      const s = summaryRange.start.getTime();
      const e = summaryRange.end.getTime();
      list = list.filter((t) => {
        const d = new Date(t.date).getTime();
        return d >= s && d <= e;
      });
    }
    let totalIncome = 0;
    let totalExpenses = 0;
    let vatIncome = 0;
    let vatExpenses = 0;
    const byCat = {};

    for (const t of list) {
      const amt = Number(t.amount) || 0;
      const vat = Number(t.vatAmount) || 0;
      if (t.type === "income") {
        totalIncome += amt;
        vatIncome += vat;
      } else {
        totalExpenses += amt;
        vatExpenses += vat;
      }
      const catKey = `${t.type}:${t.category}`;
      byCat[catKey] = (byCat[catKey] || 0) + amt;
    }

    const incomeCats = INCOME_CATS.map((c) => ({
      ...c,
      total: byCat[`income:${c.value}`] || 0,
    })).filter((c) => c.total > 0);

    const expenseCats = EXPENSE_CATS.map((c) => ({
      ...c,
      total: byCat[`expense:${c.value}`] || 0,
    })).filter((c) => c.total > 0);

    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      const label = d.toLocaleDateString(undefined, {
        month: "short",
      });
      let inc = 0;
      let exp = 0;
      for (const t of transactions) {
        if (!t.date) continue;
        if (t.date.slice(0, 7) === key) {
          if (t.type === "income") inc += Number(t.amount) || 0;
          else exp += Number(t.amount) || 0;
        }
      }
      months.push({ key, label, income: inc, expense: exp });
    }
    const maxMonth = Math.max(
      1,
      ...months.map((m) => Math.max(m.income, m.expense))
    );

    return {
      totalIncome,
      totalExpenses,
      net: totalIncome - totalExpenses,
      vatIncome,
      vatExpenses,
      vatNet: vatIncome - vatExpenses,
      incomeCats,
      expenseCats,
      months,
      maxMonth,
      maxIncomeCat: Math.max(1, ...incomeCats.map((c) => c.total)),
      maxExpenseCat: Math.max(1, ...expenseCats.map((c) => c.total)),
    };
  }, [transactions, summaryRange]);

  const byFieldData = useMemo(() => {
    const map = {};
    for (const t of transactions) {
      if (!t.fieldId) continue;
      if (!map[t.fieldId])
        map[t.fieldId] = { income: 0, expenses: 0, name: fieldMap[t.fieldId] || t.fieldId };
      if (t.type === "income") map[t.fieldId].income += Number(t.amount) || 0;
      else map[t.fieldId].expenses += Number(t.amount) || 0;
    }
    return Object.entries(map)
      .map(([id, d]) => ({
        fieldId: id,
        name: d.name,
        income: d.income,
        expenses: d.expenses,
        margin: d.income - d.expenses,
      }))
      .sort((a, b) => b.margin - a.margin);
  }, [transactions, fieldMap]);

  const catsForType =
    form.type === "income" ? INCOME_CATS : EXPENSE_CATS;

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Money"
          title="Farm finance"
          description="Income and expense ledger with profit/loss summaries, VAT tracking and per-field margin analysis."
          actions={
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button variant="secondary" size="sm" onClick={() => downloadXeroBankCsv(transactions, farm?.name || "farm")} disabled={!transactions.length}>
                Xero CSV
              </Button>
              <Button variant="primary" size="sm" onClick={openAdd}>
                Add transaction
              </Button>
            </div>
          }
        />
      }
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 10,
          flex: "0 0 auto",
        }}
      >
        {TABS.map((t) => (
          <TabChip
            key={t.id}
            label={t.label}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
          />
        ))}
      </div>

      <div
        className="tilth-scroll"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {tab === "ledger" && (
          <LedgerTab
            filtered={filtered}
            typeFilter={typeFilter}
            setTypeFilter={setTypeFilter}
            catFilter={catFilter}
            setCatFilter={setCatFilter}
            dateFilter={dateFilter}
            setDateFilter={setDateFilter}
            showForm={showForm}
            setShowForm={setShowForm}
            editId={editId}
            setEditId={setEditId}
            form={form}
            set={set}
            save={save}
            remove={remove}
            openAdd={openAdd}
            openEdit={openEdit}
            catsForType={catsForType}
            fieldMap={fieldMap}
            fields={fields}
          />
        )}
        {tab === "summary" && (
          <SummaryTab
            data={summaryData}
            period={summaryPeriod}
            setPeriod={setSummaryPeriod}
          />
        )}
        {tab === "byfield" && (
          <ByFieldTab data={byFieldData} />
        )}
      </div>
    </WorkspaceFrame>
  );
}

function LedgerTab({
  filtered,
  typeFilter,
  setTypeFilter,
  catFilter,
  setCatFilter,
  dateFilter,
  setDateFilter,
  showForm,
  setShowForm,
  editId,
  setEditId,
  form,
  set,
  save,
  remove,
  openAdd,
  openEdit,
  catsForType,
  fieldMap,
  fields,
}) {
  const ledgerIncome = filtered
    .filter((t) => t.type === "income")
    .reduce((a, t) => a + (Number(t.amount) || 0), 0);
  const ledgerExpense = filtered
    .filter((t) => t.type === "expense")
    .reduce((a, t) => a + (Number(t.amount) || 0), 0);

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <StatBox label="Income (filtered)" value={fmtMoney(ledgerIncome)} tone="ok" />
        <StatBox label="Expenses (filtered)" value={fmtMoney(ledgerExpense)} tone="danger" />
        <StatBox
          label="Net"
          value={fmtMoney(ledgerIncome - ledgerExpense)}
          tone={ledgerIncome - ledgerExpense >= 0 ? "ok" : "danger"}
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 14,
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
          Type
        </span>
        {["all", "income", "expense"].map((v) => (
          <TabChip
            key={v}
            label={v === "all" ? "All" : v === "income" ? "Income" : "Expense"}
            active={typeFilter === v}
            onClick={() => setTypeFilter(v)}
          />
        ))}
        <span style={{ width: 12 }} />
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: brand.muted,
          }}
        >
          Period
        </span>
        {DATE_FILTERS.map((d) => (
          <TabChip
            key={d.value}
            label={d.label}
            active={dateFilter === d.value}
            onClick={() => setDateFilter(d.value)}
          />
        ))}
        <span style={{ width: 12 }} />
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: brand.muted,
          }}
        >
          Category
        </span>
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          style={{ ...inputStyle, width: "auto", padding: "4px 8px", fontSize: 11 }}
        >
          <option value="all">All categories</option>
          <optgroup label="Income">
            {INCOME_CATS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Expense">
            {EXPENSE_CATS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {showForm && (
        <Card className="tilth-finance-form-card" padding={16} style={{ marginBottom: 14 }}>
          <div
            className="tilth-finance-form-grid"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <Kicker>{editId ? "Edit transaction" : "Add transaction"}</Kicker>
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
            className="tilth-finance-form-actions"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
            }}
          >
            <FormField label="Type" htmlFor="fin-type">
              <select
                id="fin-type"
                style={inputStyle}
                value={form.type}
                onChange={(e) => {
                  set("type", e.target.value);
                  set(
                    "category",
                    e.target.value === "income"
                      ? INCOME_CATS[0].value
                      : EXPENSE_CATS[0].value
                  );
                }}
              >
                <option value="income">Income</option>
                <option value="expense">Expense</option>
              </select>
            </FormField>
            <FormField label="Date" htmlFor="fin-date">
              <input
                id="fin-date"
                type="date"
                style={inputStyle}
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
              />
            </FormField>
            <FormField label="Amount (£)" htmlFor="fin-amt">
              <input
                id="fin-amt"
                type="number"
                min="0"
                step="0.01"
                style={inputStyle}
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </FormField>
            <FormField label="VAT amount (£)" htmlFor="fin-vat">
              <input
                id="fin-vat"
                type="number"
                min="0"
                step="0.01"
                style={inputStyle}
                value={form.vatAmount}
                onChange={(e) => set("vatAmount", e.target.value)}
              />
            </FormField>
            <FormField label="Category" htmlFor="fin-cat">
              <select
                id="fin-cat"
                style={inputStyle}
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
              >
                {catsForType.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Description" htmlFor="fin-desc">
              <input
                id="fin-desc"
                style={inputStyle}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </FormField>
            <FormField label="Counterparty" htmlFor="fin-cp">
              <input
                id="fin-cp"
                style={inputStyle}
                value={form.counterparty}
                onChange={(e) => set("counterparty", e.target.value)}
              />
            </FormField>
            <FormField label="Invoice ref" htmlFor="fin-inv">
              <input
                id="fin-inv"
                style={inputStyle}
                value={form.invoiceRef}
                onChange={(e) => set("invoiceRef", e.target.value)}
              />
            </FormField>
            <FormField label="Field" htmlFor="fin-field">
              <select
                id="fin-field"
                style={inputStyle}
                value={form.fieldId}
                onChange={(e) => set("fieldId", e.target.value)}
              >
                <option value="">— None —</option>
                {(fields || []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name || f.id}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <FormField label="Notes" htmlFor="fin-notes">
            <textarea
              id="fin-notes"
              style={{
                ...inputStyle,
                minHeight: 48,
                resize: "vertical",
                marginTop: 4,
              }}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </FormField>
          <div
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
              disabled={!form.amount}
            >
              {editId ? "Update" : "Add"}
            </Button>
          </div>
        </Card>
      )}

      {!filtered.length ? (
        <EmptyState
          kicker="No transactions"
          title="Start recording income & expenses"
          description="Add transactions to build your farm financial ledger."
          actions={
            <Button variant="primary" size="sm" onClick={openAdd}>
              Add first transaction
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
                    "Date",
                    "Type",
                    "Category",
                    "Description",
                    "Amount",
                    "Counterparty",
                    "Field",
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
                {filtered.map((t) => (
                  <tr key={t.id}>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${brand.border}`,
                        whiteSpace: "nowrap",
                        color: brand.bodySoft,
                      }}
                    >
                      {fmtDate(t.date)}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${brand.border}`,
                      }}
                    >
                      <Pill tone={t.type === "income" ? "ok" : "danger"}>
                        {t.type === "income" ? "Income" : "Expense"}
                      </Pill>
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${brand.border}`,
                        color: brand.forest,
                      }}
                    >
                      {CAT_MAP[t.category] || t.category}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${brand.border}`,
                        color: brand.forest,
                        fontWeight: 500,
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.description || "—"}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${brand.border}`,
                        fontFamily: fonts.mono,
                        fontSize: 13,
                        fontWeight: 600,
                        color: t.type === "income" ? brand.ok : brand.danger,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.type === "income" ? "+" : "−"}
                      {fmtMoney(t.amount).replace("£", "£")}
                      {(Number(t.vatAmount) || 0) > 0 && (
                        <span
                          style={{
                            display: "block",
                            fontSize: 9,
                            fontWeight: 400,
                            color: brand.muted,
                          }}
                        >
                          VAT {fmtMoney(t.vatAmount)}
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
                      {t.counterparty || "—"}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: `1px solid ${brand.border}`,
                        color: brand.bodySoft,
                        fontSize: 11,
                      }}
                    >
                      {t.fieldId ? fieldMap[t.fieldId] || t.fieldId : "—"}
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
                          onClick={() => openEdit(t)}
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
                          onClick={() => remove(t.id)}
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
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function SummaryTab({ data, period, setPeriod }) {
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 14,
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
          Period
        </span>
        {DATE_FILTERS.filter((d) => d.value !== "all").map((d) => (
          <TabChip
            key={d.value}
            label={d.label}
            active={period === d.value}
            onClick={() => setPeriod(d.value)}
          />
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <StatBox label="Total income" value={fmtMoney(data.totalIncome)} tone="ok" />
        <StatBox
          label="Total expenses"
          value={fmtMoney(data.totalExpenses)}
          tone="danger"
        />
        <StatBox
          label="Net profit / loss"
          value={fmtMoney(data.net)}
          tone={data.net >= 0 ? "ok" : "danger"}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 18,
        }}
      >
        <Card padding={14}>
          <Kicker style={{ marginBottom: 10 }}>Income breakdown</Kicker>
          {data.incomeCats.length ? (
            data.incomeCats.map((c) => (
              <BarSegment
                key={c.value}
                label={c.label}
                value={c.total}
                max={data.maxIncomeCat}
                color={brand.ok}
              />
            ))
          ) : (
            <Body size="sm" color={brand.muted}>
              No income recorded.
            </Body>
          )}
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 10 }}>Expense breakdown</Kicker>
          {data.expenseCats.length ? (
            data.expenseCats.map((c) => (
              <BarSegment
                key={c.value}
                label={c.label}
                value={c.total}
                max={data.maxExpenseCat}
                color={brand.danger}
              />
            ))
          ) : (
            <Body size="sm" color={brand.muted}>
              No expenses recorded.
            </Body>
          )}
        </Card>
      </div>

      <Card padding={14} style={{ marginBottom: 18 }}>
        <Kicker style={{ marginBottom: 10 }}>VAT summary</Kicker>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10,
          }}
        >
          <StatBox label="VAT on income" value={fmtMoney(data.vatIncome)} tone="neutral" />
          <StatBox
            label="VAT on expenses"
            value={fmtMoney(data.vatExpenses)}
            tone="neutral"
          />
          <StatBox
            label="Net VAT position"
            value={fmtMoney(data.vatNet)}
            tone={data.vatNet >= 0 ? "ok" : "danger"}
          />
        </div>
      </Card>

      <Card padding={14}>
        <Kicker style={{ marginBottom: 10 }}>Monthly trend (12 months)</Kicker>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 4,
            height: 160,
          }}
        >
          {data.months.map((m) => (
            <div
              key={m.key}
              style={{
                flex: "1 1 0",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                height: "100%",
                justifyContent: "flex-end",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 2,
                  alignItems: "flex-end",
                  height: "100%",
                }}
              >
                <div
                  style={{
                    width: 12,
                    background: brand.ok,
                    borderRadius: "2px 2px 0 0",
                    height: `${Math.max(
                      2,
                      (m.income / data.maxMonth) * 120
                    )}px`,
                    transition: "height 200ms ease",
                  }}
                  title={`Income: ${fmtMoney(m.income)}`}
                />
                <div
                  style={{
                    width: 12,
                    background: brand.danger,
                    borderRadius: "2px 2px 0 0",
                    height: `${Math.max(
                      2,
                      (m.expense / data.maxMonth) * 120
                    )}px`,
                    transition: "height 200ms ease",
                  }}
                  title={`Expense: ${fmtMoney(m.expense)}`}
                />
              </div>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 8,
                  color: brand.muted,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {m.label}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            justifyContent: "center",
            marginTop: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                background: brand.ok,
                borderRadius: 2,
              }}
            />
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 9,
                letterSpacing: "0.10em",
                textTransform: "uppercase",
                color: brand.muted,
              }}
            >
              Income
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                background: brand.danger,
                borderRadius: 2,
              }}
            />
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 9,
                letterSpacing: "0.10em",
                textTransform: "uppercase",
                color: brand.muted,
              }}
            >
              Expense
            </span>
          </div>
        </div>
      </Card>
    </>
  );
}

function ByFieldTab({ data }) {
  if (!data.length) {
    return (
      <EmptyState
        kicker="No field data"
        title="No transactions linked to fields"
        description="Link transactions to fields to see per-field income, expenses and margin."
      />
    );
  }

  const maxAbs = Math.max(
    1,
    ...data.map((d) => Math.max(d.income, d.expenses))
  );

  return (
    <>
      <Kicker style={{ marginBottom: 10 }}>
        Per-field financial summary
      </Kicker>
      <Card padding={0} style={{ overflow: "hidden" }}>
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
              {["Field", "Income", "Expenses", "Net margin", "Bar"].map(
                (h) => (
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
                )
              )}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.fieldId}>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${brand.border}`,
                    fontWeight: 600,
                    color: brand.forest,
                  }}
                >
                  {d.name}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${brand.border}`,
                    fontFamily: fonts.mono,
                    color: brand.ok,
                  }}
                >
                  {fmtMoney(d.income)}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${brand.border}`,
                    fontFamily: fonts.mono,
                    color: brand.danger,
                  }}
                >
                  {fmtMoney(d.expenses)}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${brand.border}`,
                    fontFamily: fonts.mono,
                    fontWeight: 600,
                    color: d.margin >= 0 ? brand.ok : brand.danger,
                  }}
                >
                  {fmtMoney(d.margin)}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${brand.border}`,
                    minWidth: 140,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 3,
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        height: 12,
                        width: `${(d.income / maxAbs) * 100}%`,
                        background: brand.ok,
                        borderRadius: "2px 0 0 2px",
                      }}
                    />
                    <div
                      style={{
                        height: 12,
                        width: `${(d.expenses / maxAbs) * 100}%`,
                        background: brand.danger,
                        borderRadius: "0 2px 2px 0",
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

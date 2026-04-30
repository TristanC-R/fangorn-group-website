import { useCallback, useMemo, useState } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  EmptyState,
  Kicker,
  Pill,
  SectionHeader,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { useLocalValue } from "../state/localStore.js";
import { tilthStore } from "../state/localStore.js";
import { downloadTextFile, toCsv } from "../../lib/fileExport.js";

const TABS = ["Red Tractor", "NVZ", "Cross-compliance", "Pre-harvest H&S", "Export"];
const STATUS_LABELS = { unchecked: "Unchecked", pass: "Pass", fail: "Fail", na: "N/A" };
const STATUS_CYCLE = { unchecked: "pass", pass: "fail", fail: "na", na: "unchecked" };

const uid = () =>
  crypto.randomUUID?.() ||
  Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(d); }
};

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            padding: "7px 14px",
            borderRadius: radius.base,
            border: `1px solid ${active === t ? brand.forest : brand.border}`,
            background: active === t ? brand.forest : brand.white,
            color: active === t ? brand.white : brand.forest,
            cursor: "pointer",
            transition: "all 140ms ease",
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function buildRedTractorChecklist(farmId, fields) {
  const records = tilthStore.loadRecords(farmId);
  const inventory = (() => {
    try {
      const raw = window.localStorage.getItem(`tilth:inventory:${farmId}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  })();

  const hasRecords = records.length > 0;
  const hasChemicals = Array.isArray(inventory) && inventory.some(
    (item) => item.category === "chemical" || item.category === "herbicide" || item.category === "fungicide" || item.category === "insecticide" || item.type === "chemical"
  );
  const hasFields = Array.isArray(fields) && fields.length > 0;

  return [
    {
      category: "Crop protection records",
      items: [
        { id: "rt-spray-records", label: "Spray records exist for all fields", autoCheck: true, autoResult: hasRecords, autoDetail: hasRecords ? `${records.length} record(s) found` : "No spray records found" },
        { id: "rt-operator-certs", label: "All operators hold valid PA1/PA2 certificates", autoCheck: false },
        { id: "rt-nsts", label: "Sprayer has current NSTS test certificate", autoCheck: false },
        { id: "rt-chem-inventory", label: "Chemical store inventory is up to date", autoCheck: true, autoResult: hasChemicals, autoDetail: hasChemicals ? "Chemical inventory found" : "No chemicals in inventory" },
      ],
    },
    {
      category: "Field records",
      items: [
        { id: "rt-field-boundaries", label: "Field boundaries are mapped", autoCheck: true, autoResult: hasFields, autoDetail: hasFields ? `${fields.length} field(s) mapped` : "No fields mapped" },
        { id: "rt-rotation-records", label: "Crop rotation records maintained", autoCheck: false },
        { id: "rt-soil-analysis", label: "Soil analysis within last 5 years", autoCheck: false },
      ],
    },
    {
      category: "Environmental",
      items: [
        { id: "rt-nvz-rules", label: "NVZ rules compliance", autoCheck: false },
        { id: "rt-buffer-strips", label: "Buffer strips maintained", autoCheck: false },
        { id: "rt-prohibited-pest", label: "No prohibited pesticides used", autoCheck: false },
      ],
    },
    {
      category: "Storage & handling",
      items: [
        { id: "rt-chem-store", label: "Chemical store locked and signed", autoCheck: false },
        { id: "rt-coshh", label: "COSHH assessments available", autoCheck: false },
        { id: "rt-emergency", label: "Emergency procedures posted", autoCheck: false },
      ],
    },
  ];
}

const GAEC_ITEMS = [
  { id: "gaec-1", label: "GAEC 1 — Buffer strips along watercourses" },
  { id: "gaec-2", label: "GAEC 2 — Water abstraction compliance" },
  { id: "gaec-3", label: "GAEC 3 — Groundwater protection" },
  { id: "gaec-4", label: "GAEC 4 — Minimum soil cover" },
  { id: "gaec-5", label: "GAEC 5 — Minimum land management to limit erosion" },
  { id: "gaec-6", label: "GAEC 6 — Soil organic matter maintenance" },
  { id: "gaec-7", label: "GAEC 7 — Landscape features retention" },
  { id: "gaec-8", label: "GAEC 8 — Minimum share of arable as non-productive area" },
  { id: "gaec-9", label: "GAEC 9 — Environmentally sensitive permanent grassland" },
];

function ChecklistItem({ item, status, notes, autoResult, autoDetail, onToggle, onNotesChange }) {
  const effectiveStatus = item.autoCheck && autoResult !== undefined
    ? (status !== "unchecked" ? status : (autoResult ? "pass" : "fail"))
    : status;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 8,
        padding: "10px 12px",
        border: `1px solid ${brand.border}`,
        borderRadius: radius.base,
        background: effectiveStatus === "pass" ? brand.okSoft
          : effectiveStatus === "fail" ? brand.dangerSoft
          : brand.white,
        transition: "background 140ms ease",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 500, color: brand.forest }}>
            {item.label}
          </span>
          {item.autoCheck && (
            <Pill tone={autoResult ? "ok" : "warn"} style={{ fontSize: 8 }}>
              Auto · {autoDetail || (autoResult ? "Pass" : "Fail")}
            </Pill>
          )}
        </div>
        <div style={{ marginTop: 6 }}>
          <input
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Notes…"
            style={{
              ...inputStyle,
              padding: "5px 8px",
              fontSize: 11.5,
              background: "rgba(255,255,255,0.7)",
            }}
          />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            padding: "6px 12px",
            borderRadius: radius.base,
            border: `1px solid ${
              effectiveStatus === "pass" ? brand.ok
              : effectiveStatus === "fail" ? brand.danger
              : effectiveStatus === "na" ? brand.info
              : brand.border
            }`,
            background: effectiveStatus === "pass" ? brand.ok
              : effectiveStatus === "fail" ? brand.danger
              : effectiveStatus === "na" ? brand.info
              : brand.white,
            color: effectiveStatus === "unchecked" ? brand.forest : brand.white,
            cursor: "pointer",
            transition: "all 140ms ease",
            minWidth: 72,
            textAlign: "center",
          }}
        >
          {STATUS_LABELS[effectiveStatus]}
        </button>
      </div>
    </div>
  );
}

function scoreSummary(allItems, checklists) {
  let passed = 0;
  let failed = 0;
  let unchecked = 0;
  let na = 0;
  for (const item of allItems) {
    const st = checklists[item.id]?.status || "unchecked";
    const effective = item.autoCheck && item.autoResult !== undefined && st === "unchecked"
      ? (item.autoResult ? "pass" : "fail")
      : st;
    if (effective === "pass") passed++;
    else if (effective === "fail") failed++;
    else if (effective === "na") na++;
    else unchecked++;
  }
  return { passed, failed, unchecked, na, total: allItems.length };
}

function RedTractorTab({ farmId, fields, checklists, setChecklists }) {
  const categories = useMemo(() => buildRedTractorChecklist(farmId, fields), [farmId, fields]);
  const allItems = categories.flatMap((c) => c.items);
  const summary = scoreSummary(allItems, checklists);

  const toggleItem = (id) => {
    setChecklists((prev) => {
      const current = prev[id]?.status || "unchecked";
      const next = STATUS_CYCLE[current];
      return { ...prev, [id]: { ...(prev[id] || {}), status: next } };
    });
  };

  const setNotes = (id, notes) => {
    setChecklists((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), notes } }));
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        <ScoreCard label="Passed" value={summary.passed} total={summary.total} tone="ok" />
        <ScoreCard label="Failed" value={summary.failed} total={summary.total} tone="danger" />
        <ScoreCard label="Unchecked" value={summary.unchecked} total={summary.total} tone="neutral" />
        <ScoreCard label="N/A" value={summary.na} total={summary.total} tone="info" />
      </div>

      {categories.map((cat) => (
        <div key={cat.category} style={{ marginBottom: 16 }}>
          <Kicker style={{ marginBottom: 8 }}>{cat.category}</Kicker>
          <div style={{ display: "grid", gap: 6 }}>
            {cat.items.map((item) => (
              <ChecklistItem
                key={item.id}
                item={item}
                status={checklists[item.id]?.status || "unchecked"}
                notes={checklists[item.id]?.notes || ""}
                autoResult={item.autoCheck ? item.autoResult : undefined}
                autoDetail={item.autoCheck ? item.autoDetail : undefined}
                onToggle={() => toggleItem(item.id)}
                onNotesChange={(v) => setNotes(item.id, v)}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function NvzTab({ farmId, fields }) {
  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const attrs = useMemo(() => tilthStore.loadFieldAttrs(farmId), [farmId]);

  const fieldData = useMemo(() => {
    const year = new Date().getFullYear();
    const nByField = {};

    for (const r of records) {
      if (!r.date) continue;
      const rYear = new Date(r.date).getFullYear();
      if (rYear !== year) continue;

      const nApplied = (r.nKgHa || 0) || ((r.rate || 0) * (r.nFraction || 0));
      if (nApplied > 0) {
        nByField[r.fieldId] = (nByField[r.fieldId] || 0) + nApplied;
      }
    }

    return (fields || []).map((f) => {
      const landUse = attrs[f.id]?.landUse || "arable";
      const isGrassland = landUse === "grass" || landUse === "grassland" || landUse === "permanent-grass";
      const limit = isGrassland ? 170 : 250;
      const applied = nByField[f.id] || 0;
      const pct = limit > 0 ? (applied / limit) * 100 : 0;
      const tone = pct > 100 ? "danger" : pct >= 80 ? "warn" : "ok";
      return { id: f.id, name: f.name, landUse, isGrassland, limit, applied, pct, tone };
    });
  }, [fields, records, attrs]);

  const totalN = fieldData.reduce((a, f) => a + f.applied, 0);
  const totalLimit = fieldData.reduce((a, f) => a + f.limit, 0);
  const overCount = fieldData.filter((f) => f.pct > 100).length;
  const amberCount = fieldData.filter((f) => f.pct >= 80 && f.pct <= 100).length;

  const thStyle = {
    textAlign: "left", padding: "6px 8px",
    fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em",
    textTransform: "uppercase", color: brand.muted,
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        <Card padding={14} style={{ background: brand.forest, borderColor: brand.forest }}>
          <Kicker color="rgba(255,255,255,0.6)" style={{ marginBottom: 6 }}>Farm N total</Kicker>
          <div style={{ fontFamily: fonts.serif, fontSize: 24, color: brand.white }}>{totalN.toFixed(0)} kg N</div>
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 4 }}>
            of {totalLimit.toFixed(0)} kg capacity
          </div>
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Fields green</Kicker>
          <div style={{ fontFamily: fonts.serif, fontSize: 24, color: brand.ok }}>
            {fieldData.filter((f) => f.pct < 80).length}
          </div>
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft, marginTop: 4 }}>
            Under 80% of N limit
          </div>
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Fields amber</Kicker>
          <div style={{ fontFamily: fonts.serif, fontSize: 24, color: brand.warn }}>{amberCount}</div>
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft, marginTop: 4 }}>
            80–100% of N limit
          </div>
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Fields over limit</Kicker>
          <div style={{ fontFamily: fonts.serif, fontSize: 24, color: brand.danger }}>{overCount}</div>
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft, marginTop: 4 }}>
            Exceeds NVZ cap
          </div>
        </Card>
      </div>

      {(!fields || fields.length === 0) ? (
        <EmptyState
          kicker="NVZ"
          title="No fields"
          description="Map your fields and log fertiliser applications to see N budgets."
        />
      ) : (
        <Card padding={0} style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${brand.border}` }}>
                  {["Field", "Land use", "N applied (kg/ha)", "NVZ limit (kg/ha)", "% of limit", "Status"].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fieldData.map((f) => (
                  <tr
                    key={f.id}
                    style={{
                      borderBottom: `1px solid ${brand.border}`,
                      background: f.tone === "danger" ? brand.dangerSoft
                        : f.tone === "warn" ? brand.warnSoft
                        : "transparent",
                    }}
                  >
                    <td style={{ padding: "6px 8px", fontWeight: 500, color: brand.forest }}>{f.name}</td>
                    <td style={{ padding: "6px 8px", textTransform: "capitalize", color: brand.bodySoft }}>{f.landUse}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{f.applied.toFixed(1)}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{f.limit}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, color: f.tone === "ok" ? brand.ok : f.tone === "warn" ? brand.warn : brand.danger }}>
                      {f.pct.toFixed(0)}%
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <TrafficLight tone={f.tone} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div style={{ marginTop: 12 }}>
        <Body size="sm" style={{ color: brand.muted }}>
          NVZ limits: 170 kg N/ha for grassland, 250 kg N/ha for arable.
          Green = under 80%, amber = 80–100%, red = over limit.
          N figures are derived from logged fertiliser records.
        </Body>
      </div>
    </>
  );
}

function TrafficLight({ tone }) {
  const colors = { ok: brand.ok, warn: brand.warn, danger: brand.danger };
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: colors[tone] || brand.muted,
        border: `1px solid ${colors[tone] || brand.border}`,
        verticalAlign: "middle",
      }}
    />
  );
}

function CrossComplianceTab({ checklists, setChecklists }) {
  const summary = scoreSummary(GAEC_ITEMS, checklists);

  const toggleItem = (id) => {
    setChecklists((prev) => {
      const current = prev[id]?.status || "unchecked";
      return { ...prev, [id]: { ...(prev[id] || {}), status: STATUS_CYCLE[current] } };
    });
  };

  const setNotes = (id, notes) => {
    setChecklists((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), notes } }));
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        <ScoreCard label="Passed" value={summary.passed} total={summary.total} tone="ok" />
        <ScoreCard label="Failed" value={summary.failed} total={summary.total} tone="danger" />
        <ScoreCard label="Unchecked" value={summary.unchecked} total={summary.total} tone="neutral" />
        <ScoreCard label="N/A" value={summary.na} total={summary.total} tone="info" />
      </div>

      <Kicker style={{ marginBottom: 8 }}>Good Agricultural and Environmental Conditions (GAECs)</Kicker>
      <div style={{ display: "grid", gap: 6 }}>
        {GAEC_ITEMS.map((item) => (
          <ChecklistItem
            key={item.id}
            item={item}
            status={checklists[item.id]?.status || "unchecked"}
            notes={checklists[item.id]?.notes || ""}
            onToggle={() => toggleItem(item.id)}
            onNotesChange={(v) => setNotes(item.id, v)}
          />
        ))}
      </div>
    </>
  );
}

function PreHarvestSafetyTab({ farmId }) {
  const [forms, setForms] = useLocalValue("preharvest_safety", farmId, []);
  const [crop, setCrop] = useState("");
  const [fieldBlock, setFieldBlock] = useState("");
  const [supervisor, setSupervisor] = useState("");
  const [briefing, setBriefing] = useState("PPE, moving machinery, traffic routes, first aid point, welfare facilities, lone-working and emergency contact process covered.");
  const [workerName, setWorkerName] = useState("");
  const [workerRole, setWorkerRole] = useState("");

  const activeForm = forms[0] || null;

  const startForm = () => {
    if (!crop.trim() && !fieldBlock.trim()) return;
    const entry = {
      id: uid(),
      crop: crop.trim(),
      fieldBlock: fieldBlock.trim(),
      supervisor: supervisor.trim(),
      briefing: briefing.trim(),
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      signatures: [],
    };
    setForms((prev) => [entry, ...(Array.isArray(prev) ? prev : [])]);
    setCrop("");
    setFieldBlock("");
    setSupervisor("");
  };

  const addSignature = () => {
    if (!activeForm || !workerName.trim()) return;
    const signature = {
      id: uid(),
      name: workerName.trim(),
      role: workerRole.trim(),
      signedAt: new Date().toISOString(),
    };
    setForms((prev) => prev.map((form) => form.id === activeForm.id ? { ...form, signatures: [...(form.signatures || []), signature] } : form));
    setWorkerName("");
    setWorkerRole("");
  };

  const downloadSignOff = () => {
    if (!activeForm) return;
    const rows = (activeForm.signatures || []).map((sig) => ({
      date: activeForm.date,
      crop: activeForm.crop,
      fields: activeForm.fieldBlock,
      supervisor: activeForm.supervisor,
      worker: sig.name,
      role: sig.role,
      signedAt: sig.signedAt,
      briefing: activeForm.briefing,
    }));
    const csv = toCsv(rows, [
      { label: "Date", value: (r) => r.date },
      { label: "Crop", value: (r) => r.crop },
      { label: "Field/block", value: (r) => r.fields },
      { label: "Supervisor", value: (r) => r.supervisor },
      { label: "Worker", value: (r) => r.worker },
      { label: "Role", value: (r) => r.role },
      { label: "Signed at", value: (r) => r.signedAt },
      { label: "Briefing", value: (r) => r.briefing },
    ]);
    downloadTextFile(`preharvest-safety-signoff-${activeForm.date}.csv`, "text/csv", csv);
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card className="tilth-mobile-card" padding={14} tone="section">
        <Kicker style={{ marginBottom: 8 }}>New pre-harvest briefing</Kicker>
        <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
          <input value={crop} onChange={(e) => setCrop(e.target.value)} placeholder="Crop / harvest" style={inputStyle} />
          <input value={fieldBlock} onChange={(e) => setFieldBlock(e.target.value)} placeholder="Field or block" style={inputStyle} />
          <input value={supervisor} onChange={(e) => setSupervisor(e.target.value)} placeholder="Supervisor" style={inputStyle} />
        </div>
        <textarea value={briefing} onChange={(e) => setBriefing(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", marginBottom: 8 }} />
        <Button size="sm" onClick={startForm} disabled={!crop.trim() && !fieldBlock.trim()} style={{ width: "100%" }}>Create sign-off form</Button>
      </Card>

      {activeForm ? (
        <Card className="tilth-mobile-card" padding={14}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div>
              <Kicker style={{ marginBottom: 4 }}>Active sign-off</Kicker>
              <div style={{ fontFamily: fonts.serif, fontSize: 20, color: brand.forest }}>
                {activeForm.crop || "Harvest"} · {activeForm.fieldBlock || "All fields"}
              </div>
              <Body size="sm" style={{ color: brand.muted }}>Supervisor: {activeForm.supervisor || "not set"} · {fmtDate(activeForm.date)}</Body>
            </div>
            <Button variant="secondary" size="sm" onClick={downloadSignOff} disabled={!activeForm.signatures?.length}>Export sign-offs</Button>
          </div>
          <Body size="sm" style={{ marginBottom: 10 }}>{activeForm.briefing}</Body>
          <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 10 }}>
            <input value={workerName} onChange={(e) => setWorkerName(e.target.value)} placeholder="Worker name" style={inputStyle} />
            <input value={workerRole} onChange={(e) => setWorkerRole(e.target.value)} placeholder="Role e.g. grain cart, sprayer" style={inputStyle} />
            <Button size="sm" onClick={addSignature} disabled={!workerName.trim()}>Sign</Button>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {(activeForm.signatures || []).length ? activeForm.signatures.map((sig) => (
              <div key={sig.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 10px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.bgSection }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: brand.forest }}>{sig.name}{sig.role ? ` · ${sig.role}` : ""}</span>
                <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>{new Date(sig.signedAt).toLocaleString("en-GB")}</span>
              </div>
            )) : <Body size="sm" style={{ color: brand.muted }}>No one has signed this briefing yet.</Body>}
          </div>
        </Card>
      ) : (
        <EmptyState kicker="Pre-harvest H&S" title="No sign-off form yet" description="Create a briefing form before harvest so workers can sign before starting." />
      )}
    </div>
  );
}

function ExportTab({ farmId, fields, checklists }) {
  const rtCategories = useMemo(() => buildRedTractorChecklist(farmId, fields), [farmId, fields]);
  const records = useMemo(() => tilthStore.loadRecords(farmId), [farmId]);
  const documents = useMemo(() => {
    try { return JSON.parse(window.localStorage.getItem(`tilth:documents:${farmId}`) || "[]"); } catch { return []; }
  }, [farmId]);
  const inventory = useMemo(() => {
    try { return JSON.parse(window.localStorage.getItem(`tilth:inventory:${farmId}`) || "[]"); } catch { return []; }
  }, [farmId]);
  const tasks = useMemo(() => {
    try { return JSON.parse(window.localStorage.getItem(`tilth:tasks:${farmId}`) || "[]"); } catch { return []; }
  }, [farmId]);
  const preHarvestForms = useMemo(() => {
    try { return JSON.parse(window.localStorage.getItem(`tilth:preharvest_safety:${farmId}`) || "[]"); } catch { return []; }
  }, [farmId]);
  const rtItems = rtCategories.flatMap((c) => c.items);
  const rtScore = scoreSummary(rtItems, checklists);
  const gaecScore = scoreSummary(GAEC_ITEMS, checklists);

  const allItems = [...rtItems, ...GAEC_ITEMS];
  const allScore = scoreSummary(allItems, checklists);

  const lastReview = checklists._lastReview || null;

  const updateReviewDate = useCallback(() => {
    const now = new Date().toISOString();
    window.localStorage.setItem(`tilth:audit_checklists:${farmId}`, JSON.stringify({ ...checklists, _lastReview: now }));
  }, [farmId, checklists]);

  const evidenceRows = useMemo(() => [
    ...records.map((r) => ({
      type: "Input record",
      title: `${r.productId || "input"} on ${r.fieldName || r.fieldId || "field"}`,
      date: r.date || "",
      reference: r.id,
      notes: r.notes || "",
    })),
    ...documents.map((d) => ({
      type: "Document",
      title: d.title || d.filename || "Document",
      date: d.uploadDate || d.createdAt || "",
      reference: d.filename || d.storagePath || d.id,
      notes: d.expiry ? `Expires ${d.expiry}` : d.notes || "",
    })),
    ...inventory.map((i) => ({
      type: "Inventory",
      title: i.name || i.product || "Stock item",
      date: i.expiryDate || i.updatedAt || i.createdAt || "",
      reference: i.batchNumber || i.sku || i.id,
      notes: `${i.quantity ?? ""} ${i.unit || ""}`.trim(),
    })),
    ...tasks.filter((t) => t.status !== "cancelled").map((t) => ({
      type: "Task",
      title: t.title || "Task",
      date: t.dueDate || t.createdAt || "",
      reference: t.category || t.id,
      notes: t.status || "",
    })),
    ...preHarvestForms.map((form) => ({
      type: "Pre-harvest H&S",
      title: `${form.crop || "Harvest"} · ${form.fieldBlock || "All fields"}`,
      date: form.date || form.createdAt || "",
      reference: form.id,
      notes: `${form.signatures?.length || 0} signature(s)`,
    })),
  ], [records, documents, inventory, tasks, preHarvestForms]);

  const downloadEvidenceManifest = () => {
    const csv = toCsv(evidenceRows, [
      { label: "Evidence Type", value: (r) => r.type },
      { label: "Title", value: (r) => r.title },
      { label: "Date", value: (r) => r.date },
      { label: "Reference", value: (r) => r.reference },
      { label: "Notes", value: (r) => r.notes },
    ]);
    downloadTextFile(`audit-evidence-manifest-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", csv);
  };

  const downloadReport = () => {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

    const renderItems = (items, title) => {
      let html = `<h2 style="color:#104E3F;margin-top:24px">${title}</h2><table style="width:100%;border-collapse:collapse;font-size:13px">`;
      html += `<tr style="border-bottom:2px solid #D5E5D7"><th style="text-align:left;padding:6px 8px;color:#839788">Check</th><th style="text-align:left;padding:6px 8px;color:#839788">Status</th><th style="text-align:left;padding:6px 8px;color:#839788">Notes</th></tr>`;
      for (const item of items) {
        const st = checklists[item.id]?.status || "unchecked";
        const effective = item.autoCheck && item.autoResult !== undefined && st === "unchecked"
          ? (item.autoResult ? "pass" : "fail") : st;
        const notes = checklists[item.id]?.notes || "";
        const bg = effective === "pass" ? "#DCEBDE" : effective === "fail" ? "#F5E1DC" : "#FFFFFF";
        html += `<tr style="border-bottom:1px solid #D5E5D7;background:${bg}">`;
        html += `<td style="padding:6px 8px">${item.label}</td>`;
        html += `<td style="padding:6px 8px;font-weight:600;text-transform:uppercase">${STATUS_LABELS[effective]}</td>`;
        html += `<td style="padding:6px 8px;color:#54695F">${notes}</td></tr>`;
      }
      html += `</table>`;
      return html;
    };

    let body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Audit Report</title>`;
    body += `<style>body{font-family:'DM Sans',system-ui,sans-serif;max-width:900px;margin:0 auto;padding:40px 24px;color:#3A4F47}h1{color:#104E3F;font-family:'Instrument Serif',Georgia,serif}h2{font-family:'DM Sans',system-ui,sans-serif;font-size:16px}</style></head><body>`;
    body += `<h1>Farm Audit Report</h1>`;
    body += `<p style="color:#839788">Generated ${dateStr}</p>`;
    body += `<div style="background:#EFF4F0;border:1px solid #D5E5D7;border-radius:2px;padding:16px;margin:16px 0">`;
    body += `<strong style="color:#104E3F">Overall readiness:</strong> ${allScore.passed} of ${allScore.total} checks passed, ${allScore.unchecked} unchecked`;
    body += `</div>`;
    body += `<div style="background:#fff;border:1px solid #D5E5D7;border-radius:2px;padding:16px;margin:16px 0">`;
    body += `<strong style="color:#104E3F">Evidence indexed:</strong> ${evidenceRows.length} item(s) from input records, documents, inventory and tasks.`;
    body += `</div>`;

    body += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">`;
    body += `<div style="background:#DCEBDE;border:1px solid #3F7A4A;border-radius:2px;padding:12px"><strong>Red Tractor:</strong> ${rtScore.passed}/${rtScore.total} passed</div>`;
    body += `<div style="background:#DCE7EE;border:1px solid #2F6077;border-radius:2px;padding:12px"><strong>Cross-compliance:</strong> ${gaecScore.passed}/${gaecScore.total} passed</div>`;
    body += `</div>`;

    for (const cat of rtCategories) {
      body += renderItems(cat.items, `Red Tractor — ${cat.category}`);
    }
    body += renderItems(GAEC_ITEMS, "Cross-compliance — GAECs");

    body += `<p style="margin-top:32px;color:#839788;font-size:12px">Report generated by Tilth Farm Management Platform</p>`;
    body += `</body></html>`;

    const blob = new Blob([body], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-report-${now.toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    updateReviewDate();
  };

  return (
    <>
      <Card padding={18} style={{ marginBottom: 14, background: brand.bgSection }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <Kicker style={{ marginBottom: 6 }}>Overall readiness</Kicker>
            <div style={{ fontFamily: fonts.serif, fontSize: 28, color: brand.forest, letterSpacing: "-0.02em" }}>
              {allScore.passed} of {allScore.total} passed
            </div>
            {allScore.unchecked > 0 && (
              <Body size="sm" style={{ marginTop: 4, color: brand.warn }}>
                {allScore.unchecked} check{allScore.unchecked === 1 ? "" : "s"} still unchecked
              </Body>
            )}
          </div>
          <Button variant="primary" size="md" onClick={downloadReport}>
            Download HTML report
          </Button>
          <Button variant="secondary" size="md" onClick={downloadEvidenceManifest} disabled={!evidenceRows.length}>
            Evidence CSV
          </Button>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Red Tractor</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <ScoreCard label="Passed" value={rtScore.passed} total={rtScore.total} tone="ok" />
            <ScoreCard label="Failed" value={rtScore.failed} total={rtScore.total} tone="danger" />
          </div>
          <ProgressBar passed={rtScore.passed} failed={rtScore.failed} total={rtScore.total} />
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Cross-compliance</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <ScoreCard label="Passed" value={gaecScore.passed} total={gaecScore.total} tone="ok" />
            <ScoreCard label="Failed" value={gaecScore.failed} total={gaecScore.total} tone="danger" />
          </div>
          <ProgressBar passed={gaecScore.passed} failed={gaecScore.failed} total={gaecScore.total} />
        </Card>
      </div>

      <Card padding={14}>
        <Kicker style={{ marginBottom: 6 }}>Review</Kicker>
        <div style={{ fontFamily: fonts.sans, fontSize: 13, color: brand.forest }}>
          Last reviewed: {lastReview ? fmtDate(lastReview) : "Never"}
        </div>
        <Body size="sm" style={{ color: brand.muted, marginTop: 6 }}>
          Evidence manifest currently indexes {evidenceRows.length} item{evidenceRows.length === 1 ? "" : "s"} from Tilth records.
        </Body>
      </Card>
    </>
  );
}

function ScoreCard({ label, value, total, tone }) {
  const toneMap = {
    ok: { bg: brand.okSoft, border: brand.ok, color: brand.ok },
    danger: { bg: brand.dangerSoft, border: brand.danger, color: brand.danger },
    warn: { bg: brand.warnSoft, border: brand.warn, color: brand.warn },
    info: { bg: brand.infoSoft, border: brand.info, color: brand.info },
    neutral: { bg: brand.bgSection, border: brand.border, color: brand.forest },
  };
  const t = toneMap[tone] || toneMap.neutral;

  return (
    <div
      style={{
        padding: "10px 12px",
        border: `1px solid ${t.border}`,
        background: t.bg,
        borderRadius: radius.base,
      }}
    >
      <div style={{ fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: t.color, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontFamily: fonts.serif, fontSize: 22, color: t.color }}>
        {value}
        <span style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.muted, marginLeft: 4 }}>/ {total}</span>
      </div>
    </div>
  );
}

function ProgressBar({ passed, failed, total }) {
  if (total === 0) return null;
  const pPct = (passed / total) * 100;
  const fPct = (failed / total) * 100;
  return (
    <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 10, background: brand.bgSection }}>
      <div style={{ width: `${pPct}%`, background: brand.ok, transition: "width 200ms ease" }} />
      <div style={{ width: `${fPct}%`, background: brand.danger, transition: "width 200ms ease" }} />
    </div>
  );
}

export function AuditWorkspace({ farm, fields }) {
  const farmId = farm?.id;
  const [tab, setTab] = useState("Red Tractor");
  const [checklists, setChecklists] = useLocalValue("audit_checklists", farmId, {});

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Inspections"
          title="Audit prep"
          description="Red Tractor, NVZ self-assessment, and cross-compliance checklists."
        />
      }
    >
      <div
        className="tilth-scroll"
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 4px 4px" }}
      >
        <TabBar tabs={TABS} active={tab} onChange={setTab} />
        {tab === "Red Tractor" && (
          <RedTractorTab farmId={farmId} fields={fields} checklists={checklists} setChecklists={setChecklists} />
        )}
        {tab === "NVZ" && <NvzTab farmId={farmId} fields={fields} />}
        {tab === "Cross-compliance" && (
          <CrossComplianceTab checklists={checklists} setChecklists={setChecklists} />
        )}
        {tab === "Pre-harvest H&S" && (
          <PreHarvestSafetyTab farmId={farmId} />
        )}
        {tab === "Export" && (
          <ExportTab farmId={farmId} fields={fields} checklists={checklists} />
        )}
      </div>
    </WorkspaceFrame>
  );
}

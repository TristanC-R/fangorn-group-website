import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";
import { getTilthApiBase } from "../../lib/tilthApi.js";
import { upsertFarmTask } from "../../lib/farmTaskAutomation.js";
import { tilthStore } from "../state/localStore.js";
import { brand, fonts, inputStyle, radius } from "./theme.js";
import { Button, Kicker, Pill } from "./primitives.jsx";

const SCOPES = [
  ["whole_farm", "Whole farm"],
  ["fields_satellite", "Fields + satellite"],
  ["documents", "Documents"],
  ["operations", "Operations"],
  ["finance", "Finance"],
  ["compliance", "Compliance"],
];

const REPORT_TYPES = [
  ["farm_operations", "Farm operations"],
  ["field_performance", "Field performance"],
  ["compliance_audit", "Compliance readiness"],
  ["finance_commitments", "Finance commitments"],
];

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function actionLabel(type) {
  return {
    calendar_reminder: "Calendar",
    finance_transaction: "Finance",
    inventory_item: "Inventory",
    inventory_adjustment: "Stock adjustment",
    spray_record: "Records",
    contact: "Contact",
    compliance_checklist: "Compliance",
    market_watchlist: "Market",
    livestock_medicine: "Livestock medicine",
    livestock_movement: "Livestock movement",
  }[type] || "Action";
}

function sourceLabel(source) {
  if (!source) return "Source";
  if (source.label) return source.label;
  if (source.type === "document") return "Document";
  if (source.type === "field") return "Field";
  if (source.type === "satellite_ndvi") return "Satellite";
  if (source.type === "wms_layer") return "WMS layer";
  return source.type || "Source";
}

export function GlobalAssistant({ farm }) {
  const farmId = farm?.id || null;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("chat");
  const [scope, setScope] = useState("whole_farm");
  const [reportType, setReportType] = useState("farm_operations");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [pendingActions, setPendingActions] = useState([]);
  const [applyingId, setApplyingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pendingCount = pendingActions.length;
  const placeholder = mode === "report"
    ? "What should the report focus on?"
    : "Ask about fields, satellite, records, finance, documents…";

  const apiFetch = async (path, body, method = "POST") => {
    const base = getTilthApiBase();
    if (!base) throw new Error("Set VITE_TILTH_API_URL and run npm run tilth-api.");
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("You need to be signed in.");
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? JSON.stringify({ farmId, ...body }) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Assistant request failed.");
    return payload;
  };

  useEffect(() => {
    if (!open || !farmId || !supabase) return undefined;
    let cancelled = false;
    async function loadActions() {
      const { data, error: actionError } = await supabase
        .from("assistant_suggested_actions")
        .select("*")
        .eq("farm_id", farmId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (actionError) {
        setError(actionError.message);
        return;
      }
      setPendingActions(data || []);
    }
    loadActions();
    const interval = window.setInterval(loadActions, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [farmId, open]);

  const send = async () => {
    const text = message.trim() || (mode === "report" ? REPORT_TYPES.find(([id]) => id === reportType)?.[1] : "");
    if (!text || !farmId || busy) return;
    setMessage("");
    setBusy(true);
    setError("");
    setMessages((prev) => [...prev, { id: uid(), role: "user", content: mode === "report" ? `Generate report: ${text}` : text, sources: [] }]);
    try {
      const payload = mode === "report"
        ? await apiFetch("/api/platform-assistant/reports/generate", {
            prompt: text,
            reportType,
            scope,
          })
        : await apiFetch("/api/platform-assistant/chat", {
            message: text,
            chatSessionId: sessionId,
            scope,
          });
      if (payload.chatSessionId) setSessionId(payload.chatSessionId);
      if (payload.suggestedActions?.length) {
        setPendingActions((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          return [...payload.suggestedActions.filter((item) => !seen.has(item.id)), ...prev];
        });
      }
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: payload.answer || payload.report?.content || "[Information not found in Tilth]",
          sources: payload.sources || payload.report?.sources || [],
          suggestedActions: payload.suggestedActions || [],
        },
      ]);
    } catch (err) {
      const msg = err?.message || "Assistant request failed.";
      setError(msg);
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: msg, sources: [], error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const openSource = async (source) => {
    if (!source || !supabase) return;
    if (source.type !== "document" && !source.document_id) return;
    const documentId = source.document_id || source.id;
    const { data, error: docError } = await supabase
      .from("farm_documents")
      .select("bucket,storage_path")
      .eq("id", documentId)
      .eq("farm_id", farmId)
      .maybeSingle();
    if (docError || !data?.storage_path) {
      setError(docError?.message || "Only document sources can be opened directly for now.");
      return;
    }
    const signed = await supabase.storage
      .from(data.bucket || "farm-documents")
      .createSignedUrl(data.storage_path, 60 * 10);
    if (signed.error) {
      setError(signed.error.message);
      return;
    }
    if (signed.data?.signedUrl) window.open(signed.data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const updateActionStatus = async (action, status) => {
    const { data: authData } = await supabase.auth.getUser();
    const patch = status === "applied"
      ? { status, applied_at: new Date().toISOString(), applied_by: authData?.user?.id || null }
      : { status, dismissed_at: new Date().toISOString(), dismissed_by: authData?.user?.id || null };
    const { error: updateError } = await supabase
      .from("assistant_suggested_actions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", action.id)
      .eq("farm_id", farmId);
    if (updateError) throw new Error(updateError.message);
    setPendingActions((prev) => prev.filter((item) => item.id !== action.id));
  };

  const upsertArrayNamespace = (namespace, entry, sourceKey) => {
    const rows = tilthStore.loadNamespace(namespace, farmId, []);
    const key = sourceKey || entry.sourceKey;
    const next = key && rows.some((row) => row.sourceKey === key)
      ? rows.map((row) => (row.sourceKey === key ? { ...row, ...entry, id: row.id, updatedAt: new Date().toISOString() } : row))
      : [entry, ...rows];
    tilthStore.saveNamespace(namespace, farmId, next);
  };

  const applyAction = async (action) => {
    if (!action || !farmId || !supabase) return;
    setApplyingId(action.id);
    setError("");
    try {
      const p = action.payload || {};
      const sourceKey = p.sourceKey || `assistant:${action.id}`;
      if (action.action_type === "calendar_reminder") {
        upsertFarmTask(farmId, {
          sourceKey,
          source: "platform-assistant",
          sourceId: action.id,
          title: p.title || action.title,
          dueDate: p.dueDate || p.date || today(),
          reminderDays: p.reminderDays ?? 3,
          category: p.category || "general",
          priority: p.priority || "medium",
          notes: p.notes || action.summary || "",
        });
      } else if (action.action_type === "finance_transaction") {
        upsertArrayNamespace("finances", {
          id: uid(),
          type: p.type || "expense",
          date: p.date || today(),
          amount: Number(p.amount) || 0,
          vatAmount: Number(p.vatAmount) || 0,
          category: p.category || "other",
          description: p.description || action.title,
          counterparty: p.counterparty || "",
          invoiceRef: p.invoiceRef || "",
          fieldId: p.fieldId || "",
          notes: p.notes || action.summary || "",
          sourceKey,
          createdAt: new Date().toISOString(),
        }, sourceKey);
      } else if (action.action_type === "inventory_item") {
        upsertArrayNamespace("inventory", {
          id: uid(),
          name: p.name || action.title,
          category: p.category || "other",
          unit: p.unit || "unit",
          quantity: Number(p.quantity) || 0,
          unitCost: Number(p.unitCost) || 0,
          batchNumber: p.batchNumber || "",
          supplier: p.supplier || "",
          purchaseDate: p.purchaseDate || "",
          expiryDate: p.expiryDate || "",
          storageLocation: p.storageLocation || "",
          mappNumber: p.mappNumber || "",
          lowStockThreshold: p.lowStockThreshold ?? null,
          notes: p.notes || action.summary || "",
          sourceKey,
          adjustments: [],
          createdAt: new Date().toISOString(),
        }, sourceKey);
      } else if (action.action_type === "inventory_adjustment") {
        const rows = tilthStore.loadNamespace("inventory", farmId, []);
        const next = rows.map((item) => {
          if (item.id !== p.itemId && item.name !== p.itemName) return item;
          const delta = Number(p.delta) || 0;
          const quantity = Math.max(0, (Number(item.quantity) || 0) + delta);
          return {
            ...item,
            quantity,
            adjustments: [...(item.adjustments || []), { date: new Date().toISOString(), delta, resultQty: quantity, sourceKey }],
          };
        });
        tilthStore.saveNamespace("inventory", farmId, next);
      } else if (action.action_type === "spray_record") {
        const productName = p.productName || action.title;
        const productId = p.productId || `assistant-${String(action.id).slice(0, 8)}`;
        const customProducts = tilthStore.loadCustomProducts(farmId);
        if (!customProducts.some((product) => product.id === productId || product.name?.toLowerCase() === productName.toLowerCase())) {
          tilthStore.saveCustomProducts(farmId, [
            ...customProducts,
            { id: productId, name: productName, category: p.category || "Other", unit: p.unit || "L/ha", defaultRate: Number(p.rate) || 0, ai: "", custom: true },
          ]);
        }
        upsertArrayNamespace("records", {
          id: uid(),
          createdAt: new Date().toISOString(),
          fieldId: p.fieldId || "",
          fieldName: p.fieldName || "",
          productId,
          rate: Number(p.rate) || 0,
          isBlend: false,
          blendProducts: [],
          date: p.date || today(),
          startTime: p.startTime || "",
          endTime: p.endTime || "",
          windDirection: p.windDirection || "",
          operator: p.operator || "",
          notes: p.notes || action.summary || "",
          area: Number(p.area) || 0,
          sourceKey,
        }, sourceKey);
      } else if (action.action_type === "contact") {
        upsertArrayNamespace("contacts", { id: uid(), name: p.name || action.title, company: p.company || "", role: p.role || "other", phone: p.phone || "", email: p.email || "", address: p.address || "", notes: p.notes || action.summary || "", sourceKey, createdAt: new Date().toISOString() }, sourceKey);
      } else if (action.action_type === "market_watchlist") {
        upsertArrayNamespace("market_watchlist", { id: uid(), marketId: p.marketId || p.commodity || action.title, target: p.target || "", direction: p.direction || "above", notes: p.notes || action.summary || "", sourceKey, createdAt: new Date().toISOString() }, sourceKey);
      } else if (action.action_type === "livestock_medicine") {
        upsertArrayNamespace("livestock_medicines", { id: uid(), ...p, notes: p.notes || action.summary || "", sourceKey, createdAt: new Date().toISOString() }, sourceKey);
      } else if (action.action_type === "livestock_movement") {
        upsertArrayNamespace("livestock_movements", { id: uid(), ...p, notes: p.notes || action.summary || "", sourceKey, createdAt: new Date().toISOString() }, sourceKey);
      } else if (action.action_type === "compliance_checklist") {
        const checklists = tilthStore.loadNamespace("audit_checklists", farmId, {});
        const key = p.checklist || "assistant";
        tilthStore.saveNamespace("audit_checklists", farmId, {
          ...checklists,
          [key]: [...(checklists[key] || []), { id: uid(), title: p.title || action.title, notes: p.notes || action.summary || "", sourceKey, createdAt: new Date().toISOString() }],
        });
      }
      await updateActionStatus(action, "applied");
    } catch (err) {
      setError(err?.message || "Could not apply suggested action.");
    } finally {
      setApplyingId(null);
    }
  };

  const dismissAction = async (action) => {
    setApplyingId(action.id);
    setError("");
    try {
      await updateActionStatus(action, "dismissed");
    } catch (err) {
      setError(err?.message || "Could not dismiss suggested action.");
    } finally {
      setApplyingId(null);
    }
  };

  const emptyText = useMemo(() => (
    mode === "report"
      ? "Generate whole-farm summaries from records, satellite data, finance, documents and compliance."
      : "Ask about fields, WMS layers, NDVI, SAR, weather, records, inventory, finance, livestock, documents or reports."
  ), [mode]);

  if (!farmId) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Open Tilth assistant"
        style={{
          position: "fixed",
          right: 18,
          bottom: 18,
          zIndex: 80,
          border: `1px solid ${brand.forest}`,
          background: brand.forest,
          color: brand.white,
          borderRadius: radius.pill,
          padding: "11px 14px",
          fontFamily: fonts.mono,
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          cursor: "pointer",
          boxShadow: "0 14px 35px rgba(22, 54, 42, 0.24)",
        }}
      >
        Assistant{pendingCount ? ` · ${pendingCount}` : ""}
      </button>
      {open ? (
        <div
          style={{
            position: "fixed",
            right: 18,
            bottom: 68,
            zIndex: 80,
            width: "min(520px, calc(100vw - 28px))",
            maxHeight: "min(720px, calc(100vh - 92px))",
            display: "flex",
            flexDirection: "column",
            border: `1px solid ${brand.border}`,
            borderRadius: radius.lg,
            background: brand.white,
            boxShadow: "0 18px 55px rgba(22, 54, 42, 0.22)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${brand.border}`, background: brand.bgSection }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div>
                <Kicker>Tilth assistant</Kicker>
                <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.bodySoft, marginTop: 2 }}>
                  Ask across the whole platform.
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} style={{ border: `1px solid ${brand.border}`, background: brand.white, borderRadius: radius.base, color: brand.forest, cursor: "pointer", width: 30, height: 30 }}>
                ×
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              <select value={mode} onChange={(event) => setMode(event.target.value)} style={{ ...inputStyle, width: "auto", minHeight: 34, padding: "6px 8px", fontSize: 12 }}>
                <option value="chat">Chat</option>
                <option value="report">Generate report</option>
              </select>
              <select value={scope} onChange={(event) => setScope(event.target.value)} style={{ ...inputStyle, width: "auto", minHeight: 34, padding: "6px 8px", fontSize: 12 }}>
                {SCOPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              {mode === "report" ? (
                <select value={reportType} onChange={(event) => setReportType(event.target.value)} style={{ ...inputStyle, width: "auto", minHeight: 34, padding: "6px 8px", fontSize: 12 }}>
                  {REPORT_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              ) : null}
            </div>
          </div>

          <div className="tilth-scroll" style={{ flex: "1 1 auto", minHeight: 260, overflowY: "auto", padding: 12, display: "grid", gap: 8 }}>
            {messages.length === 0 ? <div style={{ color: brand.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 1.45 }}>{emptyText}</div> : null}
            {messages.map((msg) => (
              <div key={msg.id} style={{ justifySelf: msg.role === "user" ? "end" : "start", maxWidth: "92%", border: `1px solid ${msg.error ? brand.danger : brand.border}`, borderRadius: radius.base, background: msg.role === "user" ? brand.forest : brand.bgSection, color: msg.role === "user" ? brand.white : msg.error ? brand.danger : brand.body, padding: "8px 10px", fontFamily: fonts.sans, fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                {msg.content}
                {msg.sources?.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
                    {msg.sources.slice(0, 8).map((source) => (
                      <button key={`${source.type || "source"}:${source.id || source.document_id || source.label}`} type="button" onClick={() => openSource(source)} style={{ border: `1px solid ${brand.border}`, background: brand.white, color: brand.forest, borderRadius: radius.base, padding: "3px 6px", fontFamily: fonts.mono, fontSize: 9, cursor: source.type === "document" || source.document_id ? "pointer" : "default" }}>
                        {sourceLabel(source)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {busy ? <div style={{ color: brand.muted, fontFamily: fonts.mono, fontSize: 11 }}>Thinking…</div> : null}
          </div>

          {pendingActions.length ? (
            <div style={{ borderTop: `1px solid ${brand.border}`, padding: 10, background: brand.bgSection }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <Kicker>Needs confirmation</Kicker>
                <Pill tone="warn">{pendingActions.length} pending</Pill>
              </div>
              <div className="tilth-scroll" style={{ display: "grid", gap: 6, maxHeight: 160, overflowY: "auto" }}>
                {pendingActions.slice(0, 5).map((action) => (
                  <div key={action.id} style={{ border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, padding: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 650, color: brand.forest }}>{action.title}</div>
                        <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted }}>{actionLabel(action.action_type)}</div>
                      </div>
                      <Pill tone="neutral">{Math.round(Number(action.confidence || 0) * 100)}%</Pill>
                    </div>
                    {action.summary ? <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.bodySoft, marginTop: 5 }}>{action.summary}</div> : null}
                    <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                      <Button size="sm" onClick={() => applyAction(action)} disabled={applyingId === action.id} style={{ flex: 1 }}>
                        {applyingId === action.id ? "Applying…" : "Apply"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => dismissAction(action)} disabled={applyingId === action.id}>
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {error ? <div style={{ padding: "0 12px 8px", color: brand.danger, fontFamily: fonts.sans, fontSize: 12 }}>{error}</div> : null}
          <div style={{ borderTop: `1px solid ${brand.border}`, padding: 10, display: "flex", gap: 8 }}>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") send(); }}
              placeholder={placeholder}
              style={{ ...inputStyle, fontSize: 13, padding: "9px 10px" }}
            />
            <Button size="sm" onClick={send} disabled={busy || (!message.trim() && mode !== "report")}>
              {mode === "report" ? "Report" : "Send"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

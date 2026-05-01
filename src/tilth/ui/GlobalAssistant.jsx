import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";
import { getTilthApiBase } from "../../lib/tilthApi.js";
import { upsertFarmTask } from "../../lib/farmTaskAutomation.js";
import { tilthStore } from "../state/localStore.js";
import { brand, fonts, inputStyle, radius } from "./theme.js";
import { Button, Kicker, Pill } from "./primitives.jsx";

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

function timeout(ms, message) {
  return new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), ms);
  });
}

function nonBlockingLoadError(err, fallback) {
  const raw = err?.message || String(err || "");
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Could not load previous assistant history. You can still send a new message.";
  }
  return raw || fallback;
}

function actionLabel(type) {
  return {
    calendar_reminder: "Calendar",
    finance_transaction: "Finance",
    inventory_item: "Inventory",
    inventory_adjustment: "Stock adjustment",
    field_observation: "Observations",
    spray_record: "Records",
    contact: "Contact",
    compliance_checklist: "Compliance",
    market_watchlist: "Market",
    livestock_medicine: "Livestock medicine",
    livestock_movement: "Livestock movement",
  }[type] || "Action";
}

function intendedActionType(action) {
  return action?.metadata?.intendedActionType || action?.payload?.recordAs || action?.action_type;
}

function sourceLabel(source) {
  if (!source) return "Source";
  if (source.label) return source.label;
  if (source.type === "document") return "Document";
  if (source.type === "field") return "Field";
  if (source.type === "satellite_ndvi") return "Satellite";
  if (source.type === "wms_layer") return "Map layer";
  return source.type || "Source";
}

function assistantErrorMessage(err, fallback = "The assistant could not finish that request.") {
  const raw = err?.message || String(err || "");
  if (/not configured|tilth api|supabase|npm run|failed to fetch|networkerror|load failed/i.test(raw)) {
    return "The assistant is not reachable right now. Check your connection and try again.";
  }
  if (/signed in/i.test(raw)) return "Please sign in again to use the assistant.";
  if (/unsupported assistant action type/i.test(raw)) {
    return "The assistant suggested something Tilth cannot apply yet. You can still use the details as a note.";
  }
  return raw || fallback;
}

export function GlobalAssistant({ farm }) {
  const farmId = farm?.id || null;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("chat");
  const [reportType, setReportType] = useState("farm_operations");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [pendingActions, setPendingActions] = useState([]);
  const [applyingId, setApplyingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pendingCount = pendingActions.length;
  const placeholder = mode === "report"
    ? "What should the report focus on?"
    : "Ask about fields, satellite, records, finance, documents…";

  const apiFetch = async (path, body, method = "POST") => {
    if (!supabase) throw new Error("Assistant is not configured.");
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("You need to be signed in.");
    const apiBase = import.meta.env.DEV ? "/tilth-api" : (getTilthApiBase() || "");
    if (!apiBase) throw new Error("Assistant service is not configured.");
    const url = `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: method === "POST" ? JSON.stringify({ farmId, ...body }) : undefined,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Assistant request failed (${response.status}).`);
        return payload;
      } catch (err) {
        lastError = err;
        if (err?.message && !/failed to fetch|networkerror|load failed/i.test(err.message)) throw err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error(lastError?.message || "Assistant service is not reachable.");
  };

  useEffect(() => {
    setMessages([]);
    setSessionId(null);
    setHistoryLoaded(false);
    setError("");
  }, [farmId]);

  useEffect(() => {
    if (!open || !farmId || !supabase || historyLoaded) return undefined;
    let cancelled = false;
    async function loadHistory() {
      try {
        const { data: sessions, error: sessionError } = await Promise.race([
          supabase
            .from("assistant_chat_sessions")
            .select("id")
            .eq("farm_id", farmId)
            .order("updated_at", { ascending: false })
            .limit(1),
          timeout(4000, "Assistant history request timed out."),
        ]);
        if (cancelled) return;
        if (sessionError) throw new Error(sessionError.message);
        const latestSessionId = sessions?.[0]?.id || null;
        setSessionId(latestSessionId);
        if (!latestSessionId) return;
        const { data: rows, error: messageError } = await Promise.race([
          supabase
            .from("assistant_chat_messages")
            .select("id,role,content,sources,suggested_actions,created_at")
            .eq("farm_id", farmId)
            .eq("chat_session_id", latestSessionId)
            .order("created_at", { ascending: true })
            .limit(80),
          timeout(4000, "Assistant message history request timed out."),
        ]);
        if (cancelled) return;
        if (messageError) throw new Error(messageError.message);
        setMessages((rows || []).map((row) => ({
          id: row.id,
          role: row.role,
          content: row.content,
          sources: row.sources || [],
          suggestedActions: row.suggested_actions || [],
        })));
      } catch (err) {
        if (!cancelled) console.warn(nonBlockingLoadError(err, "Could not load previous assistant history."));
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    }
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [farmId, historyLoaded, open]);

  useEffect(() => {
    if (!open || !farmId || !supabase) return undefined;
    let cancelled = false;
    async function loadActions() {
      try {
        const { data, error: actionError } = await Promise.race([
          supabase
            .from("assistant_suggested_actions")
            .select("*")
            .eq("farm_id", farmId)
            .eq("status", "pending")
            .order("created_at", { ascending: false }),
          timeout(5000, "Assistant actions request timed out."),
        ]);
        if (cancelled) return;
        if (actionError) throw new Error(actionError.message);
        setPendingActions(data || []);
      } catch (err) {
        if (!cancelled) console.warn(nonBlockingLoadError(err, "Could not load pending assistant actions."));
      }
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
            scope: "auto",
          })
        : await apiFetch("/api/platform-assistant/chat", {
            message: text,
            chatSessionId: sessionId,
            scope: "auto",
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
      const msg = assistantErrorMessage(err);
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
      setError("That source cannot be opened from here yet.");
      return;
    }
    const signed = await supabase.storage
      .from(data.bucket || "farm-documents")
      .createSignedUrl(data.storage_path, 60 * 10);
    if (signed.error) {
      setError("Could not open that document link. Please try again.");
      return;
    }
    if (signed.data?.signedUrl) window.open(signed.data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const updateActionStatus = async (action, status) => {
    await apiFetch("/api/platform-assistant/actions/status", {
      actionId: action.id,
      status,
    });
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

  const looksLikeObservationAction = (action, payload) => {
    if (intendedActionType(action) === "field_observation" || payload?.recordAs === "field_observation") return true;
    const text = `${action?.title || ""} ${action?.summary || ""} ${payload?.notes || ""}`.toLowerCase();
    const hasApplicationDetails = Boolean(payload?.productName || payload?.productId || Number(payload?.rate));
    return !hasApplicationDetails && /\b(observ|noticed|note|black\s*grass|weed|pest|disease|waterlogging|lodging|scout|corner|patch)\b/.test(text);
  };

  const upsertObservationAction = (action, payload = {}) => {
    const sourceKey = payload.sourceKey || `assistant:${action.id}`;
    const noteParts = [
      payload.notes || action.summary || action.title,
      payload.locationHint ? `Location: ${payload.locationHint}` : "",
      payload.recommendedAction ? `Recommended action: ${payload.recommendedAction}` : "",
    ].filter(Boolean);
    upsertArrayNamespace("observations", {
      id: uid(),
      fieldId: payload.fieldId || payload.fieldName || "",
      fieldName: payload.fieldName || "",
      type: payload.type || (/black\s*grass|weed/i.test(noteParts.join(" ")) ? "weed" : "general"),
      notes: noteParts.join("\n"),
      photos: [],
      datetime: payload.datetime || payload.date || new Date().toISOString(),
      location: null,
      sourceKey,
      createdAt: new Date().toISOString(),
    }, sourceKey);
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
        const amount = p.amount ?? p.amountDue ?? p.totalAmount ?? p.total ?? p.grossAmount;
        const vatAmount = p.vatAmount ?? p.vat ?? p.vatTotal ?? p.taxAmount;
        upsertArrayNamespace("finances", {
          id: uid(),
          type: p.type || "expense",
          date: p.date || p.invoiceDate || p.documentDate || p.transactionDate || p.dueDate || today(),
          amount: Number(amount) || 0,
          vatAmount: Number(vatAmount) || 0,
          category: p.category || "other",
          description: p.description || action.title,
          counterparty: p.counterparty || p.supplier || p.vendor || p.issuer || "",
          invoiceRef: p.invoiceRef || p.invoiceNumber || p.invoiceNo || p.reference || "",
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
      } else if (intendedActionType(action) === "field_observation") {
        upsertObservationAction(action, p);
      } else if (action.action_type === "spray_record") {
        if (looksLikeObservationAction(action, p)) {
          upsertObservationAction(action, {
            ...p,
            type: /black\s*grass|weed/i.test(`${action.title} ${action.summary} ${p.notes}`) ? "weed" : "general",
            recommendedAction: p.recommendedAction || "Review whether a follow-up spray is needed.",
          });
          await updateActionStatus(action, "applied");
          return;
        }
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
      } else {
        throw new Error(`Unsupported assistant action type: ${intendedActionType(action) || action.action_type || "unknown"}.`);
      }
      await updateActionStatus(action, "applied");
    } catch (err) {
      setError(assistantErrorMessage(err, "Could not apply that suggestion."));
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
      setError(assistantErrorMessage(err, "Could not dismiss that suggestion."));
    } finally {
      setApplyingId(null);
    }
  };

  const emptyText = useMemo(() => (
    mode === "report"
      ? "Generate whole-farm summaries from records, satellite data, finance, documents and compliance."
      : "Ask about fields, crop health, weather, records, stock, finance, livestock, documents or reports."
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
              <Pill tone="neutral">Automatic context</Pill>
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
                        <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted }}>{actionLabel(intendedActionType(action))}</div>
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
              {busy ? "Working" : mode === "report" ? "Report" : "Send"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

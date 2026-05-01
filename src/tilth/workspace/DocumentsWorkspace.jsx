import { useEffect, useMemo, useState } from "react";
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
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { supabase } from "../../lib/supabaseClient.js";
import { fetchTilthApi, tilthApiConfigured } from "../../lib/tilthApi.js";
import { cancelFarmTaskBySourceKey, titleWithSubject, upsertFarmTask } from "../../lib/farmTaskAutomation.js";
import { tilthStore } from "../state/localStore.js";

const CATEGORIES = [
  "certificate",
  "soil_analysis",
  "receipt",
  "invoice",
  "tenancy",
  "insurance",
  "spray_test",
  "nptc",
  "organic",
  "red_tractor",
  "scheme_evidence",
  "map",
  "photo",
  "photograph",
  "report",
  "notice",
  "contract",
  "letter",
  "email",
  "asset",
  "vehicle",
  "field_evidence",
  "other",
  "general",
];

const CATEGORY_LABELS = {
  certificate: "Certificate",
  soil_analysis: "Soil Analysis",
  receipt: "Receipt",
  invoice: "Invoice",
  tenancy: "Tenancy",
  insurance: "Insurance",
  spray_test: "Spray Test",
  nptc: "NPTC",
  organic: "Organic",
  red_tractor: "Red Tractor",
  scheme_evidence: "Scheme Evidence",
  map: "Map",
  photo: "Photo",
  photograph: "Photograph",
  report: "Report",
  notice: "Notice",
  contract: "Contract",
  letter: "Letter",
  email: "Email",
  asset: "Asset",
  vehicle: "Vehicle",
  field_evidence: "Field Evidence",
  other: "Other",
  general: "General",
};

function uid() {
  return crypto.randomUUID?.() || Date.now() + "-" + Math.random().toString(36).slice(2, 8);
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
    return String(iso);
  }
}

function daysUntil(iso) {
  if (!iso) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(iso);
  target.setHours(0, 0, 0, 0);
  return Math.floor((target - now) / 86_400_000);
}

function expiryTone(days) {
  if (days === null) return null;
  if (days < 0) return "danger";
  if (days < 30) return "danger";
  if (days <= 60) return "warn";
  return "ok";
}

function expiryLabel(days) {
  if (days === null) return null;
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  if (days === 0) return "Expires today";
  return `${days}d remaining`;
}

function titleFromFilename(filename) {
  return String(filename || "Untitled document")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Untitled document";
}

function rowToDoc(row) {
  return {
    id: row.id,
    title: row.title || "",
    category: row.category || "general",
    filename: row.filename || "",
    uploadDate: row.created_at ? row.created_at.slice(0, 10) : "",
    documentDate: row.metadata?.document_date || row.metadata?.extracted_details?.document_date || null,
    expiry: row.expiry_date || null,
    fieldId: row.field_id || null,
    tags: row.tags || [],
    notes: row.notes || "",
    bucket: row.bucket || "farm-documents",
    storagePath: row.storage_path,
    contentType: row.content_type || null,
    sizeBytes: row.size_bytes || null,
    status: row.status || "uploaded",
    errorMessage: row.error_message || null,
    deletedAt: row.deleted_at || null,
    metadata: row.metadata || {},
  };
}

const EMPTY_FORM = {
  title: "",
  category: "general",
  filename: "",
  expiry: "",
  fieldId: "",
  tags: "",
  notes: "",
};

const VAULT_PROMPTS = [
  "What does this document say?",
  "Find invoices about equipment.",
  "Summarise compliance evidence.",
  "Draft a supplier payment summary.",
  "Which documents mention dates or deadlines?",
];

const DOCUMENT_LOAD_RETRY_DELAYS = [600, 1500, 3000];
const DOCUMENT_CACHE_PREFIX = "tilth:document-vault:";
const DOCUMENT_LIST_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "farm_id",
  "field_id",
  "title",
  "category",
  "bucket",
  "storage_path",
  "filename",
  "content_type",
  "size_bytes",
  "expiry_date",
  "tags",
  "notes",
  "status",
  "error_message",
  "deleted_at",
].join(",");

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function documentCacheKey(farmId) {
  return `${DOCUMENT_CACHE_PREFIX}${farmId || "none"}`;
}

function loadCachedDocuments(farmId) {
  try {
    const raw = window.localStorage.getItem(documentCacheKey(farmId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.docs) ? parsed.docs : null;
  } catch {
    return null;
  }
}

function saveCachedDocuments(farmId, docs) {
  try {
    window.localStorage.setItem(documentCacheKey(farmId), JSON.stringify({
      savedAt: Date.now(),
      docs,
    }));
  } catch {
    // Ignore storage quota/private mode failures.
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function MiniStat({ label, value, tone }) {
  const toneMap = {
    ok: { bg: brand.okSoft, border: brand.ok, fg: brand.ok },
    warn: { bg: brand.warnSoft, border: brand.warn, fg: brand.warn },
    danger: { bg: brand.dangerSoft, border: brand.danger, fg: brand.danger },
  };
  const t = tone && toneMap[tone] ? toneMap[tone] : { bg: brand.bgSection, border: brand.border, fg: brand.forest };
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        background: t.bg,
        borderRadius: radius.base,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.muted,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: fonts.serif,
          fontSize: 22,
          color: t.fg,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const text = status || "uploaded";
  const tone =
    text === "failed" ? "danger" :
      text === "completed" || text === "graph_loaded" ? "ok" :
        ["processing", "queued", "parsed", "chunked", "embedded", "uploaded"].includes(text) ? "warn" :
          "neutral";
  return <Pill tone={tone}>{text.replace(/_/g, " ")}</Pill>;
}

function DocumentCard({ doc, fieldName, onOpen, onEdit, onDelete }) {
  const days = daysUntil(doc.expiry);
  const tone = expiryTone(days);
  return (
    <Card className="tilth-doc-card" padding={14} style={{ display: "grid", gap: 10 }}>
      <div className="tilth-doc-card-head" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div
            className="tilth-doc-card-filename"
            style={{
              fontFamily: fonts.sans,
              fontSize: 14,
              fontWeight: 650,
              color: brand.forest,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {doc.title || titleFromFilename(doc.filename)}
          </div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 10,
              color: brand.muted,
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {doc.filename || "No file name"} · uploaded {fmtDate(doc.uploadDate)}
          </div>
        </div>
        <StatusPill status={doc.status} />
      </div>

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        <Pill tone="neutral">{CATEGORY_LABELS[doc.category] || doc.category}</Pill>
        {fieldName ? <Pill tone="info">{fieldName}</Pill> : null}
        {doc.expiry ? <Pill tone={tone}>{fmtDate(doc.expiry)} · {expiryLabel(days)}</Pill> : null}
        {(doc.tags || []).slice(0, 4).map((tag) => (
          <Pill key={tag} tone="neutral">{tag}</Pill>
        ))}
      </div>

      {doc.notes ? (
        <Body size="sm" style={{ color: brand.bodySoft, lineHeight: 1.45 }}>
          {doc.notes}
        </Body>
      ) : null}

      {doc.errorMessage ? (
        <Body size="sm" style={{ color: brand.danger }}>
          {doc.errorMessage}
        </Body>
      ) : null}

      <div className="tilth-doc-card-actions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {doc.storagePath ? (
          <Button size="sm" variant="secondary" onClick={() => onOpen(doc)} style={{ minHeight: 32, padding: "6px 10px" }}>
            Open
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onEdit(doc)} style={{ minHeight: 32, padding: "6px 10px" }}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={() => onDelete(doc.id)} style={{ minHeight: 32, padding: "6px 10px", marginLeft: "auto" }}>
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function DocumentsWorkspace({ farm, fields }) {
  const farmId = farm?.id || null;

  const [docs, setDocs] = useState([]);
  const [view, setView] = useState("list");
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chatMessage, setChatMessage] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatSessionId, setChatSessionId] = useState(null);
  const [vaultBusy, setVaultBusy] = useState(null);
  const [suggestedActions, setSuggestedActions] = useState([]);
  const [generatedReports, setGeneratedReports] = useState([]);
  const [applyingActionId, setApplyingActionId] = useState(null);

  const patch = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  useEffect(() => {
    let cancelled = false;
    async function fetchDocumentsOnce(signal) {
      return supabase
        .from("farm_documents")
        .select(DOCUMENT_LIST_COLUMNS)
        .eq("farm_id", farmId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .abortSignal(signal);
    }

    async function loadDocuments() {
      if (!farmId) {
        setDocs([]);
        setLoading(false);
        return;
      }
      if (!supabase) {
        setError("The document vault is not available in this environment.");
        setLoading(false);
        return;
      }
      const cached = loadCachedDocuments(farmId);
      if (cached) setDocs(cached);
      setLoading(!cached);
      setError(null);
      try {
        let data = null;
        let loadError = null;
        let lastThrown = null;
        for (let attempt = 0; attempt <= 1; attempt += 1) {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 5_000);
          try {
            const result = await fetchDocumentsOnce(controller.signal);
            data = result.data;
            loadError = result.error;
            lastThrown = null;
          } catch (err) {
            lastThrown = err;
          } finally {
            window.clearTimeout(timeout);
          }
          if (cancelled) return;
          if (!loadError && !lastThrown) break;
          if (attempt >= 1) break;
          await wait(DOCUMENT_LOAD_RETRY_DELAYS[attempt]);
          if (cancelled) return;
        }
        if (cancelled) return;
        if (lastThrown) throw lastThrown;
        if (loadError) {
          setError("Could not load documents. Check your connection and try again.");
          setDocs([]);
        } else {
          const nextDocs = (data || []).map(rowToDoc);
          setDocs(nextDocs);
          saveCachedDocuments(farmId, nextDocs);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err?.name === "AbortError"
            ? "Document vault request timed out. Check your connection and try again."
            : "Could not load documents. Check your connection and try again.";
          setError(message);
          setDocs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadDocuments();
    return () => {
      cancelled = true;
    };
  }, [farmId]);

  useEffect(() => {
    let cancelled = false;
    async function loadGeneratedReports() {
      if (!farmId || !supabase) {
        setGeneratedReports([]);
        return;
      }
      const { data, error: reportsError } = await supabase
        .from("assistant_generated_reports")
        .select("id,title,report_type,content,metadata,created_at,updated_at")
        .eq("farm_id", farmId)
        .eq("metadata->>kind", "interpretive_report")
        .eq("metadata->>vaultVisible", "true")
        .order("created_at", { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (reportsError) {
        console.warn("Could not load generated reports", reportsError.message);
        setGeneratedReports([]);
      } else {
        setGeneratedReports(data || []);
      }
    }
    loadGeneratedReports();
    const interval = window.setInterval(loadGeneratedReports, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [farmId]);

  const processingDocIds = useMemo(() => {
    const activeStatuses = new Set(["uploaded", "queued", "processing", "parsed", "chunked", "embedded"]);
    return docs.filter((doc) => activeStatuses.has(doc.status)).map((doc) => doc.id).sort().join(",");
  }, [docs]);

  useEffect(() => {
    if (!supabase || !farmId) return undefined;
    if (!processingDocIds) return undefined;
    const interval = window.setInterval(async () => {
      const { data, error: refreshError } = await supabase
        .from("farm_documents")
        .select(DOCUMENT_LIST_COLUMNS)
        .eq("farm_id", farmId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (!refreshError) {
        const nextDocs = (data || []).map(rowToDoc);
        setDocs(nextDocs);
        saveCachedDocuments(farmId, nextDocs);
      }
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [farmId, processingDocIds]);

  useEffect(() => {
    if (!supabase || !farmId) {
      setSuggestedActions([]);
      return undefined;
    }
    let cancelled = false;
    async function loadSuggestedActions() {
      const { data, error: actionError } = await supabase
        .from("document_suggested_actions")
        .select("*")
        .eq("farm_id", farmId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (actionError) {
        console.warn("[DocumentsWorkspace] suggested actions load failed:", actionError.message);
        return;
      }
      setSuggestedActions(data || []);
    }
    loadSuggestedActions();
    const interval = window.setInterval(loadSuggestedActions, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [farmId]);

  const expiryStats = useMemo(() => {
    let expired = 0;
    let soon = 0;
    let ok = 0;
    for (const d of docs) {
      if (!d.expiry) continue;
      const days = daysUntil(d.expiry);
      if (days < 0) expired++;
      else if (days <= 60) soon++;
      else ok++;
    }
    return { expired, soon, ok };
  }, [docs]);

  const categoryBreakdown = useMemo(() => {
    const map = {};
    for (const d of docs) {
      map[d.category] = (map[d.category] || 0) + 1;
    }
    return map;
  }, [docs]);

  const filtered = useMemo(() => {
    let result = docs;
    if (catFilter !== "all") {
      result = result.filter((d) => d.category === catFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (d) =>
          (d.title || "").toLowerCase().includes(q) ||
          (d.filename || "").toLowerCase().includes(q) ||
          (d.notes || "").toLowerCase().includes(q) ||
          (d.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return result;
  }, [docs, catFilter, search]);

  const expiryCalendar = useMemo(() => {
    return docs
      .filter((d) => d.expiry)
      .sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
  }, [docs]);

  useEffect(() => {
    if (!farmId) return;
    for (const doc of docs) {
      if (doc.expiry) {
        upsertFarmTask(farmId, {
          sourceKey: `document:${doc.id}:expiry`,
          source: "document",
          sourceId: doc.id,
          title: titleWithSubject("Document expires", doc.title),
          dueDate: doc.expiry,
          category: "documents",
          priority: "medium",
          notes: "Automatically created from a document expiry date.",
        });
      } else {
        cancelFarmTaskBySourceKey(farmId, `document:${doc.id}:expiry`);
      }
    }
  }, [docs, farmId]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
    setFile(null);
    setDragActive(false);
    setError(null);
  };

  const handleSave = async () => {
    if (editingId && !form.title.trim()) return;
    if (!farmId) {
      setError("Select a farm before adding documents.");
      return;
    }
    if (!supabase) {
      setError("The document vault is not available in this environment.");
      return;
    }
    setSaving(true);
    setError(null);
    const tags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      if (editingId) {
        const update = {
          title: form.title.trim(),
          category: form.category,
          filename: form.filename.trim(),
          expiry_date: form.expiry || null,
          field_id: form.fieldId || null,
          tags,
          notes: form.notes.trim(),
          metadata: { user_edited_details: true, auto_populate: false },
          updated_at: new Date().toISOString(),
        };
        const { data, error: updateError } = await supabase
          .from("farm_documents")
          .update(update)
          .eq("id", editingId)
          .eq("farm_id", farmId)
          .select("*")
          .single();
        if (updateError) throw new Error(updateError.message);
        const doc = rowToDoc(data);
        setDocs((prev) => prev.map((d) => (d.id === editingId ? doc : d)));
        if (doc.expiry) {
          upsertFarmTask(farmId, {
            sourceKey: `document:${doc.id}:expiry`,
            source: "document",
            sourceId: doc.id,
            title: titleWithSubject("Document expires", doc.title),
            dueDate: doc.expiry,
            category: "documents",
            priority: "medium",
            notes: "Automatically created from a document expiry date.",
          });
        } else {
          cancelFarmTaskBySourceKey(farmId, `document:${doc.id}:expiry`);
        }
      }
    } catch (err) {
      setError(err?.message || "Could not save document.");
      setSaving(false);
      return;
    }
    setSaving(false);
    resetForm();
  };

  const handleEdit = (doc) => {
    setForm({
      title: doc.title || "",
      category: doc.category || "general",
      filename: doc.filename || "",
      expiry: doc.expiry || "",
      fieldId: doc.fieldId || "",
      tags: (doc.tags || []).join(", "),
      notes: doc.notes || "",
    });
    setEditingId(doc.id);
    setShowForm(true);
    setFile(null);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this document record?")) return;
    if (!supabase || !farmId) return;
    const { data: authData } = await supabase.auth.getUser();
    const { error: deleteError } = await supabase
      .from("farm_documents")
      .update({
        status: "deleted",
        deleted_at: new Date().toISOString(),
        deleted_by: authData?.user?.id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("farm_id", farmId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await supabase.from("document_processing_jobs").insert({
      farm_id: farmId,
      document_id: id,
      status: "queued",
      metadata: { cleanup: true, source: "documents-workspace" },
    });
    setDocs((prev) => prev.filter((d) => d.id !== id));
    cancelFarmTaskBySourceKey(farmId, `document:${id}:expiry`);
    if (editingId === id) resetForm();
  };

  const openDocument = async (doc) => {
    if (!doc.storagePath || !supabase) return;
    const { data, error: signedError } = await supabase.storage
      .from(doc.bucket || "farm-documents")
      .createSignedUrl(doc.storagePath, 60 * 10);
    if (signedError) {
      setError(signedError.message);
      return;
    }
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const openGeneratedReport = (report) => {
    if (!report?.content || report.metadata?.status !== "completed") return;
    const w = window.open("", "_blank", "width=960,height=1000");
    if (!w) {
      setError("Allow pop-ups to open the generated report.");
      return;
    }
    w.document.open();
    w.document.write(String(report.content).replace("</head>", `<script>document.title = ${JSON.stringify(report.title || "Generated report")};</script></head>`));
    w.document.close();
  };

  const fieldMap = useMemo(() => {
    const m = {};
    for (const f of fields || []) m[f.id] = f.name || "Unnamed field";
    return m;
  }, [fields]);

  const activeCategories = useMemo(() => {
    const set = new Set(docs.map((d) => d.category));
    return ["all", ...CATEGORIES.filter((c) => set.has(c))];
  }, [docs]);

  const documentTitle = (id) => docs.find((d) => d.id === id)?.title || "Document";
  const documentById = (id) => docs.find((d) => d.id === id) || null;
  const visibleSuggestedActions = useMemo(() => {
    return suggestedActions.filter((action) => {
      if (action.action_type !== "spray_record") return true;
      const doc = docs.find((item) => item.id === action.document_id) || null;
      const payload = action.payload || {};
      const evidence = [
        action.title,
        action.summary,
        payload.productName,
        payload.notes,
        doc?.title,
        doc?.filename,
        doc?.notes,
        ...(doc?.tags || []),
      ].join(" ").toLowerCase();
      const hasSprayEvidence = /\b(spray|sprayed|application|applied|herbicide|fungicide|insecticide|mapp|l\/ha|litres?\/ha)\b/.test(evidence);
      const hasOperationalDetail = Boolean(payload.fieldId || Number(payload.rate) > 0 || payload.operator || /field|operator|rate|product/.test(evidence));
      const looksPersonal = /\b(cv|curriculum vitae|resume|researcher|education|experience|skills|phd)\b/.test(evidence);
      return hasSprayEvidence && hasOperationalDetail && !looksPersonal;
    });
  }, [suggestedActions, docs]);
  const uniqueSources = (sources = []) => {
    const seen = new Set();
    return sources.filter((source) => {
      if (!source?.document_id || seen.has(source.document_id)) return false;
      seen.add(source.document_id);
      return true;
    });
  };

  const actionLabel = (type) => ({
    calendar_reminder: "Calendar",
    finance_transaction: "Finance",
    inventory_item: "Inventory",
    spray_record: "Records",
  }[type] || "Action");

  const applySuggestedAction = async (action) => {
    if (!action || !farmId || !supabase) return;
    const payload = action.payload || {};
    setApplyingActionId(action.id);
    setError(null);
    try {
      if (action.action_type === "calendar_reminder") {
        upsertFarmTask(farmId, {
          sourceKey: payload.sourceKey || `document:${action.document_id}:calendar`,
          source: "document-vault",
          sourceId: action.document_id,
          title: payload.title || action.title,
          dueDate: payload.dueDate,
          reminderDays: payload.reminderDays ?? 3,
          category: payload.category || "documents",
          priority: payload.priority || "medium",
          notes: payload.notes || action.summary || "",
        });
      } else if (action.action_type === "finance_transaction") {
        const rows = tilthStore.loadFinances(farmId);
        const amount = payload.amount ?? payload.amountDue ?? payload.totalAmount ?? payload.total ?? payload.grossAmount;
        const vatAmount = payload.vatAmount ?? payload.vat ?? payload.vatTotal ?? payload.taxAmount;
        const entry = {
          id: payload.id || uid(),
          type: payload.type || "expense",
          date: payload.date || payload.invoiceDate || payload.documentDate || payload.transactionDate || payload.dueDate || new Date().toISOString().slice(0, 10),
          amount: Number(amount) || 0,
          vatAmount: Number(vatAmount) || 0,
          category: payload.category || "other",
          description: payload.description || action.title,
          counterparty: payload.counterparty || payload.supplier || payload.vendor || payload.issuer || "",
          invoiceRef: payload.invoiceRef || payload.invoiceNumber || payload.invoiceNo || payload.reference || "",
          fieldId: payload.fieldId || "",
          notes: payload.notes || "",
          sourceKey: payload.sourceKey || `document:${action.document_id}:finance`,
          createdAt: new Date().toISOString(),
        };
        const next = rows.some((row) => row.sourceKey === entry.sourceKey)
          ? rows.map((row) => (row.sourceKey === entry.sourceKey ? { ...row, ...entry, id: row.id, updatedAt: new Date().toISOString() } : row))
          : [entry, ...rows];
        tilthStore.saveFinances(farmId, next);
      } else if (action.action_type === "inventory_item") {
        const rows = tilthStore.loadInventory(farmId);
        const entry = {
          id: payload.id || uid(),
          name: payload.name || action.title,
          category: payload.category || "other",
          unit: payload.unit || "unit",
          quantity: Number(payload.quantity) || 0,
          unitCost: Number(payload.unitCost) || 0,
          batchNumber: payload.batchNumber || "",
          supplier: payload.supplier || "",
          purchaseDate: payload.purchaseDate || "",
          expiryDate: payload.expiryDate || "",
          storageLocation: payload.storageLocation || "",
          mappNumber: payload.mappNumber || "",
          lowStockThreshold: payload.lowStockThreshold ?? null,
          notes: payload.notes || "",
          sourceKey: payload.sourceKey || `document:${action.document_id}:inventory`,
          adjustments: [],
          createdAt: new Date().toISOString(),
        };
        const next = rows.some((row) => row.sourceKey === entry.sourceKey)
          ? rows.map((row) => (row.sourceKey === entry.sourceKey ? { ...row, ...entry, id: row.id, adjustments: row.adjustments || [] } : row))
          : [entry, ...rows];
        tilthStore.saveInventory(farmId, next);
        if (entry.expiryDate) {
          upsertFarmTask(farmId, {
            sourceKey: `inventory:${entry.id}:expiry`,
            source: "inventory",
            sourceId: entry.id,
            title: titleWithSubject("Stock expires", entry.name),
            dueDate: entry.expiryDate,
            category: "inventory",
            priority: "medium",
            notes: "Automatically created from an inventory expiry date.",
          });
        }
      } else if (action.action_type === "spray_record") {
        const productName = payload.productName || action.title;
        const productId = `doc-${String(action.id).slice(0, 8)}`;
        const customProducts = tilthStore.loadCustomProducts(farmId);
        if (!customProducts.some((p) => p.id === productId || p.name?.toLowerCase() === productName.toLowerCase())) {
          tilthStore.saveCustomProducts(farmId, [
            ...customProducts,
            {
              id: productId,
              name: productName,
              category: "Other",
              unit: "L/ha",
              defaultRate: Number(payload.rate) || 0,
              ai: "",
              custom: true,
            },
          ]);
        }
        const records = tilthStore.loadRecords(farmId);
        const record = {
          id: payload.id || `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          createdAt: new Date().toISOString(),
          fieldId: payload.fieldId || "",
          fieldName: payload.fieldName || fieldMap[payload.fieldId] || "",
          productId,
          rate: Number(payload.rate) || 0,
          isBlend: false,
          blendProducts: [],
          date: payload.date || new Date().toISOString().slice(0, 10),
          startTime: "",
          endTime: "",
          windDirection: "",
          operator: payload.operator || "",
          notes: payload.notes || action.summary || "",
          area: 0,
          sourceKey: payload.sourceKey || `document:${action.document_id}:spray_record`,
        };
        const next = records.some((row) => row.sourceKey === record.sourceKey)
          ? records.map((row) => (row.sourceKey === record.sourceKey ? { ...row, ...record, id: row.id, createdAt: row.createdAt } : row))
          : [record, ...records];
        tilthStore.saveRecords(farmId, next);
      }
      const { data: authData } = await supabase.auth.getUser();
      const { error: updateError } = await supabase
        .from("document_suggested_actions")
        .update({
          status: "applied",
          applied_at: new Date().toISOString(),
          applied_by: authData?.user?.id || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", action.id)
        .eq("farm_id", farmId);
      if (updateError) throw new Error(updateError.message);
      setSuggestedActions((prev) => prev.filter((item) => item.id !== action.id));
    } catch (err) {
      setError(err?.message || "Could not apply suggested action.");
    } finally {
      setApplyingActionId(null);
    }
  };

  const dismissSuggestedAction = async (action) => {
    if (!action || !farmId || !supabase) return;
    setApplyingActionId(action.id);
    setError(null);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const { error: updateError } = await supabase
        .from("document_suggested_actions")
        .update({
          status: "dismissed",
          dismissed_at: new Date().toISOString(),
          dismissed_by: authData?.user?.id || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", action.id)
        .eq("farm_id", farmId);
      if (updateError) throw new Error(updateError.message);
      setSuggestedActions((prev) => prev.filter((item) => item.id !== action.id));
    } catch (err) {
      setError(err?.message || "Could not dismiss suggested action.");
    } finally {
      setApplyingActionId(null);
    }
  };

  const callVaultApi = async (path, body) => {
    if (!tilthApiConfigured()) throw new Error("Document intelligence is not available right now.");
    if (!supabase) throw new Error("The document vault is not available right now.");
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("You need to be signed in.");
    const response = await fetchTilthApi(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ farmId, ...body }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Document Vault request failed.");
    return payload;
  };

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    if (!farmId) {
      setError("Select a farm before adding documents.");
      return;
    }
    if (!supabase) {
      setError("The document vault is not available in this environment.");
      return;
    }
    setSaving(true);
    setError(null);
    setFile(files[0] || null);
    try {
      for (const nextFile of files) {
        const result = await callVaultApi("/api/document-vault/documents", {
          filename: nextFile.name || "document",
          title: titleFromFilename(nextFile.name),
          category: "general",
          tags: [],
          notes: "",
          mimeType: nextFile.type || "application/octet-stream",
          fileBase64: await fileToBase64(nextFile),
        });
        const doc = rowToDoc(result.document);
        setDocs((prev) => {
          const next = [doc, ...prev.filter((item) => item.id !== doc.id)];
          saveCachedDocuments(farmId, next);
          return next;
        });
      }
      setShowForm(false);
      setFile(null);
      setDragActive(false);
    } catch (err) {
      setError(err?.message || "Could not upload document.");
    } finally {
      setSaving(false);
    }
  };

  const runChat = async () => {
    if (!chatMessage.trim()) return;
    const text = chatMessage.trim();
    setVaultBusy("chat");
    setError(null);
    setChatMessage("");
    setChatMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", content: text, sources: [] },
    ]);
    try {
      const result = await callVaultApi("/api/platform-assistant/chat", {
        message: text,
        chatSessionId,
        scope: "documents",
      });
      if (result.chatSessionId) setChatSessionId(result.chatSessionId);
      setChatMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: result.answer || "[Information not found in Tilth]",
          sources: result.sources || result.sourceDocuments || [],
        },
      ]);
    } catch (err) {
      setError(err?.message || "Chat failed.");
      setChatMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", content: err?.message || "Chat failed.", sources: [], error: true },
      ]);
    } finally {
      setVaultBusy(null);
    }
  };

  const openSourceDocument = (documentId) => {
    const doc = documentById(documentId);
    if (doc) openDocument(doc);
  };

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Vault"
          title="Documents"
          description="Drop in farm documents, let the vault extract the details, then review and edit the finished record."
          actions={
            <Button
              variant={showForm ? "secondary" : "primary"}
              size="sm"
              onClick={() => {
                if (showForm) resetForm();
                else setShowForm(true);
              }}
            >
              {showForm ? "Cancel" : "Upload documents"}
            </Button>
          }
        />
      }
    >
      <div
        className="tilth-docs-layout"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 300px",
          gap: 12,
          overflow: "hidden",
        }}
      >
        {/* Main column */}
        <div
          className="tilth-docs-main tilth-scroll"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            paddingRight: 4,
          }}
        >
          {loading ? (
            <Body size="sm" style={{ color: brand.muted }}>
              Loading documents…
            </Body>
          ) : null}

          {/* Summary stats */}
          <div className="tilth-docs-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <MiniStat label="Total" value={docs.length} />
            <MiniStat label="Expiring soon" value={expiryStats.soon} tone={expiryStats.soon ? "warn" : undefined} />
            <MiniStat label="Expired" value={expiryStats.expired} tone={expiryStats.expired ? "danger" : undefined} />
            <MiniStat label="Valid" value={expiryStats.ok} tone={expiryStats.ok ? "ok" : undefined} />
          </div>

          {/* Add/edit form */}
          {showForm && (
            <Card className="tilth-docs-form-card" padding={14}>
              <Kicker style={{ marginBottom: 10 }}>
                {editingId ? "Edit extracted details" : "Upload documents"}
              </Kicker>
              {!editingId ? (
                <>
                  <div
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragActive(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragActive(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      setDragActive(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragActive(false);
                      uploadFiles(event.dataTransfer.files);
                    }}
                    style={{
                      border: `1px dashed ${dragActive ? brand.forest : brand.border}`,
                      background: dragActive ? brand.bgSection : brand.white,
                      borderRadius: radius.lg,
                      padding: "26px 18px",
                      textAlign: "center",
                      display: "grid",
                      gap: 10,
                      placeItems: "center",
                    }}
                  >
                    <div style={{ fontFamily: fonts.serif, fontSize: 20, color: brand.forest }}>
                      Drop files here
                    </div>
                    <Body size="sm" style={{ color: brand.bodySoft, maxWidth: 520 }}>
                      The vault will upload the file, queue extraction, and fill out the document title,
                      category, dates, tags and evidence automatically where it can. Review and edit
                      the record once processing has finished.
                    </Body>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: `1px solid ${brand.forest}`,
                        background: brand.forest,
                        color: brand.white,
                        borderRadius: radius.base,
                        padding: "9px 12px",
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        cursor: saving ? "not-allowed" : "pointer",
                        opacity: saving ? 0.6 : 1,
                      }}
                    >
                      {saving ? "Uploading..." : "Choose files"}
                      <input
                        type="file"
                        multiple
                        disabled={saving}
                        onChange={(event) => {
                          uploadFiles(event.target.files);
                          event.target.value = "";
                        }}
                        style={{ display: "none" }}
                      />
                    </label>
                    {file ? <Body size="sm" style={{ color: brand.muted }}>{file.name}</Body> : null}
                  </div>
                  {error ? <Body size="sm" style={{ color: brand.danger, marginTop: 10 }}>{error}</Body> : null}
                  <div className="tilth-docs-actions" style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <Button variant="ghost" size="sm" onClick={resetForm}>
                      Close
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="tilth-docs-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <FieldLabel>Title</FieldLabel>
                      <input
                        value={form.title}
                        onChange={(e) => patch("title", e.target.value)}
                        placeholder="e.g. Red Tractor Certificate 2026"
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <FieldLabel>Category</FieldLabel>
                      <select
                        value={form.category}
                        onChange={(e) => patch("category", e.target.value)}
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <FieldLabel>Filename</FieldLabel>
                      <input
                        value={form.filename}
                        onChange={(e) => patch("filename", e.target.value)}
                        placeholder="e.g. red-tractor-cert-2026.pdf"
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <FieldLabel>Expiry date</FieldLabel>
                      <input
                        type="date"
                        value={form.expiry}
                        onChange={(e) => patch("expiry", e.target.value)}
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <FieldLabel>Link to field</FieldLabel>
                      <select
                        value={form.fieldId}
                        onChange={(e) => patch("fieldId", e.target.value)}
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
                      >
                        <option value="">None</option>
                        {(fields || []).map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name || "Unnamed field"}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <FieldLabel>Tags</FieldLabel>
                      <input
                        value={form.tags}
                        onChange={(e) => patch("tags", e.target.value)}
                        placeholder="e.g. annual, compliance, audit"
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
                      />
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <FieldLabel>Notes</FieldLabel>
                      <textarea
                        value={form.notes}
                        onChange={(e) => patch("notes", e.target.value)}
                        rows={2}
                        placeholder="Any additional notes about this document..."
                        style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, resize: "vertical" }}
                      />
                    </div>
                    {error ? (
                      <div style={{ gridColumn: "1 / -1" }}>
                        <Body size="sm" style={{ color: brand.danger }}>{error}</Body>
                      </div>
                    ) : null}
                  </div>
                  <div className="tilth-docs-actions" style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleSave}
                      disabled={saving || !form.title.trim()}
                    >
                      {saving ? "Saving..." : "Save changes"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={resetForm}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </Card>
          )}

          {generatedReports.length ? (
            <Card padding={14} tone="section">
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                <div>
                  <Kicker>Generated reports</Kicker>
                  <Body size="sm" style={{ color: brand.muted, marginTop: 4 }}>
                    AI interpretive reports saved from the reports page. These are stored as generated reports, not uploaded files, so they do not enter extraction processing.
                  </Body>
                </div>
                <Pill tone="neutral">{generatedReports.length}</Pill>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
                {generatedReports.map((report) => {
                  const status = report.metadata?.status || "processing";
                  return (
                    <div key={report.id} style={{ border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white, padding: "10px 11px", display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 650, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {report.title || "Generated report"}
                          </div>
                          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, marginTop: 3 }}>
                            {fmtDate(report.created_at)} · {report.metadata?.cadence || "report"}
                          </div>
                        </div>
                        <Pill tone={status === "completed" ? "ok" : status === "failed" ? "danger" : "warn"}>{status === "completed" ? "Ready" : status}</Pill>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Button size="sm" variant="secondary" onClick={() => openGeneratedReport(report)} disabled={status !== "completed"} style={{ minHeight: 30, padding: "6px 10px" }}>
                          Open
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openGeneratedReport(report)} disabled={status !== "completed"} style={{ minHeight: 30, padding: "6px 10px" }}>
                          Print / save
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}

          {/* Filters */}
          <div className="tilth-docs-filters" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or filename…"
              style={{ ...inputStyle, padding: "8px 10px", fontSize: 12, maxWidth: 260 }}
            />
            <div className="tilth-docs-filter-tabs" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {activeCategories.map((c) => {
                const active = catFilter === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCatFilter(c)}
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      padding: "5px 9px",
                      borderRadius: radius.base,
                      border: `1px solid ${active ? brand.forest : brand.border}`,
                      background: active ? brand.forest : brand.white,
                      color: active ? brand.white : brand.forest,
                      cursor: "pointer",
                    }}
                  >
                    {c === "all" ? "All" : CATEGORY_LABELS[c] || c}
                    {c !== "all" ? ` (${categoryBreakdown[c] || 0})` : ""}
                  </button>
                );
              })}
            </div>
            <div className="tilth-docs-filter-spacer" style={{ flex: 1 }} />
            <div className="tilth-docs-view-tabs" style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                onClick={() => setView("list")}
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  padding: "5px 9px",
                  borderRadius: radius.base,
                  border: `1px solid ${view === "list" ? brand.forest : brand.border}`,
                  background: view === "list" ? brand.forest : brand.white,
                  color: view === "list" ? brand.white : brand.forest,
                  cursor: "pointer",
                }}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => setView("expiry")}
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  padding: "5px 9px",
                  borderRadius: radius.base,
                  border: `1px solid ${view === "expiry" ? brand.forest : brand.border}`,
                  background: view === "expiry" ? brand.forest : brand.white,
                  color: view === "expiry" ? brand.white : brand.forest,
                  cursor: "pointer",
                }}
              >
                Expiry calendar
              </button>
            </div>
          </div>

          {/* Document list */}
          {view === "list" && (
            <>
              {loading ? (
                <Card padding={18}>
                  <Body size="sm" style={{ color: brand.muted }}>
                    Loading document vault…
                  </Body>
                </Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  kicker="No documents"
                  title={docs.length ? "No matches" : "Document vault is empty"}
                  description={
                    docs.length
                      ? "Try adjusting your search or category filter."
                      : "Add certificates, receipts and compliance evidence to keep everything in one place. Track expiry dates so nothing lapses."
                  }
                  actions={
                    !docs.length ? (
                      <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                        Add first document
                      </Button>
                    ) : null
                  }
                />
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {filtered.map((d) => (
                    <DocumentCard
                      key={d.id}
                      doc={d}
                      fieldName={d.fieldId ? fieldMap[d.fieldId] : ""}
                      onOpen={openDocument}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Expiry calendar */}
          {view === "expiry" && (
            <>
              {expiryCalendar.length === 0 ? (
                <EmptyState
                  kicker="No expiry dates"
                  title="Nothing tracked"
                  description="Add expiry dates to documents to see upcoming renewals and deadlines here."
                />
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {expiryCalendar.map((d) => {
                    const days = daysUntil(d.expiry);
                    const tone = expiryTone(days);
                    return (
                      <Row key={d.id} style={{ padding: "10px 12px" }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontWeight: 600,
                                color: brand.forest,
                                fontSize: 13,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {d.title}
                            </div>
                            <div
                              style={{
                                fontFamily: fonts.mono,
                                fontSize: 10,
                                color: brand.muted,
                                marginTop: 2,
                              }}
                            >
                              {CATEGORY_LABELS[d.category] || d.category} · {d.filename}
                            </div>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flex: "0 0 auto",
                            }}
                          >
                            <span
                              style={{
                                fontFamily: fonts.mono,
                                fontSize: 11,
                                color: brand.bodySoft,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {fmtDate(d.expiry)}
                            </span>
                            {tone && <Pill tone={tone}>{expiryLabel(days)}</Pill>}
                          </div>
                        </div>
                      </Row>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right sidebar */}
        <div
          className="tilth-docs-sidebar tilth-scroll"
          style={{
            minHeight: 0,
            minWidth: 0,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            paddingRight: 4,
          }}
        >
          {/* Suggested actions */}
          <Card padding={12} tone={visibleSuggestedActions.length ? "section" : undefined}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <Kicker>Assistant actions</Kicker>
              {visibleSuggestedActions.length ? <Pill tone="warn">{visibleSuggestedActions.length} pending</Pill> : null}
            </div>
            {visibleSuggestedActions.length === 0 ? (
              <Body size="sm" style={{ color: brand.muted }}>
                Uploads will appear here when Tilth finds calendar, finance, inventory or records actions to confirm.
              </Body>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {visibleSuggestedActions.slice(0, 5).map((action) => {
                  const payload = action.payload || {};
                  return (
                    <div
                      key={action.id}
                      style={{
                        border: `1px solid ${brand.border}`,
                        borderRadius: radius.base,
                        background: brand.white,
                        padding: "9px 10px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontFamily: fonts.sans,
                              fontSize: 12.5,
                              fontWeight: 650,
                              color: brand.forest,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {action.title}
                          </div>
                          <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted, marginTop: 2 }}>
                            {actionLabel(action.action_type)} · {documentTitle(action.document_id)}
                          </div>
                        </div>
                        <Pill tone="neutral">{Math.round(Number(action.confidence || 0) * 100)}%</Pill>
                      </div>
                      {action.summary ? (
                        <Body size="sm" style={{ marginTop: 6, color: brand.bodySoft }}>
                          {action.summary}
                        </Body>
                      ) : null}
                      <div style={{ display: "grid", gap: 3, marginTop: 7, fontFamily: fonts.mono, fontSize: 10, color: brand.bodySoft }}>
                        {payload.dueDate ? <span>Due: {fmtDate(payload.dueDate)}</span> : null}
                        {payload.amount != null ? <span>Amount: £{Number(payload.amount || 0).toFixed(2)}</span> : null}
                        {payload.name ? <span>Item: {payload.name}</span> : null}
                        {payload.productName ? <span>Product: {payload.productName}</span> : null}
                        {payload.invoiceRef ? <span>Invoice: {payload.invoiceRef}</span> : null}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => applySuggestedAction(action)}
                          disabled={applyingActionId === action.id}
                          style={{ flex: 1 }}
                        >
                          {applyingActionId === action.id ? "Applying…" : "Apply"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => dismissSuggestedAction(action)}
                          disabled={applyingActionId === action.id}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Category breakdown */}
          <Card padding={12}>
            <Kicker style={{ marginBottom: 8 }}>By category</Kicker>
            {CATEGORIES.filter((c) => categoryBreakdown[c]).length === 0 ? (
              <Body size="sm" style={{ color: brand.muted }}>
                No documents yet.
              </Body>
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                {CATEGORIES.filter((c) => categoryBreakdown[c]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setCatFilter(catFilter === c ? "all" : c);
                      setView("list");
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "7px 10px",
                      borderRadius: radius.base,
                      border: `1px solid ${catFilter === c ? brand.forest : brand.border}`,
                      background: catFilter === c ? brand.bgSection : brand.white,
                      cursor: "pointer",
                      fontFamily: fonts.sans,
                      fontSize: 12,
                      color: brand.forest,
                      textAlign: "left",
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  >
                    <span>{CATEGORY_LABELS[c]}</span>
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        color: brand.muted,
                      }}
                    >
                      {categoryBreakdown[c]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {/* Upcoming expiries */}
          <Card padding={12}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <Kicker>Upcoming expiries</Kicker>
              {expiryStats.expired + expiryStats.soon > 0 && (
                <Pill tone={expiryStats.expired ? "danger" : "warn"}>
                  {expiryStats.expired + expiryStats.soon} need attention
                </Pill>
              )}
            </div>
            {expiryCalendar.filter((d) => daysUntil(d.expiry) <= 60).length === 0 ? (
              <Body size="sm" style={{ color: brand.muted }}>
                No documents expiring within 60 days.
              </Body>
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                {expiryCalendar
                  .filter((d) => daysUntil(d.expiry) <= 60)
                  .map((d) => {
                    const days = daysUntil(d.expiry);
                    const tone = expiryTone(days);
                    return (
                      <div
                        key={d.id}
                        style={{
                          padding: "7px 10px",
                          border: `1px solid ${brand.border}`,
                          borderLeft: `3px solid ${tone === "danger" ? brand.danger : tone === "warn" ? brand.warn : brand.ok}`,
                          borderRadius: radius.base,
                          background: brand.white,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: fonts.sans,
                            fontSize: 12,
                            fontWeight: 600,
                            color: brand.forest,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {d.title}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 6,
                            marginTop: 3,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: fonts.mono,
                              fontSize: 10,
                              color: brand.muted,
                            }}
                          >
                            {fmtDate(d.expiry)}
                          </span>
                          <Pill tone={tone} style={{ fontSize: 8 }}>
                            {expiryLabel(days)}
                          </Pill>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </Card>

          {/* Vault intelligence */}
          <Card padding={12} elevated>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <div>
                <Kicker>Vault assistant</Kicker>
                <Body size="sm" style={{ color: brand.muted, marginTop: 4 }}>
                  Ask naturally. The assistant will search, summarise, draft, or open evidence from your message.
                </Body>
              </div>
              {vaultBusy ? <Pill tone="neutral">Thinking...</Pill> : null}
            </div>

            <div
              className="tilth-vault-chat-history"
              style={{
                display: "grid",
                gap: 8,
                maxHeight: 340,
                overflowY: "auto",
                paddingRight: 3,
                marginBottom: 10,
              }}
            >
              {chatMessages.length ? (
                chatMessages.map((message) => {
                  const isUser = message.role === "user";
                  return (
                    <div
                      key={message.id}
                      style={{
                        justifySelf: isUser ? "end" : "start",
                        maxWidth: "92%",
                        border: `1px solid ${message.error ? brand.danger : brand.border}`,
                        borderRadius: radius.base,
                        padding: "8px 10px",
                        background: isUser ? brand.forest : brand.bgSection,
                        color: isUser ? brand.white : brand.body,
                      }}
                    >
                      <Body size="sm" style={{ color: isUser ? brand.white : message.error ? brand.danger : brand.bodySoft, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                        {message.content}
                      </Body>
                      {uniqueSources(message.sources).length ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
                          {uniqueSources(message.sources).slice(0, 5).map((source) => (
                            <button
                              key={source.document_id}
                              type="button"
                              onClick={() => openSourceDocument(source.document_id)}
                              style={{
                                fontFamily: fonts.mono,
                                fontSize: 9,
                                letterSpacing: "0.08em",
                                textTransform: "uppercase",
                                color: brand.forest,
                                background: brand.white,
                                border: `1px solid ${brand.border}`,
                                borderRadius: radius.base,
                                padding: "4px 6px",
                                cursor: "pointer",
                              }}
                            >
                              Open {documentTitle(source.document_id)}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <div style={{ border: `1px dashed ${brand.border}`, borderRadius: radius.base, padding: 10, background: brand.bgSection }}>
                  <Body size="sm" style={{ color: brand.bodySoft, lineHeight: 1.5 }}>
                    Start with a question like "summarise the latest document", "find invoices about machinery", or
                    "draft a short report from the compliance evidence".
                  </Body>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
              {VAULT_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setChatMessage(prompt)}
                  style={{
                    fontFamily: fonts.sans,
                    fontSize: 11,
                    color: brand.forest,
                    background: brand.bgSection,
                    border: `1px solid ${brand.border}`,
                    borderRadius: radius.base,
                    padding: "5px 7px",
                    cursor: "pointer",
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>

            <textarea
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              rows={3}
              placeholder="Ask anything about your documents..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runChat();
              }}
              style={{ ...inputStyle, padding: "9px 10px", fontSize: 12, resize: "vertical", marginBottom: 8 }}
            />
            <Button
              size="sm"
              variant="primary"
              onClick={runChat}
              disabled={Boolean(vaultBusy) || !chatMessage.trim()}
              style={{ width: "100%" }}
            >
              {vaultBusy ? "Thinking..." : "Send message"}
            </Button>
            <Body size="sm" style={{ color: brand.muted, marginTop: 6 }}>
              Tip: use Ctrl+Enter to send. Source buttons open the underlying document.
            </Body>
          </Card>

          {/* About */}
          <Card padding={12} tone="section">
            <Kicker style={{ marginBottom: 6 }}>About</Kicker>
            <Body size="sm" style={{ lineHeight: 1.55 }}>
              Document records sync with your farm data. Uploads are stored privately
              and opened through short-lived secure links.
              Expiry tracking highlights documents due within 60 days (amber) or 30 days / expired (red).
            </Body>
          </Card>
        </div>
      </div>

      <style>{`
        @media (max-width: 1100px) {
          .tilth-docs-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .tilth-docs-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
            gap: 12px !important;
            padding-bottom: 18px !important;
          }
          .tilth-docs-main,
          .tilth-docs-sidebar {
            overflow: visible !important;
            min-height: auto !important;
            padding-right: 0 !important;
          }
          .tilth-docs-main {
            order: 1;
          }
          .tilth-docs-sidebar {
            order: 2;
          }
          .tilth-docs-stats {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .tilth-docs-form-card {
            padding: 14px !important;
          }
          .tilth-docs-form-grid {
            grid-template-columns: 1fr !important;
            gap: 10px !important;
          }
          .tilth-docs-actions {
            display: grid !important;
            grid-template-columns: 1fr !important;
          }
          .tilth-docs-actions button {
            width: 100% !important;
          }
          .tilth-docs-filters {
            display: grid !important;
            grid-template-columns: 1fr !important;
            align-items: stretch !important;
          }
          .tilth-docs-filters > input {
            max-width: none !important;
            width: 100% !important;
          }
          .tilth-docs-filter-spacer {
            display: none !important;
          }
          .tilth-docs-filter-tabs,
          .tilth-docs-view-tabs {
            overflow-x: auto !important;
            flex-wrap: nowrap !important;
            padding-bottom: 4px !important;
          }
          .tilth-docs-filter-tabs button,
          .tilth-docs-view-tabs button {
            flex: 0 0 auto;
            min-height: 40px !important;
            border-radius: 8px !important;
          }
          .tilth-doc-card {
            min-width: 0 !important;
          }
          .tilth-doc-card-head {
            display: grid !important;
            grid-template-columns: 1fr !important;
            gap: 8px !important;
          }
          .tilth-doc-card-filename {
            white-space: normal !important;
            overflow-wrap: anywhere !important;
          }
          .tilth-doc-card-actions {
            display: grid !important;
            grid-template-columns: 1fr !important;
          }
          .tilth-doc-card-actions button {
            width: 100% !important;
            margin-left: 0 !important;
          }
        }
        @media (max-width: 420px) {
          .tilth-docs-stats {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

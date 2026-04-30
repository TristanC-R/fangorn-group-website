import { createHash } from "node:crypto";

import {
  adminClient,
  isConfigured as supabaseConfigured,
  userIdFromJwt,
} from "./supabaseAdmin.mjs";

const DEFAULT_EMBEDDING_MODEL = process.env.DOCUMENT_VAULT_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_CHAT_MODEL = process.env.PLATFORM_ASSISTANT_CHAT_MODEL || process.env.DOCUMENT_VAULT_CHAT_MODEL || "gpt-4o-mini";
const MAX_CONTEXT_CHARS = Number(process.env.PLATFORM_ASSISTANT_MAX_CONTEXT_CHARS || 26_000);

const APP_NAMESPACES = [
  "records",
  "custom_products",
  "assignments",
  "yield",
  "fieldAttrs",
  "plantings",
  "tasks",
  "finances",
  "inventory",
  "contacts",
  "observations",
  "livestock",
  "livestock_movements",
  "livestock_medicines",
  "livestock_breeding",
  "market_prices",
  "market_sales",
  "market_purchases",
  "market_watchlist",
  "audit_checklists",
  "preharvest_safety",
  "official_data_settings",
  "rotations",
  "team_locations",
];

const ACTION_TYPES = new Set([
  "calendar_reminder",
  "finance_transaction",
  "inventory_item",
  "inventory_adjustment",
  "spray_record",
  "contact",
  "compliance_checklist",
  "market_watchlist",
  "livestock_medicine",
  "livestock_movement",
]);

function bearerFromRequest(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let len = 0;
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      buf += chunk;
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function authenticatedUser(req) {
  if (!supabaseConfigured) {
    return { error: { status: 503, body: { error: "supabase service not configured" } } };
  }
  const jwt = bearerFromRequest(req);
  if (!jwt) return { error: { status: 401, body: { error: "missing Authorization: Bearer <jwt>" } } };
  const userId = await userIdFromJwt(jwt);
  if (!userId) return { error: { status: 401, body: { error: "invalid or expired jwt" } } };
  return { userId, jwt };
}

async function userCanReadFarm(userId, farmId) {
  if (!userId || !farmId) return false;
  const admin = adminClient();
  if (!admin) return false;
  const { data: farm } = await admin
    .from("farms")
    .select("id")
    .eq("id", farmId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (farm) return true;
  const { data: member } = await admin
    .from("farm_members")
    .select("id")
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(member);
}

async function userCanEditFarm(userId, farmId) {
  if (!userId || !farmId) return false;
  const admin = adminClient();
  if (!admin) return false;
  const { data: farm } = await admin
    .from("farms")
    .select("id")
    .eq("id", farmId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (farm) return true;
  const { data: member } = await admin
    .from("farm_members")
    .select("id")
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .in("role", ["operator", "manager", "admin"])
    .maybeSingle();
  return Boolean(member);
}

function fallbackEmbedding(text, dimensions = 1536) {
  const seed = createHash("sha256").update(String(text || "")).digest();
  const values = [];
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const signed = (seed[i % seed.length] / 255) * 2 - 1;
    values.push(signed);
    norm += signed * signed;
  }
  const denom = Math.sqrt(norm) || 1;
  return values.map((v) => v / denom);
}

async function embedText(text) {
  if (!OPENAI_API_KEY) {
    return {
      model: `local-hash-${DEFAULT_EMBEDDING_MODEL}`,
      embedding: fallbackEmbedding(text),
      provider: "local-hash",
    };
  }
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: DEFAULT_EMBEDDING_MODEL, input: text }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || "embedding request failed");
  return { model: DEFAULT_EMBEDDING_MODEL, embedding: body?.data?.[0]?.embedding, provider: "openai" };
}

async function chatCompletion(messages, { jsonMode = false, temperature = 0.2 } = {}) {
  if (!OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      temperature,
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || "chat completion failed");
  return body?.choices?.[0]?.message?.content || null;
}

function truncate(value, max = 1800) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function areaHa(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) return null;
  const points = boundary.map((p) => ({
    lat: Number(p.lat),
    lng: Number(p.lng),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (points.length < 3) return null;
  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((meanLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.lng * mLng * (b.lat * mLat) - b.lng * mLng * (a.lat * mLat);
  }
  return Math.round((Math.abs(sum) / 2 / 10_000) * 100) / 100;
}

function centroid(fields) {
  const coords = [];
  for (const field of fields || []) {
    for (const point of field.boundary || []) {
      if (Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))) {
        coords.push({ lat: Number(point.lat), lng: Number(point.lng) });
      }
    }
  }
  if (!coords.length) return null;
  return {
    lat: coords.reduce((sum, p) => sum + p.lat, 0) / coords.length,
    lng: coords.reduce((sum, p) => sum + p.lng, 0) / coords.length,
  };
}

function summarizeNamespace(ns, data) {
  if (Array.isArray(data)) {
    return {
      namespace: ns,
      type: "array",
      count: data.length,
      recent: data.slice(0, 10),
    };
  }
  if (data && typeof data === "object") {
    const entries = Object.entries(data);
    return {
      namespace: ns,
      type: "object",
      count: entries.length,
      sample: Object.fromEntries(entries.slice(0, 12)),
    };
  }
  return { namespace: ns, type: typeof data, value: data ?? null };
}

const DOCUMENT_CATEGORY_ALIASES = [
  ["invoice", ["invoice", "invoices", "bill", "bills", "billing"]],
  ["receipt", ["receipt", "receipts"]],
  ["soil_analysis", ["soil", "analysis", "analyses", "sample", "samples"]],
  ["certificate", ["certificate", "certificates", "certification"]],
  ["tenancy", ["tenancy", "lease", "landlord"]],
  ["insurance", ["insurance", "policy", "policies"]],
  ["spray_test", ["spray test", "sprayer", "nsts"]],
  ["nptc", ["nptc", "pa1", "pa2", "pa6"]],
  ["organic", ["organic"]],
  ["red_tractor", ["red tractor", "redtractor"]],
  ["scheme_evidence", ["scheme", "sfi", "cs", "evidence", "rpa", "defra"]],
  ["map", ["map", "maps"]],
  ["photo", ["photo", "photos", "photograph", "photographs"]],
  ["report", ["report", "reports"]],
  ["notice", ["notice", "notices"]],
  ["contract", ["contract", "contracts"]],
  ["letter", ["letter", "letters"]],
  ["email", ["email", "emails"]],
  ["asset", ["asset", "assets"]],
  ["vehicle", ["vehicle", "vehicles", "tractor", "tractors"]],
  ["field_evidence", ["field evidence"]],
];

const DOCUMENT_STOPWORDS = new Set([
  "about",
  "across",
  "available",
  "document",
  "documents",
  "farm",
  "file",
  "files",
  "find",
  "have",
  "show",
  "that",
  "the",
  "what",
  "which",
  "with",
]);

function inferDocumentCategories(message) {
  const lower = String(message || "").toLowerCase();
  return DOCUMENT_CATEGORY_ALIASES
    .filter(([, aliases]) => aliases.some((alias) => lower.includes(alias)))
    .map(([category]) => category);
}

function documentSearchTokens(message) {
  return [...new Set(String(message || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) || [])]
    .filter((token) => !DOCUMENT_STOPWORDS.has(token))
    .slice(0, 8);
}

function documentMatchesQuery(doc, categories, tokens) {
  if (categories.includes(doc.category)) return true;
  const haystack = [
    doc.title,
    doc.filename,
    doc.category,
    doc.notes,
    ...(Array.isArray(doc.tags) ? doc.tags : []),
  ].join(" ").toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

async function maybeFetchWeather(fields) {
  const c = centroid(fields);
  if (!c) return null;
  const params = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lng),
    current: "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
    forecast_days: "5",
    timezone: "auto",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function retrieveDocumentContext(admin, farmId, message) {
  const categories = inferDocumentCategories(message);
  const tokens = documentSearchTokens(message);
  const categoryDocsPromise = categories.length
    ? admin
        .from("farm_documents")
        .select("id,title,category,filename,expiry_date,tags,notes,status,updated_at")
        .eq("farm_id", farmId)
        .is("deleted_at", null)
        .in("category", categories)
        .order("updated_at", { ascending: false })
        .limit(20)
    : Promise.resolve({ data: [] });
  const recentDocsPromise = admin
    .from("farm_documents")
    .select("id,title,category,filename,expiry_date,tags,notes,status,updated_at")
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(40);

  let semanticChunks = [];
  let semanticSources = [];
  let semanticError = null;
  try {
    const embedding = await embedText(message);
    const { data, error } = await admin.rpc("document_vault_match_chunks", {
      p_farm_id: farmId,
      p_query_embedding: embedding.embedding,
      p_embedding_model: embedding.model,
      p_match_count: 8,
    });
    if (error) {
      semanticError = error.message;
    } else {
      semanticChunks = data || [];
    }
    semanticSources = semanticChunks.map((m) => ({
      type: "document",
      id: m.document_id,
      document_id: m.document_id,
      chunk_id: m.chunk_id,
      label: "Document source",
      excerpt: String(m.chunk_text || "").slice(0, 260),
      page_number: m.page_number,
      similarity: m.similarity,
    }));
  } catch (err) {
    semanticError = err?.message || "document retrieval failed";
  }

  const [{ data: categoryDocs }, { data: recentDocs, error: recentError }] = await Promise.all([
    categoryDocsPromise,
    recentDocsPromise,
  ]);
  const matchedDocs = [
    ...(categoryDocs || []),
    ...(recentDocs || []).filter((doc) => documentMatchesQuery(doc, categories, tokens)),
  ];
  const docsById = new Map();
  for (const doc of matchedDocs) docsById.set(doc.id, doc);

  let metadataChunks = [];
  if (docsById.size) {
    const { data: chunks } = await admin
      .from("document_chunks")
      .select("id,document_id,chunk_text,page_number,section_heading,chunk_index")
      .eq("farm_id", farmId)
      .in("document_id", [...docsById.keys()])
      .order("chunk_index", { ascending: true })
      .limit(Math.max(8, docsById.size * 2));
    metadataChunks = (chunks || []).map((chunk) => ({
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      chunk_text: chunk.chunk_text,
      page_number: chunk.page_number,
      section_heading: chunk.section_heading,
      similarity: null,
      metadata: { retrieval: "metadata-category" },
    }));
  }

  const chunkIds = new Set();
  const chunks = [...semanticChunks, ...metadataChunks].filter((chunk) => {
    const key = chunk.chunk_id || `${chunk.document_id}:${chunk.chunk_text}`;
    if (chunkIds.has(key)) return false;
    chunkIds.add(key);
    return true;
  });
  const docSources = [...docsById.values()].map((doc) => ({
    type: "document",
    id: doc.id,
    document_id: doc.id,
    label: doc.title || doc.filename || "Document",
    category: doc.category,
    filename: doc.filename,
    status: doc.status,
    excerpt: [doc.category, doc.filename, doc.notes].filter(Boolean).join(" · ").slice(0, 260),
  }));
  const sourceKeys = new Set();
  const sources = [...docSources, ...semanticSources].filter((source) => {
    const key = `${source.document_id}:${source.chunk_id || "doc"}`;
    if (sourceKeys.has(key)) return false;
    sourceKeys.add(key);
    return true;
  });

  return {
    chunks,
    sources,
    matchedDocuments: [...docsById.values()],
    error: semanticError || recentError?.message || null,
  };
}

async function collectPlatformContext(admin, farmId, message, scope = "whole_farm") {
  const [{ data: farm }, { data: fields }, { data: appData }, { data: documents }] = await Promise.all([
    admin.from("farms").select("id,name,address_line1,address_line2,city,region,postcode,country").eq("id", farmId).maybeSingle(),
    admin.from("tilth_fields").select("id,name,boundary,created_at,updated_at").eq("farm_id", farmId).order("created_at", { ascending: true }),
    admin.from("farm_app_data").select("namespace,data,updated_at").eq("farm_id", farmId).in("namespace", APP_NAMESPACES),
    admin
      .from("farm_documents")
      .select("id,title,category,filename,expiry_date,tags,status,updated_at")
      .eq("farm_id", farmId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);
  const fieldRows = fields || [];
  const fieldIds = fieldRows.map((f) => f.id);
  const [ndviResult, sarResult, elevationResult, layersResult, docContext, weather] = await Promise.all([
    fieldIds.length
      ? admin.from("tilth_field_ndvi").select("*").in("field_id", fieldIds).order("scene_datetime", { ascending: false }).limit(80)
      : { data: [] },
    fieldIds.length
      ? admin.from("tilth_field_sar").select("*").in("field_id", fieldIds).order("scene_datetime", { ascending: false }).limit(80)
      : { data: [] },
    fieldIds.length
      ? admin.from("tilth_field_elevation").select("*").in("field_id", fieldIds)
      : { data: [] },
    fieldIds.length
      ? admin.from("tilth_field_layer_data").select("field_id,layer_id,strategy,status,features,updated_at").in("field_id", fieldIds).order("updated_at", { ascending: false }).limit(80)
      : { data: [] },
    retrieveDocumentContext(admin, farmId, message),
    maybeFetchWeather(fieldRows),
  ]);

  const fieldMap = new Map(fieldRows.map((field) => [field.id, field]));
  const appMap = new Map((appData || []).map((row) => [row.namespace, row.data]));
  const fieldsSummary = fieldRows.map((field) => ({
    id: field.id,
    name: field.name,
    areaHa: areaHa(field.boundary),
    attrs: appMap.get("fieldAttrs")?.[field.id] || null,
    currentPlanting: appMap.get("plantings")?.[field.id]?.[0] || null,
  }));
  const latestByField = (rows, dateKey) => {
    const map = new Map();
    for (const row of rows || []) {
      if (!map.has(row.field_id)) map.set(row.field_id, row);
    }
    return [...map.values()].map((row) => ({
      ...row,
      fieldName: fieldMap.get(row.field_id)?.name || row.field_id,
      sceneDate: row[dateKey],
    }));
  };
  const layerSummary = (layersResult.data || []).map((row) => ({
    fieldId: row.field_id,
    fieldName: fieldMap.get(row.field_id)?.name || row.field_id,
    layerId: row.layer_id,
    strategy: row.strategy,
    status: row.status,
    featureCount: row.features?.features?.length || 0,
    sampleProperties: row.features?.features?.[0]?.properties || null,
  }));
  const namespaceSummaries = Object.fromEntries(
    APP_NAMESPACES.map((ns) => [ns, summarizeNamespace(ns, appMap.get(ns))])
  );
  const sources = [
    ...fieldsSummary.slice(0, 12).map((field) => ({ type: "field", id: field.id, label: field.name })),
    ...(docContext.sources || []),
    ...latestByField(ndviResult.data, "scene_datetime").slice(0, 10).map((row) => ({
      type: "satellite_ndvi",
      id: row.id,
      fieldId: row.field_id,
      label: `${row.fieldName} NDVI ${String(row.scene_datetime || "").slice(0, 10)}`,
    })),
    ...layerSummary.slice(0, 10).map((row) => ({
      type: "wms_layer",
      id: `${row.fieldId}:${row.layerId}`,
      fieldId: row.fieldId,
      layerId: row.layerId,
      label: `${row.fieldName} ${row.layerId}`,
    })),
  ];
  return {
    scope,
    farm,
    fields: fieldsSummary,
    namespaces: namespaceSummaries,
    remoteSensing: {
      latestNdviByField: latestByField(ndviResult.data, "scene_datetime").slice(0, 20),
      latestSarByField: latestByField(sarResult.data, "scene_datetime").slice(0, 20),
      elevationByField: (elevationResult.data || []).map((row) => ({
        ...row,
        fieldName: fieldMap.get(row.field_id)?.name || row.field_id,
      })),
      wmsLayers: layerSummary,
    },
    documents: {
      recent: documents || [],
      matched: docContext.matchedDocuments || [],
      matchingChunks: (docContext.chunks || []).map((chunk) => ({
        document_id: chunk.document_id,
        chunk_id: chunk.chunk_id,
        similarity: chunk.similarity,
        text: String(chunk.chunk_text || "").slice(0, 900),
      })),
      error: docContext.error || null,
    },
    weather,
    sources,
  };
}

function parseAssistantJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function validateSuggestedActions(actions, farmId, userId, originId = null) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action) => ACTION_TYPES.has(action?.action_type))
    .slice(0, 6)
    .map((action) => ({
      farm_id: farmId,
      user_id: userId,
      origin: "platform_assistant",
      origin_id: originId,
      action_type: action.action_type,
      title: String(action.title || "Suggested action").slice(0, 160),
      summary: String(action.summary || "").slice(0, 600),
      confidence: Number.isFinite(Number(action.confidence)) ? Number(action.confidence) : 0.6,
      payload: action.payload && typeof action.payload === "object" ? action.payload : {},
      metadata: action.metadata && typeof action.metadata === "object" ? action.metadata : {},
    }));
}

async function createAssistantResponse({ farmId, userId, message, scope = "whole_farm", mode = "chat", reportType = null }) {
  const admin = adminClient();
  const context = await collectPlatformContext(admin, farmId, message, scope);
  const contextText = truncate(context, MAX_CONTEXT_CHARS);
  const system = [
    "You are Tilth's platform-wide farm assistant.",
    "Answer using only the provided farm context, document evidence, satellite/WMS data, weather, records, and workspace data.",
    "When the user asks about invoices, receipts, certificates, reports, or other files, use the documents.recent, documents.matched, and documents.matchingChunks context before concluding that nothing exists.",
    "If matching document metadata exists but extracted chunks are empty, still list the document titles/categories/status and explain that text extraction may not be complete.",
    "If the user asks for a report, write a useful structured report with sections and practical next steps.",
    "If the user asks to create or update platform data, do not say it has been done. Instead return suggested_actions that the UI can show for confirmation.",
    `Allowed suggested action_type values: ${[...ACTION_TYPES].join(", ")}.`,
    "Return strict JSON with keys: answer, suggested_actions, source_ids. source_ids should refer to relevant source id values from the context.",
  ].join(" ");
  const llm = await chatCompletion([
    { role: "system", content: system },
    { role: "system", content: `Farm platform context:\n${contextText}` },
    { role: "user", content: `${mode === "report" ? `Report type: ${reportType || "farm_operations"}\n` : ""}${message}` },
  ], { jsonMode: true, temperature: mode === "report" ? 0.25 : 0.15 });
  const parsed = parseAssistantJson(llm);
  const answer = parsed?.answer || llm || fallbackAnswer(context, message, mode);
  const selectedIds = new Set(Array.isArray(parsed?.source_ids) ? parsed.source_ids.map(String) : []);
  const sources = selectedIds.size
    ? context.sources.filter((source) => selectedIds.has(String(source.id)) || selectedIds.has(String(source.document_id)))
    : context.sources.slice(0, 14);
  const suggestedActions = validateSuggestedActions(parsed?.suggested_actions, farmId, userId);
  return { answer, suggestedActions, sources, context };
}

function fallbackAnswer(context, message, mode) {
  const fields = context.fields?.length || 0;
  const records = context.namespaces?.records?.count || 0;
  const finances = context.namespaces?.finances?.count || 0;
  const inventory = context.namespaces?.inventory?.count || 0;
  if (mode === "report") {
    return [
      "Farm operations summary",
      "",
      `Fields tracked: ${fields}. Records: ${records}. Finance entries: ${finances}. Inventory items: ${inventory}.`,
      `Latest NDVI scenes available for ${context.remoteSensing?.latestNdviByField?.length || 0} fields.`,
      "OpenAI is not configured, so this is a deterministic summary rather than a full narrative report.",
    ].join("\n");
  }
  return `I can see ${fields} fields, ${records} operational records, ${finances} finance entries and ${inventory} inventory items. OpenAI is not configured, so I cannot fully answer "${message}" beyond the available platform counts.`;
}

async function ensureSession(admin, farmId, userId, title, sessionId, scope) {
  if (sessionId) {
    const existing = await admin
      .from("assistant_chat_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("farm_id", farmId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!existing.error && existing.data) return sessionId;
  }
  const created = await admin
    .from("assistant_chat_sessions")
    .insert({ farm_id: farmId, user_id: userId, title: title.slice(0, 80), scope })
    .select("id")
    .single();
  if (created.error) throw new Error(created.error.message);
  return created.data.id;
}

async function chat(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const message = String(body.message || "").trim();
  const scope = String(body.scope || "whole_farm");
  if (!message) return json(res, 400, { error: "message is required" });
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const canEdit = await userCanEditFarm(auth.userId, farmId);
  const admin = adminClient();
  const sessionId = await ensureSession(admin, farmId, auth.userId, message, body.chatSessionId || null, scope);
  const result = await createAssistantResponse({ farmId, userId: auth.userId, message, scope });
  let persistedActions = [];
  if (canEdit && result.suggestedActions.length) {
    const inserted = await admin.from("assistant_suggested_actions").insert(result.suggestedActions).select("*");
    if (inserted.error) throw new Error(inserted.error.message);
    persistedActions = inserted.data || [];
  }
  const rows = [
    {
      farm_id: farmId,
      chat_session_id: sessionId,
      user_id: auth.userId,
      role: "user",
      content: message,
      sources: [],
      suggested_actions: [],
      metadata: { scope },
    },
    {
      farm_id: farmId,
      chat_session_id: sessionId,
      user_id: auth.userId,
      role: "assistant",
      content: result.answer,
      sources: result.sources,
      suggested_actions: persistedActions,
      metadata: { scope, canEdit },
    },
  ];
  const saved = await admin.from("assistant_chat_messages").insert(rows);
  if (saved.error) throw new Error(saved.error.message);
  return json(res, 200, {
    chatSessionId: sessionId,
    answer: result.answer,
    sources: result.sources,
    suggestedActions: persistedActions,
    canEdit,
  });
}

async function generateReport(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const reportType = String(body.reportType || "farm_operations");
  const prompt = String(body.prompt || body.reportPrompt || reportType).trim();
  const scope = String(body.scope || "whole_farm");
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const canEdit = await userCanEditFarm(auth.userId, farmId);
  const admin = adminClient();
  const result = await createAssistantResponse({
    farmId,
    userId: auth.userId,
    message: prompt,
    scope,
    mode: "report",
    reportType,
  });
  let persistedActions = [];
  if (canEdit && result.suggestedActions.length) {
    const inserted = await admin.from("assistant_suggested_actions").insert(result.suggestedActions).select("*");
    if (inserted.error) throw new Error(inserted.error.message);
    persistedActions = inserted.data || [];
  }
  const saved = await admin
    .from("assistant_generated_reports")
    .insert({
      farm_id: farmId,
      user_id: auth.userId,
      report_type: reportType,
      title: body.title || reportType.replace(/_/g, " "),
      prompt,
      content: result.answer,
      sources: result.sources,
      suggested_actions: persistedActions,
      metadata: { scope },
    })
    .select("*")
    .single();
  if (saved.error) throw new Error(saved.error.message);
  return json(res, 200, { report: saved.data, answer: result.answer, sources: result.sources, suggestedActions: persistedActions });
}

async function contextStatus(req, res, json, url) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const farmId = String(url.searchParams.get("farmId") || "");
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const admin = adminClient();
  const [{ count: fields }, { data: namespaces }, { count: documents }, { count: actions }] = await Promise.all([
    admin.from("tilth_fields").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
    admin.from("farm_app_data").select("namespace,updated_at").eq("farm_id", farmId),
    admin.from("farm_documents").select("id", { count: "exact", head: true }).eq("farm_id", farmId).is("deleted_at", null),
    admin.from("assistant_suggested_actions").select("id", { count: "exact", head: true }).eq("farm_id", farmId).eq("status", "pending"),
  ]);
  return json(res, 200, {
    fields: fields || 0,
    documents: documents || 0,
    pendingSuggestedActions: actions || 0,
    namespaces: namespaces || [],
    openai: Boolean(OPENAI_API_KEY),
  });
}

export async function handlePlatformAssistantRoute(req, res, url, json) {
  const { pathname } = url;
  try {
    if (req.method === "POST" && pathname === "/api/platform-assistant/chat") {
      await chat(req, res, json);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/platform-assistant/reports/generate") {
      await generateReport(req, res, json);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/platform-assistant/context/status") {
      await contextStatus(req, res, json, url);
      return true;
    }
  } catch (err) {
    json(res, 500, { error: err?.message || "platform assistant request failed" });
    return true;
  }
  return false;
}

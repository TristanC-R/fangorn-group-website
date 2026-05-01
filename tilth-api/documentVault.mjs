import { createHash, randomUUID } from "node:crypto";

import {
  adminClient,
  isConfigured as supabaseConfigured,
  userIdFromJwt,
} from "./supabaseAdmin.mjs";

const DOCUMENT_BUCKET = "farm-documents";
const DEFAULT_EMBEDDING_MODEL = process.env.DOCUMENT_VAULT_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_CHAT_MODEL = process.env.DOCUMENT_VAULT_CHAT_MODEL || "gpt-4o-mini";
const MAX_JSON_UPLOAD_BYTES = Number(process.env.DOCUMENT_VAULT_MAX_JSON_UPLOAD_BYTES || 25 * 1024 * 1024);

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
  if (!jwt) {
    return { error: { status: 401, body: { error: "missing Authorization: Bearer <jwt>" } } };
  }
  const userId = await userIdFromJwt(jwt);
  if (!userId) {
    return { error: { status: 401, body: { error: "invalid or expired jwt" } } };
  }
  return { userId };
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

function safeFilename(name) {
  const base = String(name || "document").trim() || "document";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fallbackEmbedding(text, dimensions = 1536) {
  const seed = createHash("sha256").update(String(text || "")).digest();
  const values = [];
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const n = seed[i % seed.length] / 255;
    const signed = n * 2 - 1;
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
      dimensions: 1536,
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
    body: JSON.stringify({
      model: DEFAULT_EMBEDDING_MODEL,
      input: text,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || "embedding request failed");
  }
  const embedding = body?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("embedding response missing vector");
  return {
    model: DEFAULT_EMBEDDING_MODEL,
    dimensions: embedding.length,
    embedding,
    provider: "openai",
  };
}

async function chatCompletion(messages) {
  if (!OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      temperature: 0.2,
      messages,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || "chat completion failed");
  }
  return body?.choices?.[0]?.message?.content || null;
}

async function audit({ farmId, documentId = null, userId = null, action, metadata = {}, req = null }) {
  const admin = adminClient();
  if (!admin || !farmId || !action) return;
  try {
    await admin.from("document_audit_events").insert({
      farm_id: farmId,
      document_id: documentId,
      user_id: userId,
      action,
      ip_address: req?.socket?.remoteAddress || null,
      user_agent: req?.headers?.["user-agent"] || null,
      metadata,
    });
  } catch {
    // Audit logging should never break the user-facing document flow.
  }
}

function docSelect() {
  return "id,created_at,updated_at,farm_id,field_id,uploaded_by,title,category,bucket,storage_path,filename,content_type,size_bytes,expiry_date,tags,notes,status,error_message,deleted_at,metadata";
}

async function uploadDocument(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req, MAX_JSON_UPLOAD_BYTES);
  const farmId = String(body.farmId || "");
  if (!(await userCanEditFarm(auth.userId, farmId))) {
    await audit({ farmId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "upload" }, req });
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const filename = safeFilename(body.filename || body.title || "document");
  const title = String(body.title || filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).trim();
  if (!filename || !body.fileBase64) {
    return json(res, 400, { error: "filename and fileBase64 are required" });
  }
  const admin = adminClient();
  const documentId = randomUUID();
  const buffer = Buffer.from(String(body.fileBase64), "base64");
  const storagePath = `${farmId}/documents/${documentId}/original/${filename}`;
  const contentHash = sha256Buffer(buffer);
  const contentType = String(body.mimeType || body.contentType || "application/octet-stream");
  const upload = await admin.storage.from(DOCUMENT_BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: false,
  });
  if (upload.error) return json(res, 500, { error: upload.error.message });
  const { data, error } = await admin
    .from("farm_documents")
    .insert({
      id: documentId,
      farm_id: farmId,
      field_id: body.fieldId || null,
      uploaded_by: auth.userId,
      title,
      category: body.category || body.documentType || "general",
      bucket: DOCUMENT_BUCKET,
      storage_path: storagePath,
      filename,
      content_type: contentType,
      size_bytes: buffer.length,
      expiry_date: body.expiryDate || null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      notes: body.notes || null,
      status: "queued",
      content_hash: contentHash,
      metadata: {
        source: "document-vault-api",
        auto_populate: true,
        title_is_placeholder: !body.title,
      },
    })
    .select(docSelect())
    .single();
  if (error) return json(res, 500, { error: error.message });
  const job = await admin.from("document_processing_jobs").insert({
    farm_id: farmId,
    document_id: documentId,
    status: "queued",
    metadata: { source: "document-vault-api" },
  }).select("*").single();
  if (job.error) return json(res, 500, { error: job.error.message });
  await audit({ farmId, documentId, userId: auth.userId, action: "upload", metadata: { sizeBytes: buffer.length }, req });
  return json(res, 201, { document: data, job: job.data });
}

async function listDocuments(req, res, json, url) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const farmId = String(url.searchParams.get("farmId") || "");
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    await audit({ farmId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "list" }, req });
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const admin = adminClient();
  let query = admin
    .from("farm_documents")
    .select(docSelect())
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const status = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  if (status) query = query.eq("status", status);
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) return json(res, 500, { error: error.message });
  return json(res, 200, { documents: data || [] });
}

async function getDocument(req, res, json, documentId, url) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const admin = adminClient();
  const { data: doc, error } = await admin
    .from("farm_documents")
    .select(docSelect())
    .eq("id", documentId)
    .maybeSingle();
  if (error) return json(res, 500, { error: error.message });
  if (!doc || !(await userCanReadFarm(auth.userId, doc.farm_id))) {
    await audit({ farmId: doc?.farm_id, documentId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "get" }, req });
    return json(res, 404, { error: "document not found" });
  }
  let signedUrl = null;
  if (url.searchParams.get("signed") === "1") {
    const signed = await admin.storage.from(doc.bucket || DOCUMENT_BUCKET).createSignedUrl(doc.storage_path, 600);
    if (signed.error) return json(res, 500, { error: signed.error.message });
    signedUrl = signed.data?.signedUrl || null;
    await audit({ farmId: doc.farm_id, documentId, userId: auth.userId, action: "signed_url", req });
  }
  const { data: chunks } = await admin
    .from("document_chunks")
    .select("id,chunk_index,page_number,section_heading,chunk_text,source_metadata")
    .eq("farm_id", doc.farm_id)
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true })
    .limit(100);
  return json(res, 200, { document: doc, signedUrl, chunks: chunks || [] });
}

async function deleteDocument(req, res, json, documentId) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const admin = adminClient();
  const { data: doc } = await admin
    .from("farm_documents")
    .select("id,farm_id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc || !(await userCanEditFarm(auth.userId, doc.farm_id))) {
    await audit({ farmId: doc?.farm_id, documentId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "delete" }, req });
    return json(res, 404, { error: "document not found" });
  }
  const now = new Date().toISOString();
  const { error } = await admin
    .from("farm_documents")
    .update({ status: "deleted", deleted_at: now, deleted_by: auth.userId, updated_at: now })
    .eq("id", documentId);
  if (error) return json(res, 500, { error: error.message });
  await admin.from("document_processing_jobs").insert({
    farm_id: doc.farm_id,
    document_id: documentId,
    status: "queued",
    metadata: { cleanup: true, source: "document-vault-api" },
  });
  await audit({ farmId: doc.farm_id, documentId, userId: auth.userId, action: "delete", req });
  return json(res, 200, { ok: true });
}

async function searchDocuments(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const query = String(body.query || "").trim();
  if (!query) return json(res, 400, { error: "query is required" });
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    await audit({ farmId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "search" }, req });
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const admin = adminClient();
  const embedding = await embedText(query);
  const evidence = await retrieveDocumentEvidence(admin, farmId, query, {
    embedding,
    limit: Number(body.limit || 10),
  });
  const matches = evidence.matches || [];
  await Promise.all(matches.map((m) => audit({
    farmId,
    documentId: m.document_id,
    userId: auth.userId,
    action: "search_exposure",
    metadata: { chunkId: m.chunk_id, query },
    req,
  })));
  return json(res, 200, {
    query,
    embeddingModel: embedding.model,
    matches,
    semanticError: evidence.semanticError || null,
    graphExpanded: false,
  });
}

function sourcesFromMatches(matches) {
  return (matches || []).map((m) => ({
    chunk_id: m.chunk_id,
    table_id: m.table_id,
    figure_id: m.figure_id,
    document_id: m.document_id,
    evidence_type: m.evidence_type,
    page_number: m.page_number,
    section_heading: m.section_heading,
    excerpt: String(m.chunk_text || "").slice(0, 300),
    similarity: m.similarity,
  }));
}

function documentsFromSources(sources) {
  const seen = new Set();
  const docs = [];
  for (const source of sources || []) {
    if (!source?.document_id || seen.has(source.document_id)) continue;
    seen.add(source.document_id);
    docs.push({
      document_id: source.document_id,
      page_number: source.page_number,
      excerpt: source.excerpt,
    });
  }
  return docs;
}

function queryTokens(query) {
  return [...new Set(String(query || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) || [])]
    .filter((token) => !["the", "and", "for", "with", "from", "document", "documents"].includes(token))
    .slice(0, 8);
}

function textScore(text, tokens) {
  const lower = String(text || "").toLowerCase();
  if (!lower || !tokens.length) return 0;
  return tokens.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0);
}

function mergeEvidenceMatches(semanticMatches, evidenceMatches, limit) {
  const seen = new Set();
  const merged = [];
  for (const match of [...(semanticMatches || []), ...(evidenceMatches || [])]) {
    const key = match.chunk_id || match.table_id || match.figure_id || `${match.document_id}:${match.chunk_text}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(match);
  }
  return merged.slice(0, Math.max(1, Math.min(Number(limit || 10), 50)));
}

async function retrieveDocumentEvidence(admin, farmId, query, { embedding = null, limit = 10 } = {}) {
  let semanticMatches = [];
  let semanticError = null;
  if (embedding?.embedding) {
    const { data, error } = await admin.rpc("document_vault_match_chunks", {
      p_farm_id: farmId,
      p_query_embedding: embedding.embedding,
      p_embedding_model: embedding.model,
      p_match_count: Number(limit || 10),
    });
    if (error) semanticError = error.message;
    else semanticMatches = (data || []).map((match) => ({ ...match, evidence_type: "semantic_chunk" }));
  }

  const tokens = queryTokens(query);
  if (!tokens.length) return { matches: semanticMatches, semanticError };

  const [chunkResult, tableResult, figureResult] = await Promise.all([
    admin
      .from("document_chunks")
      .select("id,document_id,chunk_text,page_number,section_heading,table_reference,figure_reference,docling_metadata")
      .eq("farm_id", farmId)
      .order("updated_at", { ascending: false })
      .limit(250),
    admin
      .from("document_tables")
      .select("id,document_id,chunk_id,table_index,page_number,label,caption,markdown,plain_text")
      .eq("farm_id", farmId)
      .order("table_index", { ascending: true })
      .limit(120),
    admin
      .from("document_figures")
      .select("id,document_id,chunk_id,figure_index,page_number,label,caption,alt_text,figure_type")
      .eq("farm_id", farmId)
      .order("figure_index", { ascending: true })
      .limit(120),
  ]);

  const keywordMatches = (chunkResult.data || [])
    .map((chunk) => ({ chunk, score: textScore(chunk.chunk_text, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(limit || 10))
    .map(({ chunk, score }) => ({
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      chunk_text: chunk.chunk_text,
      page_number: chunk.page_number,
      section_heading: chunk.section_heading,
      similarity: null,
      metadata: {
        retrieval: "keyword",
        score,
        table_reference: chunk.table_reference,
        figure_reference: chunk.figure_reference,
        docling: chunk.docling_metadata,
      },
      evidence_type: "keyword_chunk",
    }));

  const tableMatches = (tableResult.data || [])
    .map((table) => ({ table, score: textScore([table.label, table.caption, table.plain_text, table.markdown].filter(Boolean).join("\n"), tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ table, score }) => ({
      table_id: table.id,
      chunk_id: table.chunk_id,
      document_id: table.document_id,
      chunk_text: [table.label, table.caption, table.markdown || table.plain_text].filter(Boolean).join("\n\n"),
      page_number: table.page_number,
      section_heading: table.label || `Table ${table.table_index + 1}`,
      similarity: null,
      metadata: { retrieval: "table", score, table_index: table.table_index },
      evidence_type: "table",
    }));

  const figureMatches = (figureResult.data || [])
    .map((figure) => ({ figure, score: textScore([figure.label, figure.caption, figure.alt_text, figure.figure_type].filter(Boolean).join("\n"), tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ figure, score }) => ({
      figure_id: figure.id,
      chunk_id: figure.chunk_id,
      document_id: figure.document_id,
      chunk_text: [figure.label, figure.caption, figure.alt_text].filter(Boolean).join("\n\n"),
      page_number: figure.page_number,
      section_heading: figure.label || `Figure ${figure.figure_index + 1}`,
      similarity: null,
      metadata: { retrieval: "figure", score, figure_type: figure.figure_type },
      evidence_type: "figure",
    }));

  return {
    matches: mergeEvidenceMatches(semanticMatches, [...keywordMatches, ...tableMatches, ...figureMatches], limit),
    semanticError,
  };
}

async function chatWithDocuments(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const message = String(body.message || "").trim();
  if (!message) return json(res, 400, { error: "message is required" });
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    await audit({ farmId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "chat" }, req });
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const admin = adminClient();
  let sessionId = body.chatSessionId || null;
  if (sessionId) {
    const existing = await admin
      .from("document_chat_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("farm_id", farmId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (existing.error) return json(res, 500, { error: existing.error.message });
    if (!existing.data) sessionId = null;
  }
  if (!sessionId) {
    const created = await admin.from("document_chat_sessions").insert({
      farm_id: farmId,
      user_id: auth.userId,
      title: message.slice(0, 80),
    }).select("id").single();
    if (created.error) return json(res, 500, { error: created.error.message });
    sessionId = created.data.id;
  }
  const historyResult = await admin
    .from("document_chat_messages")
    .select("role,content")
    .eq("farm_id", farmId)
    .eq("chat_session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(8);
  if (historyResult.error) return json(res, 500, { error: historyResult.error.message });
  const history = (historyResult.data || [])
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  const embedding = await embedText(message);
  const evidence = await retrieveDocumentEvidence(admin, farmId, message, {
    embedding,
    limit: 8,
  });
  const matches = evidence.matches || [];
  const context = matches
    .map((m, i) => `[${i + 1}] ${m.evidence_type || "document"}${m.page_number ? ` page ${m.page_number}` : ""}\n${m.chunk_text}`)
    .join("\n\n");
  const llmAnswer = await chatCompletion([
    {
      role: "system",
      content:
        "You are a Document Vault assistant. Do the user's requested task directly using the retrieved document context and conversation history. Do not describe, classify, or restate the user's intent. If they ask for a summary, provide the summary. If they ask to find documents, list the matching documents. If they ask for a draft, write the draft. Answer only from the Document Vault context; if the needed information is missing, say [Information not found in Document Vault]. Include concise source references like [1] when using retrieved context.",
    },
    {
      role: "system",
      content: `Retrieved Document Vault context:\n${context || "(no matching context)"}`,
    },
    ...history,
    { role: "user", content: message },
  ]);
  const answer = llmAnswer || (
    matches.length
      ? `I found ${matches.length} relevant source chunk(s). ${matches[0].chunk_text.slice(0, 700)}`
      : "[Information not found in Document Vault]"
  );
  const sources = sourcesFromMatches(matches);
  const sourceDocuments = documentsFromSources(sources);
  const messageRows = [
    {
      farm_id: farmId,
      chat_session_id: sessionId,
      user_id: auth.userId,
      role: "user",
      content: message,
      source_chunks: [],
      source_documents: [],
    },
    {
      farm_id: farmId,
      chat_session_id: sessionId,
      user_id: auth.userId,
      role: "assistant",
      content: answer,
      source_chunks: sources,
      source_documents: sourceDocuments,
    },
  ];
  const inserted = await admin.from("document_chat_messages").insert(messageRows);
  if (inserted.error) return json(res, 500, { error: inserted.error.message });
  await Promise.all(sources.map((s) => audit({
    farmId,
    documentId: s.document_id,
    userId: auth.userId,
    action: "chat_citation",
    metadata: { chunkId: s.chunk_id, sessionId },
    req,
  })));
  return json(res, 200, { chatSessionId: sessionId, answer, sources, sourceDocuments });
}

async function generateReport(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const prompt = String(body.reportPrompt || body.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "reportPrompt is required" });
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    await audit({ farmId, userId: auth.userId, action: "failed_access", metadata: { endpoint: "report" }, req });
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const admin = adminClient();
  const embedding = await embedText(prompt);
  const evidence = await retrieveDocumentEvidence(admin, farmId, prompt, {
    embedding,
    limit: 12,
  });
  const matches = evidence.matches || [];
  const context = matches
    .map((m, i) => `[${i + 1}] ${m.evidence_type || "document"}${m.page_number ? ` page ${m.page_number}` : ""}\n${m.chunk_text}`)
    .join("\n\n");
  const content = await chatCompletion([
    {
      role: "system",
      content:
        "Draft a structured report using only the supplied Document Vault evidence. Mark missing facts as [Information not found in Document Vault]. Include source markers.",
    },
    { role: "user", content: `Evidence:\n${context || "(no matching evidence)"}\n\nReport request: ${prompt}` },
  ]) || (matches.length ? `Draft report\n\n${matches.map((m, i) => `[${i + 1}] ${m.chunk_text}`).join("\n\n")}` : "[Information not found in Document Vault]");
  const sources = sourcesFromMatches(matches);
  const sourceDocuments = documentsFromSources(sources);
  const saved = await admin.from("document_generated_reports").insert({
    farm_id: farmId,
    user_id: auth.userId,
    title: body.title || prompt.slice(0, 80),
    prompt,
    content,
    source_chunks: sources,
    source_documents: sourceDocuments,
  }).select("*").single();
  if (saved.error) return json(res, 500, { error: saved.error.message });
  await Promise.all(sources.map((s) => audit({
    farmId,
    documentId: s.document_id,
    userId: auth.userId,
    action: "report_usage",
    metadata: { chunkId: s.chunk_id, reportId: saved.data.id },
    req,
  })));
  return json(res, 200, { report: saved.data, sources });
}

export async function handleDocumentVaultRoute(req, res, url, json) {
  const { pathname } = url;
  try {
    if (req.method === "POST" && pathname === "/api/document-vault/documents") {
      await uploadDocument(req, res, json);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/document-vault/documents") {
      await listDocuments(req, res, json, url);
      return true;
    }
    const documentMatch = /^\/api\/document-vault\/documents\/([^/]+)$/.exec(pathname);
    if (documentMatch && req.method === "GET") {
      await getDocument(req, res, json, documentMatch[1], url);
      return true;
    }
    if (documentMatch && req.method === "DELETE") {
      await deleteDocument(req, res, json, documentMatch[1]);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/document-vault/search") {
      await searchDocuments(req, res, json);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/document-vault/chat") {
      await chatWithDocuments(req, res, json);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/document-vault/reports/generate") {
      await generateReport(req, res, json);
      return true;
    }
  } catch (err) {
    json(res, 500, { error: err?.message || "document vault request failed" });
    return true;
  }
  return false;
}

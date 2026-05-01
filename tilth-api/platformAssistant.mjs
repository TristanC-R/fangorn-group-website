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
const SATELLITE_CONTEXT_LIMIT = Number(process.env.PLATFORM_ASSISTANT_SATELLITE_CONTEXT_LIMIT || 240);
const ASSISTANT_HISTORY_LIMIT = Number(process.env.PLATFORM_ASSISTANT_HISTORY_LIMIT || 10);
const ASSISTANT_MAX_TOOL_ROUNDS = Number(process.env.PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS || 6);
const ASSISTANT_TOOL_RESULT_CHARS = Number(process.env.PLATFORM_ASSISTANT_TOOL_RESULT_CHARS || 12_000);
const OPENAI_CHAT_TIMEOUT_MS = Number(process.env.PLATFORM_ASSISTANT_OPENAI_TIMEOUT_MS || 60_000);
const OPENAI_CHAT_RETRIES = Number(process.env.PLATFORM_ASSISTANT_OPENAI_RETRIES || 1);

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
  "field_observation",
  "spray_record",
  "contact",
  "compliance_checklist",
  "market_watchlist",
  "livestock_medicine",
  "livestock_movement",
]);

const ACTION_EXAMPLE_CATALOG = {
  calendar_reminder: {
    action_type: "calendar_reminder",
    title: "Pay Fangorn invoice",
    summary: "Create a reminder for the invoice payment deadline.",
    confidence: 0.86,
    payload: {
      title: "Pay Fangorn invoice",
      dueDate: "2026-01-17",
      reminderDays: 3,
      category: "finance",
      priority: "high",
      notes: "Invoice Fangorn Invoice-0000022 is due on 2026-01-17.",
      sourceKey: "document:invoice-0000022:payment_due",
    },
  },
  finance_transaction: {
    action_type: "finance_transaction",
    title: "Add Fangorn Invoice-0000022 to finances",
    summary: "Add the invoice as an expense with the extracted amount and invoice details.",
    confidence: 0.9,
    payload: {
      type: "expense",
      date: "2025-12-18",
      amount: 2051.25,
      vatAmount: 410.25,
      category: "consulting",
      description: "Data collection and consulting services",
      counterparty: "Fangorn Group Limited",
      invoiceRef: "Fangorn Invoice-0000022",
      fieldId: "",
      notes: "Created from Document Vault invoice evidence. Payment due 2026-01-17.",
      sourceKey: "document:invoice-0000022:finance",
    },
  },
  inventory_item: {
    action_type: "inventory_item",
    title: "Add glyphosate delivery to inventory",
    summary: "Create an inventory item from the delivery note.",
    confidence: 0.82,
    payload: {
      name: "Glyphosate 360",
      category: "chemical",
      unit: "L",
      quantity: 120,
      unitCost: 4.75,
      batchNumber: "BATCH-24-011",
      supplier: "Agri Supplies Ltd",
      purchaseDate: "2026-03-12",
      expiryDate: "2028-03-12",
      storageLocation: "Chemical store",
      mappNumber: "12345",
      lowStockThreshold: 20,
      notes: "Stock details extracted from delivery note.",
      sourceKey: "document:delivery-011:inventory_item",
    },
  },
  inventory_adjustment: {
    action_type: "inventory_adjustment",
    title: "Adjust glyphosate stock",
    summary: "Record stock used from inventory.",
    confidence: 0.78,
    payload: {
      itemId: "glyphosate-360",
      itemName: "Glyphosate 360",
      delta: -20,
      sourceKey: "assistant:inventory:glyphosate-360:adjustment",
    },
  },
  field_observation: {
    action_type: "field_observation",
    title: "Black grass spotted in America Field",
    summary: "Create a scouting observation for black grass.",
    confidence: 0.88,
    payload: {
      fieldId: "",
      fieldName: "America Field",
      type: "weed",
      notes: "Black grass seen in the south east corner of America Field.",
      datetime: "2026-04-27T09:30:00.000Z",
      locationHint: "South east corner",
      recommendedAction: "Inspect before deciding whether any treatment is needed.",
      sourceKey: "assistant:observation:america-field:black-grass",
    },
  },
  spray_record: {
    action_type: "spray_record",
    title: "Record Atlantis application on America Field",
    summary: "Create a spray record for an application that has already happened.",
    confidence: 0.84,
    payload: {
      productName: "Atlantis OD",
      productId: "",
      fieldId: "",
      fieldName: "America Field",
      rate: 1.2,
      category: "Herbicide",
      unit: "L/ha",
      date: "2026-04-20",
      startTime: "08:30",
      endTime: "10:15",
      windDirection: "SW",
      operator: "Sam",
      area: 12.4,
      notes: "Application already completed and recorded from user request.",
      sourceKey: "assistant:spray:america-field:2026-04-20",
    },
  },
  contact: {
    action_type: "contact",
    title: "Add Sam Carter as a contact",
    summary: "Create a supplier contact from the document or user request.",
    confidence: 0.8,
    payload: {
      name: "Sam Carter",
      company: "Agri Supplies Ltd",
      role: "supplier",
      phone: "07123 456789",
      email: "sam@example.com",
      address: "1 Market Road, Hereford",
      notes: "Main contact for chemical and seed orders.",
      sourceKey: "assistant:contact:sam-carter",
    },
  },
  compliance_checklist: {
    action_type: "compliance_checklist",
    title: "Create Red Tractor evidence checklist",
    summary: "Create a compliance checklist for upcoming audit evidence.",
    confidence: 0.82,
    payload: {
      checklist: "red_tractor",
      title: "Red Tractor evidence checklist",
      notes: "Collect spray records, operator certificates, field records and machinery calibration evidence.",
      sourceKey: "assistant:compliance:red-tractor-checklist",
    },
  },
  market_watchlist: {
    action_type: "market_watchlist",
    title: "Watch milling wheat price",
    summary: "Create a market watch item for a target price.",
    confidence: 0.76,
    payload: {
      marketId: "milling-wheat",
      commodity: "Milling wheat",
      target: "220 GBP/t",
      direction: "above",
      notes: "Notify when milling wheat rises above target.",
      sourceKey: "assistant:market:milling-wheat:220",
    },
  },
  livestock_medicine: {
    action_type: "livestock_medicine",
    title: "Record Closamectin treatment",
    summary: "Create a livestock medicine record.",
    confidence: 0.8,
    payload: {
      animalTag: "UK123456 00045",
      medicine: "Closamectin",
      dose: "10 ml",
      date: "2026-04-15",
      withdrawalEndDate: "2026-06-10",
      batchNumber: "CM-2409",
      notes: "Treatment recorded from medicine document or user request.",
      sourceKey: "assistant:livestock-medicine:uk123456-00045:2026-04-15",
    },
  },
  livestock_movement: {
    action_type: "livestock_movement",
    title: "Record cattle movement",
    summary: "Create a livestock movement record.",
    confidence: 0.8,
    payload: {
      animalTag: "UK123456 00045",
      movementType: "off_farm",
      date: "2026-04-22",
      fromLocation: "Home Farm",
      toLocation: "Market",
      reference: "MOV-0422",
      notes: "Movement recorded from document or user request.",
      sourceKey: "assistant:livestock-movement:mov-0422",
    },
  },
};

const KNOWN_SCOPES = new Set([
  "whole_farm",
  "fields_satellite",
  "documents",
  "operations",
  "finance",
  "compliance",
]);

const SCOPE_NAMESPACES = {
  documents: ["finances", "contacts", "audit_checklists", "official_data_settings"],
  finance: ["finances", "contacts", "inventory", "market_prices", "market_sales", "market_purchases", "market_watchlist"],
  fields_satellite: ["records", "assignments", "yield", "fieldAttrs", "plantings", "observations", "rotations", "official_data_settings"],
  operations: ["records", "custom_products", "assignments", "fieldAttrs", "plantings", "tasks", "inventory", "observations", "livestock", "livestock_movements", "livestock_medicines", "livestock_breeding", "rotations", "team_locations"],
  compliance: ["records", "custom_products", "assignments", "fieldAttrs", "plantings", "inventory", "contacts", "audit_checklists", "preharvest_safety", "official_data_settings"],
};

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

function today() {
  return new Date().toISOString().slice(0, 10);
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

async function chatCompletionMessage(messages, { jsonMode = false, temperature = 0.2, tools = null, toolChoice = undefined } = {}) {
  if (!OPENAI_API_KEY) return null;
  let response = null;
  let lastReason = "";
  for (let attempt = 0; attempt <= OPENAI_CHAT_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_CHAT_TIMEOUT_MS);
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_CHAT_MODEL,
          temperature,
          messages,
          ...(tools ? { tools } : {}),
          ...(tools && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch (err) {
      lastReason = err?.name === "AbortError"
        ? `timed out after ${Math.round(OPENAI_CHAT_TIMEOUT_MS / 1000)}s`
        : err?.message || "network error";
      if (attempt >= OPENAI_CHAT_RETRIES) {
        throw new Error(`OpenAI request failed: ${lastReason}`);
      }
      await wait(Math.min(1000 * (attempt + 1), 3000));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      return {
        message: body?.choices?.[0]?.message || null,
        usage: body?.usage || null,
        model: body?.model || OPENAI_CHAT_MODEL,
      };
    }

    const retryable = response.status === 429 || response.status >= 500;
    lastReason = body?.error?.message || `chat completion failed with HTTP ${response.status}`;
    if (!retryable || attempt >= OPENAI_CHAT_RETRIES) {
      throw new Error(lastReason);
    }
    await wait(Math.min(1000 * (attempt + 1), 3000));
  }
  throw new Error(`OpenAI request failed: ${lastReason || "unknown error"}`);
}

async function chatCompletion(messages, { jsonMode = false, temperature = 0.2 } = {}) {
  const result = await chatCompletionMessage(messages, { jsonMode, temperature });
  return result?.message?.content || null;
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

function documentTextScore(value, tokens) {
  const haystack = String(value || "").toLowerCase();
  if (!haystack || !tokens.length) return 0;
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function normaliseSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ltd|limited|plc|llp|group|company|co|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMatchesNeedle(haystack, needle) {
  const h = normaliseSearchText(haystack);
  const n = normaliseSearchText(needle);
  if (!n) return true;
  return h.includes(n) || n.includes(h);
}

function compactRow(row, keys) {
  return Object.fromEntries(keys.map((key) => [key, row?.[key]]).filter(([, value]) => value !== undefined));
}

function parseMaybeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceId(prefix, ...parts) {
  return [prefix, ...parts.filter(Boolean)].map((part) => String(part).replace(/\s+/g, "_")).join(":");
}

function extractMoneyValues(text) {
  const matches = String(text || "").matchAll(/(?:£|\bgbp\s*)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi);
  return [...matches].map((match) => Number(String(match[1]).replace(/,/g, ""))).filter(Number.isFinite);
}

function inferAssistantScope(message, mode = "chat", reportType = null) {
  const text = `${message || ""} ${reportType || ""}`.toLowerCase();
  if (mode === "report") {
    if (/finance|invoice|receipt|bill|payment|owe|owed|cost|sale|purchase/.test(text)) return "finance";
    if (/compliance|audit|certificate|red\s*tractor|organic|spray|nptc|scheme|sfi|defra|rpa/.test(text)) return "compliance";
    if (/satellite|sentinel|ndvi|sar|evi|ndmi|ndwi|moisture|vegetation|historic|history|trend/.test(text)) return "fields_satellite";
    return "whole_farm";
  }
  if (/document|documents|file|files|pdf|invoice|receipt|bill|statement|certificate|contract|letter|email|report|uploaded|vault/.test(text)) return "documents";
  if (/finance|payment|owe|owed|cost|spend|spent|sale|sold|purchase|bought|market|price|xero/.test(text)) return "finance";
  if (/satellite|sentinel|ndvi|sar|evi|ndmi|ndwi|moisture|vegetation|historic|history|trend|performing|performance|field|crop|wms|layer|map|imagery/.test(text)) return "fields_satellite";
  if (/compliance|audit|red\s*tractor|organic|spray test|nptc|scheme|sfi|defra|rpa|inspection/.test(text)) return "compliance";
  if (/task|operation|record|spray|planting|drill|harvest|stock|inventory|livestock|medicine|movement|rotation|weather/.test(text)) return "operations";
  return "whole_farm";
}

function normaliseScope(scope, message, mode = "chat", reportType = null) {
  if (KNOWN_SCOPES.has(scope) && scope !== "auto") return scope;
  return inferAssistantScope(message, mode, reportType);
}

function contextProfile(scope, message, mode = "chat") {
  const text = String(message || "").toLowerCase();
  const explicitDocumentIntent = /document|documents|file|files|pdf|invoice|receipt|bill|statement|certificate|contract|letter|email|report|uploaded|vault/.test(text);
  const explicitSatelliteIntent = /satellite|sentinel|ndvi|sar|evi|ndmi|ndwi|moisture|vegetation|historic|history|trend|performing|performance|field|crop|wms|layer|imagery/.test(text);
  if (mode === "report" || scope === "whole_farm") {
    return {
      namespaces: APP_NAMESPACES,
      includeDocuments: true,
      includeRemoteSensing: true,
      includeWeather: true,
      recentDocumentLimit: 30,
      documentMatchCount: 12,
    };
  }
  if (scope === "documents") {
    return {
      namespaces: SCOPE_NAMESPACES.documents,
      includeDocuments: true,
      includeRemoteSensing: explicitSatelliteIntent,
      includeWeather: false,
      recentDocumentLimit: 80,
      documentMatchCount: 16,
    };
  }
  if (scope === "finance") {
    return {
      namespaces: SCOPE_NAMESPACES.finance,
      includeDocuments: true,
      includeRemoteSensing: false,
      includeWeather: false,
      recentDocumentLimit: 50,
      documentMatchCount: 12,
    };
  }
  if (scope === "fields_satellite") {
    return {
      namespaces: SCOPE_NAMESPACES.fields_satellite,
      includeDocuments: explicitDocumentIntent,
      includeRemoteSensing: true,
      includeWeather: true,
      recentDocumentLimit: 30,
      documentMatchCount: 10,
    };
  }
  if (scope === "compliance") {
    return {
      namespaces: SCOPE_NAMESPACES.compliance,
      includeDocuments: true,
      includeRemoteSensing: explicitSatelliteIntent,
      includeWeather: false,
      recentDocumentLimit: 50,
      documentMatchCount: 12,
    };
  }
  return {
    namespaces: SCOPE_NAMESPACES.operations,
    includeDocuments: explicitDocumentIntent,
    includeRemoteSensing: explicitSatelliteIntent,
    includeWeather: true,
    recentDocumentLimit: 30,
    documentMatchCount: 8,
  };
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

async function retrieveDocumentContext(admin, farmId, message, { recentLimit = 40, matchCount = 8 } = {}) {
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
    .limit(recentLimit);

  let semanticChunks = [];
  let semanticSources = [];
  let semanticError = null;
  try {
    const embedding = await embedText(message);
    const { data, error } = await admin.rpc("document_vault_match_chunks", {
      p_farm_id: farmId,
      p_query_embedding: embedding.embedding,
      p_embedding_model: embedding.model,
      p_match_count: matchCount,
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
      evidence_type: "semantic_chunk",
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
      .select("id,document_id,chunk_text,page_number,section_heading,chunk_index,table_reference,figure_reference,docling_metadata")
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
      metadata: {
        retrieval: "metadata-category",
        table_reference: chunk.table_reference,
        figure_reference: chunk.figure_reference,
        docling: chunk.docling_metadata,
      },
      evidence_type: "metadata_chunk",
    }));
  }

  const [keywordChunkResult, tableResult, figureResult] = await Promise.all([
    tokens.length
      ? admin
          .from("document_chunks")
          .select("id,document_id,chunk_text,page_number,section_heading,table_reference,figure_reference,docling_metadata")
          .eq("farm_id", farmId)
          .order("updated_at", { ascending: false })
          .limit(250)
      : Promise.resolve({ data: [] }),
    tokens.length
      ? admin
          .from("document_tables")
          .select("id,document_id,chunk_id,table_index,page_number,label,caption,markdown,plain_text")
          .eq("farm_id", farmId)
          .order("table_index", { ascending: true })
          .limit(120)
      : Promise.resolve({ data: [] }),
    tokens.length
      ? admin
          .from("document_figures")
          .select("id,document_id,chunk_id,figure_index,page_number,label,caption,alt_text,figure_type")
          .eq("farm_id", farmId)
          .order("figure_index", { ascending: true })
          .limit(120)
      : Promise.resolve({ data: [] }),
  ]);

  const keywordChunks = (keywordChunkResult.data || [])
    .map((chunk) => ({ chunk, score: documentTextScore(chunk.chunk_text, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, matchCount)
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

  const tableChunks = (tableResult.data || [])
    .map((table) => ({ table, score: documentTextScore([table.label, table.caption, table.plain_text, table.markdown].filter(Boolean).join("\n"), tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ table, score }) => ({
      chunk_id: table.chunk_id,
      table_id: table.id,
      document_id: table.document_id,
      chunk_text: [table.label, table.caption, table.markdown || table.plain_text].filter(Boolean).join("\n\n"),
      page_number: table.page_number,
      section_heading: table.label || `Table ${table.table_index + 1}`,
      similarity: null,
      metadata: { retrieval: "table", score, table_index: table.table_index },
      evidence_type: "table",
    }));

  const figureChunks = (figureResult.data || [])
    .map((figure) => ({ figure, score: documentTextScore([figure.label, figure.caption, figure.alt_text, figure.figure_type].filter(Boolean).join("\n"), tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ figure, score }) => ({
      chunk_id: figure.chunk_id,
      figure_id: figure.id,
      document_id: figure.document_id,
      chunk_text: [figure.label, figure.caption, figure.alt_text].filter(Boolean).join("\n\n"),
      page_number: figure.page_number,
      section_heading: figure.label || `Figure ${figure.figure_index + 1}`,
      similarity: null,
      metadata: { retrieval: "figure", score, figure_type: figure.figure_type },
      evidence_type: "figure",
    }));

  const chunkIds = new Set();
  const chunks = [...semanticChunks, ...keywordChunks, ...tableChunks, ...figureChunks, ...metadataChunks].filter((chunk) => {
    const key = chunk.chunk_id || chunk.table_id || chunk.figure_id || `${chunk.document_id}:${chunk.chunk_text}`;
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
  const evidenceSources = chunks.map((chunk) => ({
    type: "document",
    id: chunk.document_id,
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    table_id: chunk.table_id,
    figure_id: chunk.figure_id,
    evidence_type: chunk.evidence_type,
    label: chunk.section_heading || "Document evidence",
    excerpt: String(chunk.chunk_text || "").slice(0, 260),
    page_number: chunk.page_number,
    similarity: chunk.similarity,
  }));
  const sources = [...docSources, ...semanticSources, ...evidenceSources].filter((source) => {
    const key = `${source.document_id}:${source.chunk_id || source.table_id || source.figure_id || "doc"}`;
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

function mentionedFieldIds(message, fields) {
  const lower = normaliseSearchText(message);
  return (fields || [])
    .filter((field) => {
      const name = normaliseSearchText(field?.name);
      if (!name) return false;
      return lower.includes(name) || name.split(" ").some((part) => part.length > 3 && lower.includes(part));
    })
    .map((field) => field.id);
}

function roundMetric(value, places = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(places));
}

function average(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function summariseTrend(rows, valueKey, dateKey = "scene_datetime") {
  const valid = (rows || [])
    .filter((row) => row.status === "ok" && Number.isFinite(Number(row[valueKey])))
    .sort((a, b) => new Date(a[dateKey]).getTime() - new Date(b[dateKey]).getTime());
  if (!valid.length) return null;
  const midpoint = Math.max(1, Math.floor(valid.length / 2));
  const older = valid.slice(0, midpoint);
  const newer = valid.slice(midpoint) || valid;
  const olderAvg = average(older.map((row) => row[valueKey]));
  const newerAvg = average((newer.length ? newer : valid).map((row) => row[valueKey]));
  const change = Number.isFinite(olderAvg) && Number.isFinite(newerAvg) ? newerAvg - olderAvg : null;
  const latest = valid.at(-1);
  const earliest = valid[0];
  return {
    firstDate: String(earliest?.[dateKey] || "").slice(0, 10),
    latestValidDate: String(latest?.[dateKey] || "").slice(0, 10),
    validObservations: valid.length,
    latestValue: roundMetric(latest?.[valueKey]),
    average: roundMetric(average(valid.map((row) => row[valueKey]))),
    min: roundMetric(Math.min(...valid.map((row) => Number(row[valueKey])))),
    max: roundMetric(Math.max(...valid.map((row) => Number(row[valueKey])))),
    olderAverage: roundMetric(olderAvg),
    newerAverage: roundMetric(newerAvg),
    change: roundMetric(change),
    direction: change == null ? "unknown" : Math.abs(change) < 0.02 ? "stable" : change > 0 ? "improving" : "declining",
  };
}

function buildSatellitePerformance(fields, ndviRows, sarRows) {
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  return (fields || []).map((field) => {
    const fieldNdviRows = (ndviRows || []).filter((row) => row.field_id === field.id);
    const fieldSarRows = (sarRows || []).filter((row) => row.field_id === field.id);
    const recentNdviRows = fieldNdviRows.filter((row) => now - new Date(row.scene_datetime).getTime() <= ninetyDaysMs);
    const recentSarRows = fieldSarRows.filter((row) => now - new Date(row.scene_datetime).getTime() <= ninetyDaysMs);
    if (!recentNdviRows.length && !recentSarRows.length) return null;
    const latestNdvi = [...recentNdviRows].sort((a, b) => new Date(b.scene_datetime).getTime() - new Date(a.scene_datetime).getTime())[0] || null;
    const latestSar = [...recentSarRows].sort((a, b) => new Date(b.scene_datetime).getTime() - new Date(a.scene_datetime).getTime())[0] || null;
    return {
      fieldId: field.id,
      fieldName: field.name,
      windowDays: 90,
      ndvi: {
        observations: recentNdviRows.length,
        validObservations: recentNdviRows.filter((row) => row.status === "ok" && Number(row.valid_pixel_count || 0) > 0).length,
        noDataObservations: recentNdviRows.filter((row) => row.status === "no-data" || Number(row.valid_pixel_count || 0) === 0).length,
        latestStatus: latestNdvi?.status || null,
        latestDate: String(latestNdvi?.scene_datetime || "").slice(0, 10),
        latestCloudPct: roundMetric(latestNdvi?.scene_cloud_pct, 1),
        trend: summariseTrend(recentNdviRows, "ndvi_mean"),
      },
      sar: {
        observations: recentSarRows.length,
        validObservations: recentSarRows.filter((row) => row.status === "ok" && Number(row.valid_pixel_count || 0) > 0).length,
        latestStatus: latestSar?.status || null,
        latestDate: String(latestSar?.scene_datetime || "").slice(0, 10),
        vvTrendDb: summariseTrend(recentSarRows, "vv_mean_db"),
        vhTrendDb: summariseTrend(recentSarRows, "vh_mean_db"),
        vhVvRatioTrend: summariseTrend(recentSarRows, "vh_vv_ratio_mean"),
      },
    };
  }).filter(Boolean);
}

function weatherSignals(weather) {
  const daily = weather?.daily || {};
  const precipitation = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum.slice(0, 5).map(Number) : [];
  const nextFiveDayRainMm = precipitation.filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  return {
    currentTempC: roundMetric(weather?.current?.temperature_2m, 1),
    currentRainMm: roundMetric(weather?.current?.precipitation, 1),
    currentWindKph: roundMetric(weather?.current?.wind_speed_10m, 1),
    nextFiveDayRainMm: roundMetric(nextFiveDayRainMm, 1),
    wetWindow: Number.isFinite(nextFiveDayRainMm) && nextFiveDayRainMm >= 10,
  };
}

function fieldAttribute(field, keys) {
  for (const key of keys) {
    const value = field?.attrs?.[key] ?? field?.currentPlanting?.[key] ?? field?.[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

function buildFieldAdvice(fields, performanceByField, weather) {
  const signals = weatherSignals(weather);
  return (performanceByField || []).map((performance) => {
    const field = (fields || []).find((item) => item.id === performance.fieldId) || {};
    const crop = fieldAttribute(field, ["crop", "cropName", "variety", "name"]);
    const soil = fieldAttribute(field, ["soil", "soilType", "soilTexture"]);
    const evidence = [];
    const recommendations = [];

    if (crop) evidence.push(`Crop/planting: ${crop}`);
    if (soil) evidence.push(`Soil: ${soil}`);
    if (performance.ndvi?.trend) {
      evidence.push(`NDVI ${performance.ndvi.trend.direction}: latest ${performance.ndvi.trend.latestValue}, average ${performance.ndvi.trend.average}, ${performance.ndvi.trend.validObservations} valid observations`);
    }
    if (performance.ndvi?.noDataObservations) {
      evidence.push(`${performance.ndvi.noDataObservations} optical no-data/cloud observations in the last ${performance.windowDays} days`);
    }
    if (performance.sar?.vhVvRatioTrend) {
      evidence.push(`SAR VH/VV ${performance.sar.vhVvRatioTrend.direction}: latest ${performance.sar.vhVvRatioTrend.latestValue}, change ${performance.sar.vhVvRatioTrend.change}`);
    }
    if (signals.nextFiveDayRainMm != null) {
      evidence.push(`Local forecast rain next 5 days: ${signals.nextFiveDayRainMm} mm`);
    }

    if (performance.ndvi?.trend?.direction === "declining") {
      recommendations.push("Walk the field within the next few days and ground-truth the weaker NDVI signal: check crop colour, establishment, disease, pest pressure, compaction and nutrient stress.");
    } else if (performance.ndvi?.trend?.direction === "improving") {
      recommendations.push("Keep inputs steady and monitor for lodging/disease rather than making a blanket intervention, because the optical vegetation trend is improving.");
    } else if (performance.ndvi?.trend?.direction === "stable") {
      recommendations.push("Use a targeted field walk rather than a broad intervention: the vegetation signal is broadly stable, so look for localised patches before spending on inputs.");
    }

    if (performance.ndvi?.validObservations === 0 && performance.ndvi?.noDataObservations > 0) {
      recommendations.push("Do not base the decision on the latest NDVI image alone; cloud/no-data means the optical record needs ground checking or SAR-backed interpretation.");
    } else if (performance.ndvi?.noDataObservations > performance.ndvi?.validObservations) {
      recommendations.push("Treat recent NDVI confidence as limited because no-data observations outnumber valid optical observations.");
    }

    if (performance.sar?.vhVvRatioTrend?.direction === "declining") {
      recommendations.push("Inspect canopy structure and wet/dry patches: the SAR vegetation-structure ratio is weakening, which can point to thinning canopy, lodging changes, or moisture-related variation.");
    } else if (performance.sar?.vhVvRatioTrend?.direction === "improving") {
      recommendations.push("Use SAR as supporting evidence that canopy structure is strengthening, but confirm with a field walk before changing nutrition or spray plans.");
    }

    if (signals.wetWindow) {
      recommendations.push("Avoid unnecessary trafficking and time any spray/fertiliser work around the wet forecast window to protect the loam soil structure.");
    }

    if (!recommendations.length) {
      recommendations.push("Use a scouting pass focused on representative and weak-looking areas, then compare the field notes against the next valid NDVI/SAR scene before committing to a broad treatment.");
    }

    return {
      fieldId: performance.fieldId,
      fieldName: performance.fieldName,
      areaHa: field.areaHa,
      crop,
      soil,
      evidence,
      recommendations,
    };
  });
}

async function loadFarmAppNamespaces(admin, farmId, namespaces) {
  if (!namespaces.length) return new Map();
  const { data, error } = await admin
    .from("farm_app_data")
    .select("namespace,data,updated_at")
    .eq("farm_id", farmId)
    .in("namespace", namespaces);
  if (error) throw new Error(error.message);
  return new Map((data || []).map((row) => [row.namespace, row.data]));
}

async function loadFieldRows(admin, farmId, appMap = null) {
  const [{ data: fields, error: fieldsError }, map] = await Promise.all([
    admin.from("tilth_fields").select("id,name,boundary,created_at,updated_at").eq("farm_id", farmId).order("created_at", { ascending: true }),
    appMap ? Promise.resolve(appMap) : loadFarmAppNamespaces(admin, farmId, ["fieldAttrs", "plantings"]),
  ]);
  if (fieldsError) throw new Error(fieldsError.message);
  return (fields || []).map((field) => ({
    ...field,
    areaHa: areaHa(field.boundary),
    attrs: map.get("fieldAttrs")?.[field.id] || null,
    currentPlanting: map.get("plantings")?.[field.id]?.[0] || null,
  }));
}

function resolveFields(fields, { fieldId = null, fieldName = null, query = null } = {}) {
  const needle = fieldName || query || "";
  const exactId = fieldId ? fields.find((field) => field.id === fieldId) : null;
  if (exactId) return [exactId];
  if (!needle) return fields.slice(0, 8);
  const normalisedNeedle = normaliseSearchText(needle);
  const scored = fields
    .map((field) => {
      const name = normaliseSearchText(field.name);
      let score = 0;
      if (name === normalisedNeedle) score = 100;
      else if (name.includes(normalisedNeedle)) score = 80;
      else if (normalisedNeedle.includes(name)) score = 70;
      else {
        const matches = name.split(" ").filter((part) => part.length > 2 && normalisedNeedle.includes(part)).length;
        score = matches * 20;
      }
      return { field, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((item) => item.field);
}

function registerSources(ctx, sources) {
  for (const source of sources || []) {
    if (!source) continue;
    const id = String(source.id || source.source_id || source.document_id || source.fieldId || source.label || "");
    if (!id) continue;
    ctx.sources.set(id, { ...source, id });
  }
}

function toolResult(ctx, name, result, sources = []) {
  registerSources(ctx, sources);
  const payload = {
    tool: name,
    ...result,
    sources,
  };
  ctx.toolLog.push({
    name,
    sourceCount: sources.length,
    summary: result?.summary || result?.status || null,
  });
  return payload;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function validateToolArgs(tool, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  if (tool.name === "search_documents") {
    return {
      query: String(args.query || "").slice(0, 500),
      category: args.category ? String(args.category).slice(0, 80) : null,
      matchCount: clampInt(args.matchCount, 1, 30, 12),
    };
  }
  if (tool.name === "find_invoice_or_payable") {
    return {
      supplier: String(args.supplier || args.counterparty || "").slice(0, 160),
      query: String(args.query || "").slice(0, 500),
      includePaid: Boolean(args.includePaid),
      limit: clampInt(args.limit, 1, 30, 12),
    };
  }
  if (tool.name === "resolve_field") {
    return {
      fieldName: String(args.fieldName || args.query || "").slice(0, 160),
      fieldId: args.fieldId ? String(args.fieldId).slice(0, 80) : null,
    };
  }
  if (tool.name === "get_field_performance") {
    return {
      fieldName: String(args.fieldName || args.query || "").slice(0, 160),
      fieldId: args.fieldId ? String(args.fieldId).slice(0, 80) : null,
      periodDays: clampInt(args.periodDays, 14, 365, 90),
    };
  }
  if (tool.name === "get_finance_summary") {
    return {
      counterparty: args.counterparty ? String(args.counterparty).slice(0, 160) : null,
      limit: clampInt(args.limit, 1, 100, 40),
    };
  }
  if (tool.name === "get_operations_summary" || tool.name === "get_compliance_status") {
    return {
      fieldName: args.fieldName ? String(args.fieldName).slice(0, 160) : null,
      fieldId: args.fieldId ? String(args.fieldId).slice(0, 80) : null,
      limit: clampInt(args.limit, 1, 80, 30),
    };
  }
  return {};
}

const ASSISTANT_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "get_available_context",
      description: "List what farm data sources are available before choosing more specific tools.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_documents",
      description: "Search farm documents by metadata, category, semantic chunks and extracted document text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: { type: "string", enum: ["invoice", "receipt", "certificate", "soil_analysis", "contract", "report", "letter", "email", "scheme_evidence", "general"] },
          matchCount: { type: "integer", minimum: 1, maximum: 30 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_invoice_or_payable",
      description: "Find invoice/payable evidence for a supplier or counterparty, including document text, extracted money entities, finance rows and document suggestions.",
      parameters: {
        type: "object",
        properties: {
          supplier: { type: "string" },
          query: { type: "string" },
          includePaid: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 30 },
        },
        required: ["supplier"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_field",
      description: "Resolve a field name or partial field reference to farm field ids and attributes.",
      parameters: {
        type: "object",
        properties: {
          fieldName: { type: "string" },
          fieldId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_field_performance",
      description: "Get field-specific satellite, weather, crop, soil, elevation and advice evidence for a period.",
      parameters: {
        type: "object",
        properties: {
          fieldName: { type: "string" },
          fieldId: { type: "string" },
          periodDays: { type: "integer", minimum: 14, maximum: 365 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_finance_summary",
      description: "Summarise the full finance ledger namespace, optionally filtered by counterparty.",
      parameters: {
        type: "object",
        properties: {
          counterparty: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_operations_summary",
      description: "Summarise operational data such as records, tasks, inventory, plantings, observations and livestock.",
      parameters: {
        type: "object",
        properties: {
          fieldName: { type: "string" },
          fieldId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 80 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_compliance_status",
      description: "Summarise compliance/audit state, checklist items, pre-harvest safety and compliance documents.",
      parameters: {
        type: "object",
        properties: {
          fieldName: { type: "string" },
          fieldId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 80 },
        },
        additionalProperties: false,
      },
    },
  },
];

async function toolGetAvailableContext(ctx) {
  const [{ count: fields }, { count: documents }, { data: namespaces }, { count: pendingActions }] = await Promise.all([
    ctx.admin.from("tilth_fields").select("id", { count: "exact", head: true }).eq("farm_id", ctx.farmId),
    ctx.admin.from("farm_documents").select("id", { count: "exact", head: true }).eq("farm_id", ctx.farmId).is("deleted_at", null),
    ctx.admin.from("farm_app_data").select("namespace,updated_at").eq("farm_id", ctx.farmId),
    ctx.admin.from("assistant_suggested_actions").select("id", { count: "exact", head: true }).eq("farm_id", ctx.farmId).eq("status", "pending"),
  ]);
  return toolResult(ctx, "get_available_context", {
    status: "ok",
    farmId: ctx.farmId,
    fields: fields || 0,
    documents: documents || 0,
    pendingSuggestedActions: pendingActions || 0,
    namespaces: namespaces || [],
    availableTools: ASSISTANT_TOOL_SCHEMAS.map((tool) => tool.function.name),
  });
}

async function toolSearchDocuments(ctx, args) {
  const query = [args.query, args.category].filter(Boolean).join(" ");
  const context = await retrieveDocumentContext(ctx.admin, ctx.farmId, query, {
    recentLimit: 80,
    matchCount: args.matchCount,
  });
  const docIds = [...new Set([
    ...(context.matchedDocuments || []).map((doc) => doc.id),
    ...(context.chunks || []).map((chunk) => chunk.document_id),
  ].filter(Boolean))].slice(0, 50);
  let entities = [];
  if (docIds.length) {
    const { data } = await ctx.admin
      .from("document_extracted_entities")
      .select("document_id,chunk_id,entity_type,entity_value,normalised_value,confidence")
      .eq("farm_id", ctx.farmId)
      .in("document_id", docIds)
      .limit(120);
    entities = data || [];
  }
  const sources = (context.sources || []).map((source) => ({
    ...source,
    id: sourceId("document", source.document_id, source.chunk_id || "metadata"),
  }));
  return toolResult(ctx, "search_documents", {
    status: context.error ? "partial" : "ok",
    query: args.query,
    category: args.category,
    documents: (context.matchedDocuments || []).slice(0, 20).map((doc) => compactRow(doc, ["id", "title", "category", "filename", "status", "expiry_date", "updated_at"])),
    chunks: (context.chunks || []).slice(0, args.matchCount).map((chunk) => ({
      document_id: chunk.document_id,
      chunk_id: chunk.chunk_id,
      table_id: chunk.table_id,
      figure_id: chunk.figure_id,
      evidence_type: chunk.evidence_type,
      page_number: chunk.page_number,
      similarity: chunk.similarity,
      text: String(chunk.chunk_text || "").slice(0, 900),
    })),
    entities,
    error: context.error || null,
  }, sources);
}

function financeStatus(row) {
  const raw = String(row?.status || row?.paymentStatus || row?.payment_status || row?.paidStatus || "").toLowerCase();
  if (raw.includes("paid") && !raw.includes("unpaid")) return "paid";
  if (raw.includes("unpaid") || raw.includes("open") || raw.includes("due") || raw.includes("outstanding")) return "unpaid";
  if (row?.paid === true || row?.isPaid === true) return "paid";
  if (row?.paid === false || row?.isPaid === false) return "unpaid";
  return "unknown";
}

function financeAmount(row) {
  const amount = Number(row?.amount ?? row?.amountDue ?? row?.total ?? row?.grossAmount);
  return Number.isFinite(amount) ? amount : null;
}

async function loadFinanceRows(ctx) {
  const appMap = await loadFarmAppNamespaces(ctx.admin, ctx.farmId, ["finances"]);
  const appRows = asArray(appMap.get("finances")).map((row) => ({
    ...row,
    sourceKind: "farm_app_data:finances",
    sourceId: row.id || row.sourceKey || null,
  }));
  let tableRows = [];
  try {
    const { data } = await ctx.admin
      .from("farm_finances")
      .select("*")
      .eq("farm_id", ctx.farmId)
      .order("txn_date", { ascending: false })
      .limit(500);
    tableRows = (data || []).map((row) => ({
      id: row.id,
      type: row.txn_type || row.type,
      date: row.txn_date || row.date,
      amount: row.amount,
      category: row.category,
      counterparty: row.counterparty,
      invoiceRef: row.invoice_ref,
      notes: row.notes,
      sourceKind: "farm_finances",
      sourceId: row.id,
    }));
  } catch {
    tableRows = [];
  }
  return [...appRows, ...tableRows];
}

async function toolGetFinanceSummary(ctx, args) {
  const rows = await loadFinanceRows(ctx);
  const filtered = args.counterparty
    ? rows.filter((row) => textMatchesNeedle([row.counterparty, row.description, row.notes, row.invoiceRef].join(" "), args.counterparty))
    : rows;
  const income = filtered.filter((row) => String(row.type || "").toLowerCase() === "income").reduce((sum, row) => sum + (financeAmount(row) || 0), 0);
  const expenses = filtered.filter((row) => String(row.type || "").toLowerCase() !== "income").reduce((sum, row) => sum + (financeAmount(row) || 0), 0);
  const sources = filtered.slice(0, args.limit).map((row) => ({
    id: sourceId("finance", row.sourceId || row.invoiceRef || row.date || row.counterparty),
    type: "finance",
    label: [row.counterparty, row.invoiceRef, row.date].filter(Boolean).join(" · ") || "Finance row",
    excerpt: [row.description, row.notes].filter(Boolean).join(" · ").slice(0, 260),
  }));
  return toolResult(ctx, "get_finance_summary", {
    status: "ok",
    counterparty: args.counterparty,
    totalRows: rows.length,
    matchedRows: filtered.length,
    income,
    expenses,
    net: income - expenses,
    rows: filtered.slice(0, args.limit).map((row) => compactRow(row, ["id", "type", "date", "amount", "vatAmount", "category", "description", "counterparty", "invoiceRef", "status", "paymentStatus", "notes", "sourceKind"])),
  }, sources);
}

async function toolFindInvoiceOrPayable(ctx, args) {
  const supplier = args.supplier || args.query;
  const docSearch = await retrieveDocumentContext(ctx.admin, ctx.farmId, `${supplier} invoice receipt bill amount due unpaid`, {
    recentLimit: 100,
    matchCount: Math.min(30, args.limit + 8),
  });
  const candidateDocs = (docSearch.matchedDocuments || []).filter((doc) => (
    ["invoice", "receipt", "general"].includes(doc.category) &&
    textMatchesNeedle([doc.title, doc.filename, doc.notes, ...(Array.isArray(doc.tags) ? doc.tags : [])].join(" "), supplier)
  )).slice(0, args.limit);
  const candidateDocIds = candidateDocs.map((doc) => doc.id);
  const matchingChunks = (docSearch.chunks || []).filter((chunk) => (
    candidateDocIds.includes(chunk.document_id) ||
    textMatchesNeedle(chunk.chunk_text, supplier)
  )).slice(0, args.limit);
  const docIds = [...new Set([...candidateDocIds, ...matchingChunks.map((chunk) => chunk.document_id)].filter(Boolean))];
  const [entitiesResult, suggestionsResult, financeRows] = await Promise.all([
    docIds.length
      ? ctx.admin.from("document_extracted_entities").select("document_id,chunk_id,entity_type,entity_value,normalised_value,confidence").eq("farm_id", ctx.farmId).in("document_id", docIds).limit(150)
      : { data: [] },
    docIds.length
      ? ctx.admin.from("document_suggested_actions").select("document_id,action_type,title,summary,payload,status,created_at").eq("farm_id", ctx.farmId).in("document_id", docIds).eq("action_type", "finance_transaction").limit(50)
      : { data: [] },
    loadFinanceRows(ctx),
  ]);
  const financeMatches = financeRows
    .filter((row) => textMatchesNeedle([row.counterparty, row.description, row.notes, row.invoiceRef].join(" "), supplier))
    .filter((row) => args.includePaid || financeStatus(row) !== "paid")
    .slice(0, args.limit);
  const moneyEntities = (entitiesResult.data || []).filter((entity) => entity.entity_type === "MONEY");
  const suggestionCandidates = (suggestionsResult.data || []).map((suggestion) => ({
    document_id: suggestion.document_id,
    title: suggestion.title,
    status: suggestion.status,
    payload: suggestion.payload || {},
    amount: financeAmount(suggestion.payload || {}),
    counterparty: suggestion.payload?.counterparty || null,
    invoiceRef: suggestion.payload?.invoiceRef || null,
    date: suggestion.payload?.date || null,
  })).filter((candidate) => textMatchesNeedle([candidate.counterparty, candidate.title, candidate.invoiceRef].join(" "), supplier));
  const chunkMoney = matchingChunks.flatMap((chunk) => extractMoneyValues(chunk.chunk_text).map((amount) => ({
    amount,
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    method: "chunk_text",
  })));
  const evidenceAmounts = [
    ...financeMatches.map((row) => ({ amount: financeAmount(row), method: "finance_row", source: row })).filter((item) => item.amount != null),
    ...suggestionCandidates.map((item) => ({ amount: item.amount, method: "document_suggested_action", source: item })).filter((item) => item.amount != null),
    ...moneyEntities.map((entity) => ({ amount: Number(String(entity.normalised_value || entity.entity_value).replace(/[^0-9.-]/g, "")), method: "document_entity", source: entity })).filter((item) => Number.isFinite(item.amount)),
    ...chunkMoney,
  ];
  const unpaidFinance = financeMatches.filter((row) => financeStatus(row) === "unpaid");
  const knownDue = unpaidFinance.length
    ? unpaidFinance.reduce((sum, row) => sum + (financeAmount(row) || 0), 0)
    : null;
  const sources = [
    ...candidateDocs.map((doc) => ({
      id: sourceId("document", doc.id, "invoice"),
      type: "document",
      document_id: doc.id,
      label: doc.title || doc.filename || "Invoice document",
      category: doc.category,
      filename: doc.filename,
      excerpt: [doc.category, doc.filename, doc.notes].filter(Boolean).join(" · ").slice(0, 260),
    })),
    ...financeMatches.map((row) => ({
      id: sourceId("finance", row.sourceId || row.invoiceRef || row.date),
      type: "finance",
      label: [row.counterparty, row.invoiceRef, row.date].filter(Boolean).join(" · ") || "Finance row",
      excerpt: [row.description, row.notes].filter(Boolean).join(" · ").slice(0, 260),
    })),
  ];
  return toolResult(ctx, "find_invoice_or_payable", {
    status: docIds.length || financeMatches.length ? "ok" : "not_found",
    supplier,
    amountDue: knownDue,
    amountDueConfidence: knownDue != null ? "finance_status" : "unknown_paid_status",
    paymentStatusAvailable: unpaidFinance.length > 0 || financeMatches.some((row) => financeStatus(row) !== "unknown"),
    financeMatches: financeMatches.map((row) => ({ ...compactRow(row, ["id", "type", "date", "amount", "counterparty", "invoiceRef", "status", "paymentStatus", "description", "notes", "sourceKind"]), inferredStatus: financeStatus(row) })),
    invoiceDocuments: candidateDocs.map((doc) => compactRow(doc, ["id", "title", "category", "filename", "status", "updated_at"])),
    suggestedFinanceActions: suggestionCandidates,
    extractedMoneyEvidence: evidenceAmounts.slice(0, 30),
    matchingChunks: matchingChunks.map((chunk) => ({
      document_id: chunk.document_id,
      chunk_id: chunk.chunk_id,
      text: String(chunk.chunk_text || "").slice(0, 900),
      similarity: chunk.similarity,
    })),
    interpretationHint: "If amountDue is null but money evidence exists, explain that the invoice amount was found but paid/unpaid state is not explicitly tracked.",
  }, sources);
}

async function toolResolveField(ctx, args) {
  const fields = await loadFieldRows(ctx.admin, ctx.farmId);
  const matches = resolveFields(fields, args);
  const sources = matches.map((field) => ({ id: sourceId("field", field.id), type: "field", fieldId: field.id, label: field.name }));
  return toolResult(ctx, "resolve_field", {
    status: matches.length ? "ok" : "not_found",
    query: args.fieldName || args.fieldId,
    matches: matches.map((field) => ({
      id: field.id,
      name: field.name,
      areaHa: field.areaHa,
      attrs: field.attrs,
      currentPlanting: field.currentPlanting,
    })),
  }, sources);
}

async function toolGetFieldPerformance(ctx, args) {
  const appMap = await loadFarmAppNamespaces(ctx.admin, ctx.farmId, ["fieldAttrs", "plantings", "records", "tasks", "observations"]);
  const fields = await loadFieldRows(ctx.admin, ctx.farmId, appMap);
  const matches = resolveFields(fields, args).slice(0, 3);
  const fieldIds = matches.map((field) => field.id);
  if (!fieldIds.length) return toolResult(ctx, "get_field_performance", { status: "not_found", query: args.fieldName || args.fieldId }, []);
  const cutoff = new Date(Date.now() - args.periodDays * 24 * 60 * 60 * 1000).toISOString();
  const [ndviResult, sarResult, elevationResult, layersResult, weather] = await Promise.all([
    ctx.admin.from("tilth_field_ndvi").select("*").in("field_id", fieldIds).gte("scene_datetime", cutoff).order("scene_datetime", { ascending: false }).limit(SATELLITE_CONTEXT_LIMIT),
    ctx.admin.from("tilth_field_sar").select("*").in("field_id", fieldIds).gte("scene_datetime", cutoff).order("scene_datetime", { ascending: false }).limit(SATELLITE_CONTEXT_LIMIT),
    ctx.admin.from("tilth_field_elevation").select("*").in("field_id", fieldIds),
    ctx.admin.from("tilth_field_layer_data").select("field_id,layer_id,strategy,status,features,updated_at").in("field_id", fieldIds).order("updated_at", { ascending: false }).limit(60),
    maybeFetchWeather(matches),
  ]);
  const performance = buildSatellitePerformance(matches, ndviResult.data || [], sarResult.data || []);
  const advice = buildFieldAdvice(matches, performance, weather);
  const records = asArray(appMap.get("records")).filter((row) => !fieldIds.length || fieldIds.includes(row.fieldId)).slice(0, 20);
  const tasks = asArray(appMap.get("tasks")).filter((row) => !fieldIds.length || fieldIds.includes(row.fieldId)).slice(0, 20);
  const sources = [
    ...matches.map((field) => ({ id: sourceId("field", field.id), type: "field", fieldId: field.id, label: field.name })),
    ...(ndviResult.data || []).slice(0, 10).map((row) => ({ id: sourceId("satellite_ndvi", row.id), type: "satellite_ndvi", fieldId: row.field_id, label: `NDVI ${String(row.scene_datetime || "").slice(0, 10)}` })),
    ...(sarResult.data || []).slice(0, 10).map((row) => ({ id: sourceId("satellite_sar", row.id), type: "satellite_sar", fieldId: row.field_id, label: `SAR ${String(row.scene_datetime || "").slice(0, 10)}` })),
  ];
  return toolResult(ctx, "get_field_performance", {
    status: "ok",
    periodDays: args.periodDays,
    fields: matches.map((field) => ({ id: field.id, name: field.name, areaHa: field.areaHa, attrs: field.attrs, currentPlanting: field.currentPlanting })),
    performanceByField: performance,
    fieldAdvice: advice,
    elevation: elevationResult.data || [],
    layers: (layersResult.data || []).map((row) => ({
      fieldId: row.field_id,
      layerId: row.layer_id,
      status: row.status,
      featureCount: row.features?.features?.length || 0,
      sampleProperties: row.features?.features?.[0]?.properties || null,
      updated_at: row.updated_at,
    })),
    recentRecords: records,
    openTasks: tasks.filter((task) => !["done", "completed", "cancelled"].includes(String(task.status || "").toLowerCase())),
    weather: weatherSignals(weather),
  }, sources);
}

async function toolGetOperationsSummary(ctx, args) {
  const appMap = await loadFarmAppNamespaces(ctx.admin, ctx.farmId, SCOPE_NAMESPACES.operations);
  const fields = await loadFieldRows(ctx.admin, ctx.farmId, appMap);
  const matches = args.fieldId || args.fieldName ? resolveFields(fields, args) : [];
  const fieldIds = matches.map((field) => field.id);
  const filterField = (row) => !fieldIds.length || fieldIds.includes(row.fieldId);
  const namespaces = Object.fromEntries(SCOPE_NAMESPACES.operations.map((ns) => {
    const data = appMap.get(ns);
    const rows = Array.isArray(data) ? data.filter(filterField).slice(0, args.limit) : data;
    return [ns, summarizeNamespace(ns, rows)];
  }));
  const sources = matches.map((field) => ({ id: sourceId("field", field.id), type: "field", fieldId: field.id, label: field.name }));
  return toolResult(ctx, "get_operations_summary", {
    status: "ok",
    fieldFilter: matches.map((field) => ({ id: field.id, name: field.name })),
    namespaces,
  }, sources);
}

async function toolGetComplianceStatus(ctx, args) {
  const appMap = await loadFarmAppNamespaces(ctx.admin, ctx.farmId, SCOPE_NAMESPACES.compliance);
  const docs = await retrieveDocumentContext(ctx.admin, ctx.farmId, "certificate compliance audit red tractor organic nptc spray test scheme evidence", {
    recentLimit: args.limit,
    matchCount: 12,
  });
  const sources = (docs.sources || []).map((source) => ({ ...source, id: sourceId("document", source.document_id, source.chunk_id || "metadata") }));
  return toolResult(ctx, "get_compliance_status", {
    status: docs.error ? "partial" : "ok",
    auditChecklists: summarizeNamespace("audit_checklists", appMap.get("audit_checklists")),
    preharvestSafety: summarizeNamespace("preharvest_safety", appMap.get("preharvest_safety")),
    records: summarizeNamespace("records", appMap.get("records")),
    inventory: summarizeNamespace("inventory", appMap.get("inventory")),
    complianceDocuments: (docs.matchedDocuments || []).slice(0, args.limit).map((doc) => compactRow(doc, ["id", "title", "category", "filename", "status", "expiry_date", "updated_at"])),
    documentChunks: (docs.chunks || []).slice(0, 12).map((chunk) => ({ document_id: chunk.document_id, chunk_id: chunk.chunk_id, text: String(chunk.chunk_text || "").slice(0, 700) })),
    error: docs.error || null,
  }, sources);
}

const ASSISTANT_TOOL_HANDLERS = {
  get_available_context: toolGetAvailableContext,
  search_documents: toolSearchDocuments,
  find_invoice_or_payable: toolFindInvoiceOrPayable,
  resolve_field: toolResolveField,
  get_field_performance: toolGetFieldPerformance,
  get_finance_summary: toolGetFinanceSummary,
  get_operations_summary: toolGetOperationsSummary,
  get_compliance_status: toolGetComplianceStatus,
};

async function collectPlatformContext(admin, farmId, message, scope = "whole_farm", { mode = "chat", reportType = null } = {}) {
  const effectiveScope = normaliseScope(scope, message, mode, reportType);
  const profile = contextProfile(effectiveScope, message, mode);
  const [{ data: farm }, { data: fields }, { data: appData }, { data: documents }] = await Promise.all([
    admin.from("farms").select("id,name,address_line1,address_line2,city,region,postcode,country").eq("id", farmId).maybeSingle(),
    admin.from("tilth_fields").select("id,name,boundary,created_at,updated_at").eq("farm_id", farmId).order("created_at", { ascending: true }),
    profile.namespaces.length
      ? admin.from("farm_app_data").select("namespace,data,updated_at").eq("farm_id", farmId).in("namespace", profile.namespaces)
      : { data: [] },
    profile.includeDocuments
      ? admin
          .from("farm_documents")
          .select("id,title,category,filename,expiry_date,tags,status,updated_at")
          .eq("farm_id", farmId)
          .is("deleted_at", null)
          .order("updated_at", { ascending: false })
          .limit(profile.recentDocumentLimit)
      : { data: [] },
  ]);
  const fieldRows = fields || [];
  const fieldIds = fieldRows.map((f) => f.id);
  const targetedFieldIds = mentionedFieldIds(message, fieldRows);
  const remoteFieldIds = targetedFieldIds.length ? targetedFieldIds : fieldIds;
  const [ndviResult, sarResult, elevationResult, layersResult, docContext, weather] = await Promise.all([
    profile.includeRemoteSensing && remoteFieldIds.length
      ? admin.from("tilth_field_ndvi").select("*").in("field_id", remoteFieldIds).order("scene_datetime", { ascending: false }).limit(SATELLITE_CONTEXT_LIMIT)
      : { data: [] },
    profile.includeRemoteSensing && remoteFieldIds.length
      ? admin.from("tilth_field_sar").select("*").in("field_id", remoteFieldIds).order("scene_datetime", { ascending: false }).limit(SATELLITE_CONTEXT_LIMIT)
      : { data: [] },
    profile.includeRemoteSensing && remoteFieldIds.length
      ? admin.from("tilth_field_elevation").select("*").in("field_id", remoteFieldIds)
      : { data: [] },
    profile.includeRemoteSensing && remoteFieldIds.length
      ? admin.from("tilth_field_layer_data").select("field_id,layer_id,strategy,status,features,updated_at").in("field_id", remoteFieldIds).order("updated_at", { ascending: false }).limit(80)
      : { data: [] },
    profile.includeDocuments
      ? retrieveDocumentContext(admin, farmId, message, {
          recentLimit: profile.recentDocumentLimit,
          matchCount: profile.documentMatchCount,
        })
      : { chunks: [], sources: [], matchedDocuments: [], error: null },
    profile.includeWeather ? maybeFetchWeather(fieldRows) : null,
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
    profile.namespaces.map((ns) => [ns, summarizeNamespace(ns, appMap.get(ns))])
  );
  const performanceByField90d = buildSatellitePerformance(fieldsSummary, ndviResult.data, sarResult.data);
  const fieldAdvice90d = buildFieldAdvice(fieldsSummary, performanceByField90d, weather);
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
    scope: effectiveScope,
    requestedScope: scope,
    contextProfile: {
      includeDocuments: profile.includeDocuments,
      includeRemoteSensing: profile.includeRemoteSensing,
      includeWeather: profile.includeWeather,
      namespaces: profile.namespaces,
    },
    farm,
    fields: fieldsSummary,
    namespaces: namespaceSummaries,
    remoteSensing: {
      targetedFields: targetedFieldIds,
      performanceByField90d,
      fieldAdvice90d,
      latestNdviByField: latestByField(ndviResult.data, "scene_datetime").slice(0, 20),
      latestSarByField: latestByField(sarResult.data, "scene_datetime").slice(0, 20),
      historicNdvi: (ndviResult.data || []).map((row) => ({
        ...row,
        fieldName: fieldMap.get(row.field_id)?.name || row.field_id,
        sceneDate: row.scene_datetime,
      })),
      historicSar: (sarResult.data || []).map((row) => ({
        ...row,
        fieldName: fieldMap.get(row.field_id)?.name || row.field_id,
        sceneDate: row.scene_datetime,
      })),
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

function cleanString(value, max = 240) {
  return value == null ? "" : String(value).trim().slice(0, max);
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanDate(value, fallback = null) {
  const text = cleanString(value, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return fallback;
}

function validateActionPayload(actionType, payload, title) {
  const p = payload && typeof payload === "object" ? payload : {};
  const sourceKey = cleanString(p.sourceKey, 180);
  const withSource = (value) => (sourceKey ? { ...value, sourceKey } : value);
  if (actionType === "calendar_reminder") {
    return withSource({
      title: cleanString(p.title || title, 160),
      dueDate: cleanDate(p.dueDate || p.date, today()),
      reminderDays: clampInt(p.reminderDays, 0, 90, 3),
      category: cleanString(p.category || "general", 80),
      priority: ["low", "medium", "high"].includes(p.priority) ? p.priority : "medium",
      notes: cleanString(p.notes, 1000),
    });
  }
  if (actionType === "finance_transaction") {
    return withSource({
      type: ["income", "expense"].includes(p.type) ? p.type : "expense",
      date: cleanDate(p.date || p.invoiceDate || p.documentDate || p.transactionDate || p.dueDate, today()),
      amount: cleanNumber(p.amount ?? p.amountDue ?? p.totalAmount ?? p.total ?? p.grossAmount),
      vatAmount: cleanNumber(p.vatAmount ?? p.vat ?? p.vatTotal ?? p.taxAmount),
      category: cleanString(p.category || "other", 80),
      description: cleanString(p.description || title, 220),
      counterparty: cleanString(p.counterparty || p.supplier || p.vendor || p.issuer, 160),
      invoiceRef: cleanString(p.invoiceRef || p.invoiceNumber || p.invoiceNo || p.reference, 120),
      fieldId: cleanString(p.fieldId, 80),
      notes: cleanString(p.notes, 1000),
    });
  }
  if (actionType === "inventory_item") {
    return withSource({
      name: cleanString(p.name || title, 160),
      category: cleanString(p.category || "other", 80),
      unit: cleanString(p.unit || "unit", 40),
      quantity: cleanNumber(p.quantity),
      unitCost: cleanNumber(p.unitCost),
      batchNumber: cleanString(p.batchNumber, 80),
      supplier: cleanString(p.supplier, 160),
      purchaseDate: cleanDate(p.purchaseDate, ""),
      expiryDate: cleanDate(p.expiryDate, ""),
      storageLocation: cleanString(p.storageLocation, 160),
      mappNumber: cleanString(p.mappNumber, 80),
      lowStockThreshold: p.lowStockThreshold == null ? null : cleanNumber(p.lowStockThreshold),
      notes: cleanString(p.notes, 1000),
    });
  }
  if (actionType === "inventory_adjustment") {
    return withSource({
      itemId: cleanString(p.itemId, 80),
      itemName: cleanString(p.itemName || p.name || title, 160),
      delta: cleanNumber(p.delta),
    });
  }
  if (actionType === "spray_record") {
    return withSource({
      productName: cleanString(p.productName || title, 160),
      productId: cleanString(p.productId, 80),
      fieldId: cleanString(p.fieldId, 80),
      fieldName: cleanString(p.fieldName, 160),
      rate: cleanNumber(p.rate),
      category: cleanString(p.category || "Other", 80),
      unit: cleanString(p.unit || "L/ha", 40),
      date: cleanDate(p.date, today()),
      startTime: cleanString(p.startTime, 20),
      endTime: cleanString(p.endTime, 20),
      windDirection: cleanString(p.windDirection, 40),
      operator: cleanString(p.operator, 120),
      area: cleanNumber(p.area),
      notes: cleanString(p.notes, 1000),
    });
  }
  if (actionType === "field_observation") {
    const type = cleanString(p.type || p.observationType || "general", 40).toLowerCase();
    const allowedTypes = new Set(["disease", "pest", "weed", "waterlogging", "lodging", "wildlife", "general"]);
    return withSource({
      fieldId: cleanString(p.fieldId, 80),
      fieldName: cleanString(p.fieldName, 160),
      type: allowedTypes.has(type) ? type : "general",
      notes: cleanString(p.notes || p.description || title, 1200),
      datetime: cleanString(p.datetime || p.date || new Date().toISOString(), 60),
      locationHint: cleanString(p.locationHint || p.location || "", 220),
      recommendedAction: cleanString(p.recommendedAction || p.followUp || "", 500),
    });
  }
  if (actionType === "contact") {
    return withSource({
      name: cleanString(p.name || title, 160),
      company: cleanString(p.company, 160),
      role: cleanString(p.role || "other", 80),
      phone: cleanString(p.phone, 80),
      email: cleanString(p.email, 160),
      address: cleanString(p.address, 260),
      notes: cleanString(p.notes, 1000),
    });
  }
  if (actionType === "market_watchlist") {
    return withSource({
      marketId: cleanString(p.marketId || p.commodity || title, 120),
      commodity: cleanString(p.commodity || p.marketId || title, 120),
      target: cleanString(p.target, 80),
      direction: ["above", "below"].includes(p.direction) ? p.direction : "above",
      notes: cleanString(p.notes, 1000),
    });
  }
  if (actionType === "livestock_medicine" || actionType === "livestock_movement") {
    const clean = {};
    for (const [key, value] of Object.entries(p).slice(0, 30)) {
      if (key === "sourceKey") continue;
      clean[key] = typeof value === "number" ? cleanNumber(value) : cleanString(value, 300);
    }
    return withSource({ ...clean, notes: cleanString(p.notes, 1000) });
  }
  if (actionType === "compliance_checklist") {
    return withSource({
      checklist: cleanString(p.checklist || "assistant", 80),
      title: cleanString(p.title || title, 180),
      notes: cleanString(p.notes, 1000),
    });
  }
  return {};
}

function validateSuggestedActions(actions, farmId, userId, originId = null) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action) => ACTION_TYPES.has(action?.action_type))
    .slice(0, 6)
    .map((action) => {
      const title = cleanString(action.title || "Suggested action", 160);
      const metadata = action.metadata && typeof action.metadata === "object" ? action.metadata : {};
      return {
        farm_id: farmId,
        user_id: userId,
        origin: "platform_assistant",
        origin_id: originId,
        action_type: action.action_type,
        title,
        summary: cleanString(action.summary, 600),
        confidence: Math.max(0, Math.min(1, cleanNumber(action.confidence, 0.6))),
        payload: validateActionPayload(action.action_type, action.payload, title),
        metadata,
      };
    });
}

function persistableSuggestedActions(actions) {
  return (Array.isArray(actions) ? actions : []).map((action) => {
    if (action?.action_type !== "field_observation") return action;
    return {
      ...action,
      // Keep live databases working even before their check constraint includes
      // field_observation. The UI reads these markers and applies it as an
      // observation, not as a spray/application record.
      action_type: "spray_record",
      payload: {
        ...(action.payload || {}),
        recordAs: "field_observation",
      },
      metadata: {
        ...(action.metadata || {}),
        intendedActionType: "field_observation",
      },
    };
  });
}

async function persistSuggestedActions(admin, actions, label = "chat") {
  const rows = persistableSuggestedActions(actions);
  if (!rows.length) return { actions: [], warning: "" };
  const inserted = await admin.from("assistant_suggested_actions").insert(rows).select("*");
  if (!inserted.error) return { actions: inserted.data || [], warning: "" };

  const diagnostic = rows.map((row) => ({
    action_type: row.action_type,
    intendedActionType: row.metadata?.intendedActionType || row.payload?.recordAs || row.action_type,
    title: row.title,
  }));
  console.error("[platform-assistant actions] insert failed", {
    label,
    message: inserted.error.message,
    code: inserted.error.code,
    details: inserted.error.details,
    hint: inserted.error.hint,
    actions: diagnostic,
  });
  return {
    actions: [],
    warning: "I answered, but could not save the suggested action. Please try again after the assistant action schema is updated.",
  };
}

function parseNaturalDate(message) {
  const text = String(message || "").toLowerCase();
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  if (/\btomorrow\b/.test(text)) {
    base.setDate(base.getDate() + 1);
    return base.toISOString().slice(0, 10);
  }
  if (/\btoday\b/.test(text)) return base.toISOString().slice(0, 10);
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return iso[1];
  return null;
}

function parseNaturalTime(message) {
  const match = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(String(message || ""));
  if (!match) return "";
  let hour = Number(match[1]);
  const minutes = match[2] || "00";
  const suffix = match[3].toLowerCase();
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minutes}`;
}

function parseMeetingSubject(message) {
  const text = String(message || "");
  const withMatch = /\bwith\s+([a-z][a-z .'-]{1,80})(?:\s+(?:at|on|tomorrow|today)\b|$)/i.exec(text);
  if (withMatch) return cleanMeetingSubject(withMatch[1]);
  const meetMatch = /\bmeet(?:ing)?\s+([a-z][a-z .'-]{1,80})(?:\s+(?:at|on|tomorrow|today)\b|$)/i.exec(text);
  if (meetMatch) return cleanMeetingSubject(meetMatch[1]);
  return "";
}

function cleanMeetingSubject(value) {
  return String(value || "")
    .replace(/\b(please|pls|put|add|create|in|into|my|the|calendar|calander|diary|for me)\b[\s\S]*$/i, "")
    .trim()
    .replace(/[?.!,]+$/, "");
}

function deterministicSuggestedActions(message) {
  const text = String(message || "");
  if (!/\b(calendar|remind|reminder|meet|meeting|appointment|call)\b/i.test(text)) return [];
  const dueDate = parseNaturalDate(text);
  if (!dueDate) return [];
  const time = parseNaturalTime(text);
  const subject = parseMeetingSubject(text);
  const title = subject ? `Meeting with ${subject}` : "Calendar reminder";
  return [{
    action_type: "calendar_reminder",
    title,
    summary: time
      ? `Create a calendar reminder for ${title.toLowerCase()} at ${time}.`
      : `Create a calendar reminder for ${title.toLowerCase()}.`,
    confidence: 0.8,
    payload: {
      title,
      dueDate,
      reminderDays: 0,
      category: "meeting",
      priority: "medium",
      notes: time ? `Time: ${time}. Original request: ${text}` : `Original request: ${text}`,
      sourceKey: `assistant:calendar:${dueDate}:${normaliseSearchText(title).slice(0, 80)}`,
    },
    metadata: { deterministic: true },
  }];
}

function deterministicFallbackResponse({ farmId, userId, message, originId, context = null, reason = "" }) {
  const suggestedActions = validateSuggestedActions(
    deterministicSuggestedActions(message),
    farmId,
    userId,
    originId
  );
  const answer = suggestedActions.length
    ? "I could not reach the AI service, but I understood this as a calendar request and drafted it for you to confirm."
    : fallbackAnswer(context || { fields: [], namespaces: {} }, message, "chat");
  return {
    answer,
    suggestedActions,
    sources: context?.sources?.slice(0, 14) || [],
    context: context || { scope: "fallback", error: reason },
    toolLog: reason ? [{ name: "openai", error: reason }] : [],
  };
}

function historyForPrompt(history) {
  return (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-ASSISTANT_HISTORY_LIMIT)
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").slice(0, 2000),
    }));
}

function retrievalTextFromHistory(message, history) {
  const recentTurns = (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`);
  return [...recentTurns, `user: ${message}`].filter(Boolean).join("\n");
}

function actionExamplesForPrompt() {
  return JSON.stringify(Object.values(ACTION_EXAMPLE_CATALOG), null, 2);
}

async function loadSessionHistory(admin, farmId, sessionId) {
  if (!sessionId) return [];
  const { data, error } = await admin
    .from("assistant_chat_messages")
    .select("role,content,created_at")
    .eq("farm_id", farmId)
    .eq("chat_session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(ASSISTANT_HISTORY_LIMIT);
  if (error) throw new Error(error.message);
  return (data || []).reverse().filter((m) => m.role === "user" || m.role === "assistant");
}

function assistantToolSystemPrompt({ mode, reportType, scope }) {
  return [
    "You are Tilth's integrated farm assistant.",
    "You have backend tools for documents, invoices, finance, fields, satellite, weather, operations and compliance.",
    "For any question about farm data, documents, invoices, fields, satellite performance, finance, compliance or actions, call the relevant tools before answering.",
    "Do not make generic recommendations when tool evidence is available. Tie answers to source-backed data and say exactly when a data source is missing.",
    "Never invent invoice totals, payment status, field observations, compliance status or document contents.",
    "If the user asks for changes, writes, reminders, finance entries, observations or records, return suggested_actions only. The UI will ask for confirmation.",
    "For finance_transaction suggested_actions, copy invoice evidence into payload.amount, payload.date, payload.counterparty, payload.invoiceRef, payload.description, payload.category and payload.notes. Do not leave amount as 0 when a tool result contains an invoice total.",
    "Use field_observation for field notes, scouting notes, sightings, weeds, pests, disease, black grass, waterlogging, lodging or 'I noticed...' requests.",
    "Use spray_record only when the user says a spray/application has already been done and gives or implies an application record. Do not use spray_record for possible future spraying or recommendations.",
    `Suggested action JSON examples. Use these canonical payload keys and populate all fields supported by evidence:\n${actionExamplesForPrompt()}`,
    "Final answers must be concise, practical and source-cited where sources exist.",
    `Mode: ${mode}. Report type: ${reportType || "none"}. Requested scope: ${scope}.`,
    `Allowed suggested action_type values: ${[...ACTION_TYPES].join(", ")}.`,
  ].join(" ");
}

async function executeAssistantTool(ctx, toolCall) {
  const name = toolCall?.function?.name;
  const tool = ASSISTANT_TOOL_SCHEMAS.find((schema) => schema.function.name === name);
  const handler = ASSISTANT_TOOL_HANDLERS[name];
  if (!tool || !handler) {
    return { error: `Unknown tool: ${name || "missing"}` };
  }
  const rawArgs = parseMaybeJson(toolCall.function.arguments, {});
  const args = validateToolArgs({ name }, rawArgs);
  try {
    return await handler(ctx, args);
  } catch (err) {
    ctx.toolLog.push({ name, error: err?.message || "tool failed" });
    return { tool: name, status: "error", error: err?.message || "tool failed" };
  }
}

async function preloadAssistantToolEvidence(ctx, message) {
  const text = String(message || "").toLowerCase();
  const results = [];
  results.push(await toolGetAvailableContext(ctx));
  if (/invoice|receipt|bill|owe|owed|pay|paid|payment|supplier/.test(text)) {
    const supplierMatch = /(?:from|to|pay|paid|owe|owed)\s+([a-z0-9 &.'-]{2,80})/i.exec(message);
    const supplier = supplierMatch?.[1]?.replace(/\b(a|an|the|awhile|while|ago|and|have|not|paid|it|how|much|do|i|need|to|them)\b/gi, " ").replace(/\s+/g, " ").trim() || message;
    results.push(await toolFindInvoiceOrPayable(ctx, { supplier, query: message, includePaid: false, limit: 12 }));
  }
  if (/field|ndvi|sar|satellite|perform|crop|soil|suggest|next step|what should/i.test(message)) {
    const fields = await loadFieldRows(ctx.admin, ctx.farmId);
    const matched = resolveFields(fields, { query: message });
    if (matched.length) {
      results.push(await toolGetFieldPerformance(ctx, { fieldId: matched[0].id, fieldName: matched[0].name, periodDays: 90 }));
    }
  }
  return results;
}

function stringifyToolResult(result) {
  return truncate(result, ASSISTANT_TOOL_RESULT_CHARS);
}

function parseFinalAssistantPayload(text) {
  const parsed = parseAssistantJson(text);
  if (!parsed || typeof parsed !== "object") {
    return { answer: text || "", suggested_actions: [], source_ids: [] };
  }
  return {
    answer: cleanString(parsed.answer || "", 12_000),
    suggested_actions: Array.isArray(parsed.suggested_actions) ? parsed.suggested_actions : [],
    source_ids: Array.isArray(parsed.source_ids) ? parsed.source_ids.map(String) : [],
  };
}

function isActionOnlyRequest(message) {
  const text = String(message || "").toLowerCase();
  return /\b(calendar|remind|reminder|diary|appointment)\b/.test(text)
    && /\b(add|put|create|set|schedule|book|make)\b/.test(text);
}

function isMetaQuestion(message) {
  const text = String(message || "").toLowerCase().trim();
  return /^(what are you|who are you|help|hello|hi|hey|good morning|good afternoon)\b/.test(text)
    || /^what can you do/i.test(text);
}

async function createAssistantResponse({ farmId, userId, message, scope = "whole_farm", mode = "chat", reportType = null, history = [], originId = null, canEdit = false }) {
  const admin = adminClient();
  const t0 = Date.now();
  const log = (label) => console.log(`  [assistant] ${label} +${Date.now() - t0}ms`);
  const retrievalText = retrievalTextFromHistory(message, history);
  const effectiveScope = normaliseScope(scope, retrievalText || message, mode, reportType);
  log(`scope=${effectiveScope}`);

  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI is not configured for the Tilth API. Set OPENAI_API_KEY in tilth-api/.env, then restart npm run tilth-api.");
  }

  // --- Fast path: action-only requests (calendar, reminders) ---
  if (mode === "chat" && canEdit && isActionOnlyRequest(retrievalText || message)) {
    const actions = deterministicSuggestedActions(message);
    if (actions.length) {
      log("fast-path: deterministic action");
      const validated = validateSuggestedActions(actions, farmId, userId, originId);
      // Single lightweight OpenAI call for a natural-language confirmation message
      const confirmMsg = await chatCompletionMessage([
        { role: "system", content: "You are Tilth's farm assistant. The user asked for a calendar/reminder action. A suggested action has been created for them to confirm. Write a brief friendly confirmation (1-2 sentences). Do not use markdown." },
        { role: "user", content: message },
        { role: "system", content: `Drafted action: ${JSON.stringify(actions[0])}` },
      ], { temperature: 0.3 });
      log("fast-path: OpenAI confirm done");
      const answer = confirmMsg?.message?.content || `I've drafted that for you — please confirm the action below.`;
      return {
        answer,
        suggestedActions: validated,
        sources: [],
        context: { scope: effectiveScope, requestedScope: scope, toolLog: [], fastPath: "deterministic_action" },
        toolLog: [],
      };
    }
  }

  // --- Fast path: identity / meta questions ---
  if (mode === "chat" && isMetaQuestion(retrievalText || message)) {
    log("fast-path: meta question");
    const meta = await chatCompletionMessage([
      { role: "system", content: assistantToolSystemPrompt({ mode, reportType, scope: effectiveScope }) },
      ...historyForPrompt(history),
      { role: "user", content: message },
      { role: "system", content: "Answer directly. Do not call tools. Return strict JSON with keys: answer, suggested_actions, source_ids. Do not include markdown fences." },
    ], { jsonMode: true, temperature: 0.2 });
    log("fast-path: OpenAI done");
    const parsed = parseFinalAssistantPayload(meta?.message?.content || "");
    return {
      answer: parsed.answer || "I am Tilth's integrated farm assistant — I can help with fields, satellite performance, records, finance, documents and compliance.",
      suggestedActions: validateSuggestedActions(parsed.suggested_actions, farmId, userId, originId),
      sources: [],
      context: { scope: effectiveScope, requestedScope: scope, toolLog: [], fastPath: "meta_question" },
      toolLog: [],
    };
  }

  const toolCtx = {
    admin,
    farmId,
    userId,
    canEdit,
    mode,
    reportType,
    sources: new Map(),
    toolLog: [],
  };
  try {
    const messages = [
      { role: "system", content: assistantToolSystemPrompt({ mode, reportType, scope: effectiveScope }) },
      ...historyForPrompt(history),
      { role: "user", content: `${mode === "report" ? `Report type: ${reportType || "farm_operations"}\n` : ""}${message}` },
    ];
    const preloadedEvidence = await preloadAssistantToolEvidence(toolCtx, retrievalText || message);
    log(`preload done (${preloadedEvidence.length} evidence items)`);
    if (preloadedEvidence.length) {
      messages.push({
        role: "system",
        content: `Validated preloaded Tilth tool evidence:\n${truncate(preloadedEvidence, MAX_CONTEXT_CHARS)}`,
      });
    }

    if (effectiveScope === "fields_satellite" && preloadedEvidence.length > 1) {
      messages.push({
        role: "system",
        content: [
          "Use the validated Tilth evidence above to answer now.",
          "Return strict JSON only with keys: answer, suggested_actions, source_ids.",
          "Keep the answer practical and focused on recent field performance, NDVI/SAR/weather evidence, missing data, and next actions.",
          "Do not include markdown fences.",
        ].join(" "),
      });
      const final = await chatCompletionMessage(messages, {
        jsonMode: true,
        toolChoice: "none",
        temperature: 0.1,
      });
      log("fields_satellite fast-path OpenAI done");
      const parsed = parseFinalAssistantPayload(final?.message?.content || "");
      const allSources = [...toolCtx.sources.values()];
      const selectedIds = new Set(parsed.source_ids.map(String));
      const sources = selectedIds.size
        ? allSources.filter((source) => selectedIds.has(String(source.id)) || selectedIds.has(String(source.document_id)))
        : allSources.slice(0, 14);
      return {
        answer: parsed.answer || "I checked the field's recent Tilth evidence but could not produce a grounded field-performance answer from the returned data.",
        suggestedActions: validateSuggestedActions(parsed.suggested_actions, farmId, userId, originId),
        sources,
        context: {
          scope: effectiveScope,
          requestedScope: scope,
          toolLog: toolCtx.toolLog,
          sourceCount: allSources.length,
          fastPath: "fields_satellite_preloaded",
        },
        toolLog: toolCtx.toolLog,
      };
    }

    const maxRounds = mode === "report" ? ASSISTANT_MAX_TOOL_ROUNDS : Math.min(ASSISTANT_MAX_TOOL_ROUNDS, 3);
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await chatCompletionMessage(messages, {
        tools: ASSISTANT_TOOL_SCHEMAS,
        toolChoice: "auto",
        temperature: mode === "report" ? 0.25 : 0.1,
      });
      log(`tool round ${round + 1} OpenAI done`);
      const assistantMessage = result?.message;
      if (!assistantMessage) break;
      const toolCalls = assistantMessage.tool_calls || [];
      if (!toolCalls.length) {
        messages.push({ role: "assistant", content: assistantMessage.content || "" });
        break;
      }
      messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        tool_calls: toolCalls,
      });
      for (const toolCall of toolCalls.slice(0, 4)) {
        const toolOutput = await executeAssistantTool(toolCtx, toolCall);
        log(`  tool ${toolCall.function?.name} done`);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function?.name,
          content: stringifyToolResult(toolOutput),
        });
      }
    }

    messages.push({
      role: "system",
      content: [
        "Return strict JSON only with keys: answer, suggested_actions, source_ids.",
        "source_ids must be ids from tool results in this turn.",
        "If a requested value was not found, say which tool/source was checked and what was missing.",
        "Do not include markdown fences.",
      ].join(" "),
    });
    const final = await chatCompletionMessage(messages, {
      jsonMode: true,
      toolChoice: "none",
      temperature: mode === "report" ? 0.25 : 0.1,
    });
    log("final OpenAI done");
    const parsed = parseFinalAssistantPayload(final?.message?.content || "");
    const allSources = [...toolCtx.sources.values()];
    const selectedIds = new Set(parsed.source_ids.map(String));
    const sources = selectedIds.size
      ? allSources.filter((source) => selectedIds.has(String(source.id)) || selectedIds.has(String(source.document_id)))
      : allSources.slice(0, 14);
    const suggestedActions = validateSuggestedActions(parsed.suggested_actions, farmId, userId, originId);
    const answer = parsed.answer || "I checked the available Tilth tools but could not produce a grounded answer from the returned data.";
    return {
      answer,
      suggestedActions,
      sources,
      context: {
        scope: effectiveScope,
        requestedScope: scope,
        toolLog: toolCtx.toolLog,
        sourceCount: allSources.length,
      },
      toolLog: toolCtx.toolLog,
    };
  } catch (err) {
    throw new Error(`OpenAI assistant request failed: ${err?.message || "Assistant model request failed."}`);
  }
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
  if (auth.error) {
    console.log(`  [chat] auth failed: ${auth.error.status} ${JSON.stringify(auth.error.body)}`);
    return json(res, auth.error.status, auth.error.body);
  }
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const message = String(body.message || "").trim();
  const scope = String(body.scope || "whole_farm");
  console.log(`  [chat] user=${auth.userId?.slice(0, 8)} farm=${farmId?.slice(0, 8)} msg="${message.slice(0, 60)}" scope=${scope}`);
  if (!message) return json(res, 400, { error: "message is required" });
  if (!(await userCanReadFarm(auth.userId, farmId))) {
    console.log(`  [chat] access denied for user=${auth.userId} farm=${farmId}`);
    return json(res, 403, { error: "farm not found or access denied" });
  }
  const canEdit = await userCanEditFarm(auth.userId, farmId);
  const admin = adminClient();
  const sessionId = await ensureSession(admin, farmId, auth.userId, message, body.chatSessionId || null, scope);
  const history = await loadSessionHistory(admin, farmId, sessionId);
  const result = await createAssistantResponse({ farmId, userId: auth.userId, message, scope, history, originId: sessionId, canEdit });
  let persistedActions = [];
  let actionWarning = "";
  if (canEdit && result.suggestedActions.length) {
    const persisted = await persistSuggestedActions(admin, result.suggestedActions, "chat");
    persistedActions = persisted.actions;
    actionWarning = persisted.warning;
  }
  const answer = actionWarning ? `${result.answer}\n\nNote: ${actionWarning}` : result.answer;
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
      content: answer,
      sources: result.sources,
      suggested_actions: persistedActions,
      metadata: { scope, canEdit, actionWarning: actionWarning || null },
    },
  ];
  const saved = await admin.from("assistant_chat_messages").insert(rows);
  if (saved.error) throw new Error(saved.error.message);
  await admin
    .from("assistant_chat_sessions")
    .update({ updated_at: new Date().toISOString(), scope: result.context.scope })
    .eq("id", sessionId)
    .eq("farm_id", farmId);
  return json(res, 200, {
    chatSessionId: sessionId,
    answer,
    sources: result.sources,
    suggestedActions: persistedActions,
    canEdit,
    warnings: actionWarning ? [actionWarning] : [],
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
    canEdit,
  });
  let persistedActions = [];
  let actionWarning = "";
  if (canEdit && result.suggestedActions.length) {
    const persisted = await persistSuggestedActions(admin, result.suggestedActions, "report");
    persistedActions = persisted.actions;
    actionWarning = persisted.warning;
  }
  const answer = actionWarning ? `${result.answer}\n\nNote: ${actionWarning}` : result.answer;
  const saved = await admin
    .from("assistant_generated_reports")
    .insert({
      farm_id: farmId,
      user_id: auth.userId,
      report_type: reportType,
      title: body.title || reportType.replace(/_/g, " "),
      prompt,
      content: answer,
      sources: result.sources,
      suggested_actions: persistedActions,
      metadata: { scope, actionWarning: actionWarning || null },
    })
    .select("*")
    .single();
  if (saved.error) throw new Error(saved.error.message);
  return json(res, 200, { report: saved.data, answer, sources: result.sources, suggestedActions: persistedActions, warnings: actionWarning ? [actionWarning] : [] });
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

async function updateSuggestedActionStatus(req, res, json) {
  const auth = await authenticatedUser(req);
  if (auth.error) return json(res, auth.error.status, auth.error.body);
  const body = await readJsonBody(req);
  const farmId = String(body.farmId || "");
  const actionId = String(body.actionId || body.id || "");
  const status = String(body.status || "");
  if (!actionId) return json(res, 400, { error: "actionId is required" });
  if (!["applied", "dismissed"].includes(status)) {
    return json(res, 400, { error: "status must be applied or dismissed" });
  }
  if (!(await userCanEditFarm(auth.userId, farmId))) {
    return json(res, 403, { error: "farm not found or access denied" });
  }

  const now = new Date().toISOString();
  const patch = status === "applied"
    ? { status, applied_at: now, applied_by: auth.userId, updated_at: now }
    : { status, dismissed_at: now, dismissed_by: auth.userId, updated_at: now };
  const updated = await adminClient()
    .from("assistant_suggested_actions")
    .update(patch)
    .eq("id", actionId)
    .eq("farm_id", farmId)
    .select("*")
    .single();
  if (updated.error) throw new Error(updated.error.message);
  return json(res, 200, { action: updated.data });
}

export async function handlePlatformAssistantRoute(req, res, url, json) {
  const { pathname } = url;
  const t0 = Date.now();
  const tag = `[platform-assistant ${req.method} ${pathname}]`;
  try {
    if (req.method === "POST" && pathname === "/api/platform-assistant/chat") {
      console.log(`${tag} start`);
      await chat(req, res, json);
      console.log(`${tag} done ${Date.now() - t0}ms`);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/platform-assistant/reports/generate") {
      console.log(`${tag} start`);
      await generateReport(req, res, json);
      console.log(`${tag} done ${Date.now() - t0}ms`);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/platform-assistant/actions/status") {
      console.log(`${tag} start`);
      await updateSuggestedActionStatus(req, res, json);
      console.log(`${tag} done ${Date.now() - t0}ms`);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/platform-assistant/context/status") {
      await contextStatus(req, res, json, url);
      return true;
    }
  } catch (err) {
    console.error(`${tag} error after ${Date.now() - t0}ms:`, err?.message || err);
    json(res, 500, { error: err?.message || "platform assistant request failed" });
    return true;
  }
  return false;
}

export const __platformAssistantTestHooks = {
  ACTION_TYPES,
  ACTION_EXAMPLE_CATALOG,
  ASSISTANT_TOOL_SCHEMAS,
  ASSISTANT_TOOL_HANDLERS,
  actionExamplesForPrompt,
  assistantToolSystemPrompt,
  validateSuggestedActions,
  persistableSuggestedActions,
  persistSuggestedActions,
  validateToolArgs,
  parseFinalAssistantPayload,
  normaliseSearchText,
};

import { REFERENCE_MARKET_ROWS, referenceRows } from "./referenceData.mjs";

const MARKET_CACHE_TTL_MS = Math.max(60_000, Number(process.env.MARKET_CACHE_TTL_MS || 900_000));
const MARKET_PROVIDER = (process.env.MARKET_PROVIDER || "public").trim().toLowerCase();
const MARKET_API_URL = (process.env.MARKET_API_URL || "").trim();
const MARKET_API_KEY = (process.env.MARKET_API_KEY || "").trim();
const MARKET_PUBLIC_TIMEOUT_MS = Math.max(2000, Number(process.env.MARKET_PUBLIC_TIMEOUT_MS || 8000));

let cache = null;

function normalizeMarket(row, fallbackId = "") {
  const id = String(row.id || fallbackId || row.commodity || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id || !row.commodity || row.price == null) return null;
  const price = Number(row.price);
  if (!Number.isFinite(price)) return null;
  return {
    id,
    market: String(row.market || "other").toLowerCase(),
    commodity: String(row.commodity),
    price,
    unit: String(row.unit || row.basisUnit || "£/t"),
    currency: String(row.currency || "GBP"),
    basis: row.basis ? String(row.basis) : "",
    region: row.region ? String(row.region) : "UK",
    source: row.source ? String(row.source) : "Market feed",
    sourceUrl: row.sourceUrl ? String(row.sourceUrl) : "",
    updatedAt: row.updatedAt || new Date().toISOString(),
    trend: ["up", "down", "flat"].includes(row.trend) ? row.trend : "flat",
    confidence: row.confidence || "high",
    stale: Boolean(row.stale),
  };
}

function mergeRows(primaryRows, fallbackRows) {
  const byId = new Map();
  for (const row of fallbackRows) byId.set(row.id, row);
  for (const row of primaryRows) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => {
    const marketOrder = ["cereals", "livestock", "dairy", "inputs", "other"];
    const ma = marketOrder.indexOf(a.market);
    const mb = marketOrder.indexOf(b.market);
    if (ma !== mb) return (ma === -1 ? 99 : ma) - (mb === -1 ? 99 : mb);
    return a.commodity.localeCompare(b.commodity);
  });
}

async function fetchJsonFeed() {
  if (!MARKET_API_URL) return { rows: [], sources: [], provider: "none" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MARKET_PUBLIC_TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json" };
    if (MARKET_API_KEY) headers.Authorization = `Bearer ${MARKET_API_KEY}`;
    const res = await fetch(MARKET_API_URL, { headers, signal: ctrl.signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `market feed returned ${res.status}`);
    const rawRows = Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [];
    const rows = rawRows.map((row, i) => normalizeMarket(row, `feed-${i}`)).filter(Boolean);
    return {
      rows,
      sources: [{
        id: "configured-json",
        label: body.provider || "Configured market feed",
        status: rows.length ? "live" : "empty",
        updatedAt: body.updatedAt || new Date().toISOString(),
        url: MARKET_API_URL,
      }],
      provider: "configured-json",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probePublicSources() {
  const sources = [
    { id: "ahdb-prices", label: "AHDB markets and prices", url: "https://ahdb.org.uk/prices-stats" },
    { id: "ahdb-fertiliser", label: "AHDB GB fertiliser prices", url: "https://ahdb.org.uk/GB-fertiliser-prices" },
  ];
  const checked = [];
  await Promise.all(sources.map(async (source) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MARKET_PUBLIC_TIMEOUT_MS);
    try {
      const res = await fetch(source.url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "FangornTilthMarket/1.0 (+market data freshness probe)",
        },
        signal: ctrl.signal,
      });
      checked.push({
        ...source,
        status: res.ok ? "reachable" : "error",
        statusCode: res.status,
        updatedAt: res.headers.get("date") || new Date().toISOString(),
      });
    } catch (err) {
      checked.push({
        ...source,
        status: "error",
        error: err?.message || "source unreachable",
        updatedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timer);
    }
  }));
  return checked;
}

export async function getMarketPrices({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cache && now - cache.cachedAt < MARKET_CACHE_TTL_MS) {
    return { ...cache.body, cache: "HIT" };
  }

  const fallback = referenceRows({ stale: true });
  const errors = [];
  let feed = { rows: [], sources: [], provider: "reference" };
  if (MARKET_PROVIDER !== "reference") {
    try {
      feed = await fetchJsonFeed();
    } catch (err) {
      errors.push(err?.message || "configured market feed failed");
    }
  }

  let publicSources = [];
  try {
    publicSources = await probePublicSources();
  } catch (err) {
    errors.push(err?.message || "public source probe failed");
  }

  const rows = mergeRows(feed.rows, fallback);
  const liveCount = rows.filter((row) => !row.stale && row.confidence !== "reference").length;
  const body = {
    ok: true,
    provider: feed.provider || MARKET_PROVIDER,
    mode: liveCount ? "live" : "reference",
    generatedAt: new Date().toISOString(),
    ttlMs: MARKET_CACHE_TTL_MS,
    rows,
    sources: [...feed.sources, ...publicSources],
    errors,
    configuredRows: feed.rows.length,
    referenceRows: REFERENCE_MARKET_ROWS.length,
  };
  cache = { cachedAt: now, body };
  return { ...body, cache: "MISS" };
}

export function marketStatus() {
  return {
    provider: MARKET_PROVIDER,
    hasConfiguredFeed: Boolean(MARKET_API_URL),
    hasApiKey: Boolean(MARKET_API_KEY),
    cacheTtlMs: MARKET_CACHE_TTL_MS,
    cached: Boolean(cache),
    cachedAt: cache ? new Date(cache.cachedAt).toISOString() : null,
  };
}

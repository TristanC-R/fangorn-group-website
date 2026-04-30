import { getTilthApiBase } from "./tilthApi.js";

export const FALLBACK_MARKET_ROWS = [
  { id: "feed-wheat", market: "cereals", commodity: "Feed Wheat", price: 190, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "milling-wheat", market: "cereals", commodity: "Milling Wheat", price: 228, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "feed-barley", market: "cereals", commodity: "Feed Barley", price: 168, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "malting-barley", market: "cereals", commodity: "Malting Barley", price: 195, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "osr", market: "cereals", commodity: "Oilseed Rape", price: 372, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "beans", market: "cereals", commodity: "Beans", price: 225, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "deadweight-cattle", market: "livestock", commodity: "GB deadweight cattle", price: 520, unit: "p/kg", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "deadweight-lamb", market: "livestock", commodity: "GB deadweight lamb", price: 640, unit: "p/kg", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "deadweight-pigs", market: "livestock", commodity: "GB deadweight pigs", price: 215, unit: "p/kg", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "farmgate-milk", market: "dairy", commodity: "Farmgate milk", price: 39, unit: "p/litre", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "input-ammonium-nitrate", market: "inputs", commodity: "Ammonium Nitrate (34.5%N)", price: 330, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "input-urea", market: "inputs", commodity: "Urea (46%N)", price: 370, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "input-dap", market: "inputs", commodity: "DAP (18-46-0)", price: 520, unit: "£/t", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
  { id: "input-red-diesel", market: "inputs", commodity: "Red diesel", price: 0.72, unit: "£/L", source: "Local reference", trend: "flat", stale: true, confidence: "reference" },
];

export async function fetchMarketPrices({ refresh = false, signal } = {}) {
  const apiBase = getTilthApiBase();
  if (!apiBase) {
    return {
      ok: false,
      mode: "offline",
      rows: FALLBACK_MARKET_ROWS,
      sources: [],
      error: "tilth-api not reachable",
    };
  }
  const suffix = refresh ? "?refresh=1" : "";
  const res = await fetch(`${apiBase}/api/market/prices${suffix}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Could not load market prices.");
  return {
    ...body,
    rows: Array.isArray(body.rows) && body.rows.length ? body.rows : FALLBACK_MARKET_ROWS,
  };
}

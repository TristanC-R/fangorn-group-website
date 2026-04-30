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
import { useLocalValue } from "../state/localStore.js";
import { cancelFarmTaskBySourceKey, titleWithSubject, upsertFarmTask } from "../../lib/farmTaskAutomation.js";
import { FALLBACK_MARKET_ROWS, fetchMarketPrices } from "../../lib/marketData.js";

const TABS = ["Prices", "Sales", "Purchases"];

const uid = () =>
  crypto.randomUUID?.() ||
  Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const fmtCurrency = (v) =>
  v == null || !Number.isFinite(v) ? "—" : `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(d); }
};

const fmtMarketValue = (value, unit = "") => {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (unit.startsWith("p/")) return n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return `£${n.toLocaleString("en-GB", { minimumFractionDigits: n < 10 ? 2 : 0, maximumFractionDigits: 2 })}`;
};

const thisYear = () => new Date().getFullYear();

const TREND_ARROWS = { up: "▲", down: "▼", flat: "▸" };
const TREND_COLORS = { up: brand.ok, down: brand.danger, flat: brand.muted };
const MARKET_GROUPS = [
  { id: "cereals", label: "Cereals & oilseeds" },
  { id: "livestock", label: "Livestock" },
  { id: "dairy", label: "Dairy" },
  { id: "inputs", label: "Inputs" },
];

const SALE_UNITS = ["t", "head", "L", "kg", "bales"];
const PURCHASE_CATEGORIES = ["seed", "chemical", "fertiliser", "fuel", "feed", "machinery", "contractor", "other"];
const PURCHASE_UNITS = ["t", "L", "kg", "units", "ha"];

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
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

function PricesTab({ farmId }) {
  const [prices, setPrices] = useLocalValue("market_prices", farmId, {});
  const [sales] = useLocalValue("market_sales", farmId, []);
  const [purchases] = useLocalValue("market_purchases", farmId, []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [marketData, setMarketData] = useState({
    rows: FALLBACK_MARKET_ROWS,
    sources: [],
    mode: "offline",
    cache: "LOCAL",
  });
  const [watchlist, setWatchlist] = useLocalValue("market_watchlist", farmId, []);
  const [watchDraft, setWatchDraft] = useState({ marketId: "feed-wheat", target: "", direction: "above" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadLivePrices = async ({ refresh = false } = {}) => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchMarketPrices({ refresh });
      setMarketData(data);
    } catch (err) {
      setError(err?.message || "Could not load live prices.");
      setMarketData((prev) => ({ ...prev, rows: prev.rows?.length ? prev.rows : FALLBACK_MARKET_ROWS }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    fetchMarketPrices({ signal: ctrl.signal })
      .then((data) => {
        if (!cancelled) {
          setMarketData(data);
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled && err.name !== "AbortError") {
          setError(err?.message || "Could not load live prices.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);

  const realisedSales = useMemo(() => {
    const map = new Map();
    for (const sale of sales) {
      const key = FALLBACK_MARKET_ROWS.find((row) =>
        row.market !== "inputs" && String(sale.crop || "").toLowerCase().includes(row.commodity.toLowerCase().split(" ")[0])
      )?.id;
      const qty = Number(sale.qty);
      const price = Number(sale.pricePerUnit);
      if (!key || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) continue;
      const prev = map.get(key) || { total: 0, qty: 0 };
      prev.total += qty * price;
      prev.qty += qty;
      map.set(key, prev);
    }
    return map;
  }, [sales]);

  const realisedPurchases = useMemo(() => {
    const map = new Map();
    for (const purchase of purchases) {
      const key = FALLBACK_MARKET_ROWS.find((row) =>
        row.market === "inputs" && String(purchase.product || "").toLowerCase().includes(row.commodity.split(" ")[0].toLowerCase())
      )?.id;
      const qty = Number(purchase.qty);
      const price = Number(purchase.pricePerUnit);
      if (!key || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) continue;
      const prev = map.get(key) || { total: 0, qty: 0 };
      prev.total += qty * price;
      prev.qty += qty;
      map.set(key, prev);
    }
    return map;
  }, [purchases]);

  const marketRows = useMemo(() => {
    const rows = marketData.rows?.length ? marketData.rows : FALLBACK_MARKET_ROWS;
    return rows.map((row) => {
      const local = prices[row.id];
      const realised = row.market === "inputs" ? realisedPurchases.get(row.id) : realisedSales.get(row.id);
      const realisedPrice = realised ? realised.total / realised.qty : null;
      return {
        ...row,
        displayPrice: local?.price ?? row.price,
        localPrice: local?.price ?? null,
        realisedPrice,
        sourceStatus: local?.price != null ? "Local override" : row.stale || row.confidence === "reference" ? "Reference" : "Live",
      };
    });
  }, [marketData.rows, prices, realisedPurchases, realisedSales]);

  const startEdit = () => {
    const d = {};
    marketRows.forEach((row) => { d[row.id] = row.displayPrice; });
    setDraft(d);
    setEditing(true);
  };

  const saveEdit = () => {
    const next = { ...prices };
    marketRows.forEach((row) => {
      const v = parseFloat(draft[row.id]);
      if (Number.isFinite(v)) {
        next[row.id] = { price: v, note: "Your quote", updatedAt: new Date().toISOString() };
      }
    });
    setPrices(next);
    setEditing(false);
  };

  const resetPrices = () => {
    setPrices({});
    setEditing(false);
  };

  const addWatch = () => {
    const row = marketRows.find((r) => r.id === watchDraft.marketId);
    const target = Number(watchDraft.target);
    if (!row || !Number.isFinite(target)) return;
    setWatchlist((prev) => [
      {
        id: uid(),
        marketId: row.id,
        commodity: row.commodity,
        target,
        direction: watchDraft.direction,
        unit: row.unit,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setWatchDraft({ marketId: row.id, target: "", direction: watchDraft.direction });
  };

  const removeWatch = (id) => setWatchlist((prev) => prev.filter((w) => w.id !== id));

  const thStyle = {
    textAlign: "left", padding: "6px 8px",
    fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em",
    textTransform: "uppercase", color: brand.muted,
  };
  const tdStyle = { padding: "6px 8px", fontFamily: fonts.sans, fontSize: 12.5 };

  const statusTone = marketData.mode === "live" ? "ok" : error ? "danger" : "warn";

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <Kicker>Live UK market prices</Kicker>
          <Body size="sm" style={{ color: brand.muted, marginTop: 2 }}>
            Market feed: {marketData.mode || "offline"} · cache {marketData.cache || "local"}
            {marketData.generatedAt ? ` · updated ${fmtDate(marketData.generatedAt)}` : ""}
          </Body>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {editing ? (
            <>
              <Button variant="primary" size="sm" onClick={saveEdit}>Save</Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={resetPrices}>Reset defaults</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => loadLivePrices({ refresh: true })} disabled={loading}>
                {loading ? "Refreshing..." : "Refresh live"}
              </Button>
              <Button variant="secondary" size="sm" onClick={startEdit}>Add quotes</Button>
            </>
          )}
        </div>
      </div>

      <Card padding={12} style={{ marginBottom: 12, border: `1px solid ${statusTone === "ok" ? brand.ok : statusTone === "danger" ? brand.danger : brand.warn}55` }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Pill tone={statusTone}>{marketData.mode === "live" ? "Live feed" : error ? "Feed unavailable" : "Reference fallback"}</Pill>
          <Body size="sm" style={{ color: brand.muted }}>
            {error || "Prices show source and freshness. Your quotes and realised farm prices are shown separately from market data."}
          </Body>
        </div>
        {marketData.sources?.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {marketData.sources.map((source) => (
              <a key={source.id || source.label} href={source.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <Pill tone={source.status === "reachable" || source.status === "live" ? "ok" : "warn"} style={{ fontSize: 9 }}>
                  {source.label || source.id}: {source.status || "checked"}
                </Pill>
              </a>
            ))}
          </div>
        ) : null}
      </Card>

      {MARKET_GROUPS.map((group) => {
        const rows = marketRows.filter((row) => row.market === group.id);
        if (!rows.length) return null;
        return (
          <Card key={group.id} padding={0} style={{ marginBottom: 14, overflow: "hidden" }}>
            <div style={{ padding: "10px 12px", borderBottom: `1px solid ${brand.border}`, background: brand.bgSection }}>
              <Kicker>{group.label}</Kicker>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${brand.border}` }}>
                    <th style={thStyle}>Commodity</th>
                    <th style={thStyle}>Market price</th>
                    <th style={thStyle}>Your quote</th>
                    <th style={thStyle}>Farm average</th>
                    <th style={thStyle}>Trend</th>
                    <th style={thStyle}>Source</th>
                    <th style={thStyle}>Freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} style={{ borderBottom: `1px solid ${brand.border}` }}>
                      <td style={{ ...tdStyle, fontWeight: 500, color: brand.forest }}>
                        {row.commodity}
                        {row.basis ? <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted, marginTop: 2 }}>{row.basis}</div> : null}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: 600 }}>
                          {fmtMarketValue(row.price, row.unit)}
                        </span>
                        <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}> {row.unit}</span>
                      </td>
                      <td style={tdStyle}>
                        {editing ? (
                          <input
                            type="number"
                            step="0.01"
                            value={draft[row.id] ?? ""}
                            onChange={(e) => setDraft((p) => ({ ...p, [row.id]: e.target.value }))}
                            style={{ ...inputStyle, width: 90, padding: "5px 8px", fontSize: 12 }}
                          />
                        ) : row.localPrice != null ? (
                          <span style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: 600 }}>{fmtMarketValue(row.localPrice, row.unit)}</span>
                        ) : (
                          <span style={{ color: brand.muted }}>—</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: fonts.mono, fontSize: 11, color: row.realisedPrice ? brand.forest : brand.muted }}>
                        {row.realisedPrice ? `${fmtMarketValue(row.realisedPrice, row.unit)} ${row.unit}` : "—"}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: TREND_COLORS[row.trend] || brand.muted, fontWeight: 600, fontSize: 13 }}>
                          {TREND_ARROWS[row.trend] || TREND_ARROWS.flat}{" "}
                        </span>
                        <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted, textTransform: "capitalize" }}>
                          {row.trend || "flat"}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                        {row.source || "Market feed"}
                      </td>
                      <td style={tdStyle}>
                        <Pill tone={row.sourceStatus === "Live" ? "ok" : row.sourceStatus === "Local override" ? "info" : "warn"} style={{ fontSize: 9 }}>
                          {row.sourceStatus}
                        </Pill>
                        <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted, marginTop: 3 }}>
                          {row.updatedAt ? fmtDate(row.updatedAt) : "No timestamp"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Pill tone="neutral" style={{ fontSize: 9 }}>
          Live feed ready
        </Pill>
        <Body size="sm" style={{ color: brand.muted, maxWidth: 480 }}>
          A configured market API can populate these rows directly. Without one, Tilth keeps
          public/reference rows visible and clearly labels them, while your quotes and realised
          farm prices remain available for decisions.
        </Body>
      </div>

      <Card padding={14} style={{ marginTop: 14 }}>
        <Kicker style={{ marginBottom: 8 }}>Watchlist</Kicker>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 110px 100px auto", gap: 8, alignItems: "end", marginBottom: 10 }}>
          <div>
            <FieldLabel>Market</FieldLabel>
            <select value={watchDraft.marketId} onChange={(e) => setWatchDraft((p) => ({ ...p, marketId: e.target.value }))} style={{ ...inputStyle, fontSize: 12 }}>
              {marketRows.map((row) => <option key={row.id} value={row.id}>{row.commodity}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>Target</FieldLabel>
            <input type="number" value={watchDraft.target} onChange={(e) => setWatchDraft((p) => ({ ...p, target: e.target.value }))} style={{ ...inputStyle, fontSize: 12 }} />
          </div>
          <div>
            <FieldLabel>When</FieldLabel>
            <select value={watchDraft.direction} onChange={(e) => setWatchDraft((p) => ({ ...p, direction: e.target.value }))} style={{ ...inputStyle, fontSize: 12 }}>
              <option value="above">Above</option>
              <option value="below">Below</option>
            </select>
          </div>
          <Button variant="secondary" size="sm" onClick={addWatch} disabled={!watchDraft.target}>Add watch</Button>
        </div>
        {watchlist.length ? (
          <div style={{ display: "grid", gap: 6 }}>
            {watchlist.map((watch) => {
              const row = marketRows.find((r) => r.id === watch.marketId);
              const hit = row && (watch.direction === "above" ? row.displayPrice >= watch.target : row.displayPrice <= watch.target);
              return (
                <Row key={watch.id} style={{ padding: "7px 9px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <div>
                      <div style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest, fontWeight: 600 }}>{watch.commodity}</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>
                        Alert when {watch.direction} {fmtMarketValue(watch.target, watch.unit)} {watch.unit}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <Pill tone={hit ? "ok" : "neutral"} style={{ fontSize: 9 }}>{hit ? "Target hit" : "Watching"}</Pill>
                      <button type="button" onClick={() => removeWatch(watch.id)} style={{ background: "transparent", border: "none", cursor: "pointer", color: brand.muted, fontFamily: fonts.mono }}>×</button>
                    </div>
                  </div>
                </Row>
              );
            })}
          </div>
        ) : (
          <Body size="sm" style={{ color: brand.muted }}>Add target prices for crops, livestock, milk or inputs. These are local watches for now; notification delivery can plug into the existing task/notification layer later.</Body>
        )}
      </Card>
    </>
  );
}

const EMPTY_SALE = {
  date: "", crop: "", qty: "", unit: "t", pricePerUnit: "",
  buyer: "", contractRef: "", deliveryDate: "", notes: "",
};

function SalesTab({ farmId }) {
  const [sales, setSales] = useLocalValue("market_sales", farmId, []);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(EMPTY_SALE);

  const sorted = useMemo(
    () => [...sales].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [sales],
  );

  const yearSales = useMemo(() => {
    const yr = thisYear();
    return sorted.filter((s) => s.date && new Date(s.date).getFullYear() === yr);
  }, [sorted]);

  const totalThisYear = yearSales.reduce((acc, s) => acc + (s.total || 0), 0);

  const byCrop = useMemo(() => {
    const map = {};
    yearSales.forEach((s) => {
      const k = s.crop || "Other";
      map[k] = (map[k] || 0) + (s.total || 0);
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [yearSales]);

  const setField = (k, v) => setDraft((p) => ({ ...p, [k]: v }));

  const addSale = () => {
    const qty = parseFloat(draft.qty) || 0;
    const ppu = parseFloat(draft.pricePerUnit) || 0;
    const id = uid();
    const entry = {
      id, date: draft.date, crop: draft.crop, qty, unit: draft.unit,
      pricePerUnit: ppu, total: qty * ppu, buyer: draft.buyer,
      contractRef: draft.contractRef, deliveryDate: draft.deliveryDate, notes: draft.notes,
      createdAt: new Date().toISOString(),
    };
    setSales((prev) => [...prev, entry]);
    if (entry.deliveryDate) {
      upsertFarmTask(farmId, {
        sourceKey: `market_sale:${id}:delivery`,
        source: "market_sale",
        sourceId: id,
        title: titleWithSubject("Deliver sale", `${entry.crop} to ${entry.buyer || "buyer"}`),
        dueDate: entry.deliveryDate,
        category: "market",
        priority: "high",
        notes: "Automatically created from a market sale delivery date.",
      });
    }
    setDraft(EMPTY_SALE);
    setShowForm(false);
  };

  const removeSale = (id) => {
    if (!window.confirm("Delete this sale record?")) return;
    setSales((prev) => prev.filter((s) => s.id !== id));
    cancelFarmTaskBySourceKey(farmId, `market_sale:${id}:delivery`);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <Kicker>Sales log</Kicker>
        <Button variant={showForm ? "ghost" : "primary"} size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add sale"}
        </Button>
      </div>

      {showForm && (
        <Card padding={14} style={{ marginBottom: 14 }}>
          <Kicker style={{ marginBottom: 10 }}>New sale</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <FieldLabel>Date</FieldLabel>
              <input type="date" value={draft.date} onChange={(e) => setField("date", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Crop / product</FieldLabel>
              <input value={draft.crop} onChange={(e) => setField("crop", e.target.value)} placeholder="e.g. Feed Wheat" style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Quantity</FieldLabel>
              <input type="number" step="0.01" value={draft.qty} onChange={(e) => setField("qty", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Unit</FieldLabel>
              <select value={draft.unit} onChange={(e) => setField("unit", e.target.value)} style={{ ...inputStyle, fontSize: 13 }}>
                {SALE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>Price per unit (£)</FieldLabel>
              <input type="number" step="0.01" value={draft.pricePerUnit} onChange={(e) => setField("pricePerUnit", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Total (£)</FieldLabel>
              <div style={{ ...inputStyle, fontSize: 13, background: brand.bgSection, color: brand.forest, fontWeight: 600 }}>
                {fmtCurrency((parseFloat(draft.qty) || 0) * (parseFloat(draft.pricePerUnit) || 0))}
              </div>
            </div>
            <div>
              <FieldLabel>Buyer / merchant</FieldLabel>
              <input value={draft.buyer} onChange={(e) => setField("buyer", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Contract ref</FieldLabel>
              <input value={draft.contractRef} onChange={(e) => setField("contractRef", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Delivery date</FieldLabel>
              <input type="date" value={draft.deliveryDate} onChange={(e) => setField("deliveryDate", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Notes</FieldLabel>
              <input value={draft.notes} onChange={(e) => setField("notes", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" size="sm" onClick={addSale} disabled={!draft.date || !draft.crop || !draft.qty}>
              Save sale
            </Button>
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Total sales {thisYear()}</Kicker>
          <div style={{ fontFamily: fonts.serif, fontSize: 26, color: brand.forest, letterSpacing: "-0.02em" }}>
            {fmtCurrency(totalThisYear)}
          </div>
          <Body size="sm" style={{ marginTop: 4 }}>{yearSales.length} sale{yearSales.length === 1 ? "" : "s"} recorded</Body>
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>By crop {thisYear()}</Kicker>
          {byCrop.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              {byCrop.map(([crop, total]) => (
                <div key={crop} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest, fontWeight: 500 }}>{crop}</span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 11, color: brand.muted }}>{fmtCurrency(total)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Body size="sm" style={{ color: brand.muted }}>No sales this year</Body>
          )}
        </Card>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          kicker="Sales"
          title="No sales recorded"
          description="Use 'Add sale' to log grain sales, livestock sales, or other farm outputs."
        />
      ) : (
        <Card padding={0} style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${brand.border}` }}>
                  {["Date", "Crop", "Qty", "Price/unit", "Total", "Buyer", "Ref", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${brand.border}` }}>
                    <td style={{ padding: "6px 8px", color: brand.forest }}>{fmtDate(s.date)}</td>
                    <td style={{ padding: "6px 8px", fontWeight: 500, color: brand.forest }}>{s.crop}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{s.qty} {s.unit}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>£{(s.pricePerUnit || 0).toFixed(2)}/{s.unit}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11, fontWeight: 600 }}>{fmtCurrency(s.total)}</td>
                    <td style={{ padding: "6px 8px", color: brand.bodySoft }}>{s.buyer || "—"}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>{s.contractRef || "—"}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <button
                        type="button"
                        onClick={() => removeSale(s.id)}
                        title="Delete"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: brand.muted, fontFamily: fonts.mono, fontSize: 12, padding: "2px 4px" }}
                      >
                        ×
                      </button>
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

const EMPTY_PURCHASE = {
  date: "", product: "", category: "fertiliser", qty: "", unit: "t",
  pricePerUnit: "", supplier: "", invoiceRef: "", notes: "",
};

function PurchasesTab({ farmId }) {
  const [purchases, setPurchases] = useLocalValue("market_purchases", farmId, []);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(EMPTY_PURCHASE);

  const sorted = useMemo(
    () => [...purchases].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [purchases],
  );

  const yearPurchases = useMemo(() => {
    const yr = thisYear();
    return sorted.filter((p) => p.date && new Date(p.date).getFullYear() === yr);
  }, [sorted]);

  const totalThisYear = yearPurchases.reduce((acc, p) => acc + (p.total || 0), 0);

  const byCategory = useMemo(() => {
    const map = {};
    yearPurchases.forEach((p) => {
      const k = p.category || "other";
      map[k] = (map[k] || 0) + (p.total || 0);
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [yearPurchases]);

  const setField = (k, v) => setDraft((p) => ({ ...p, [k]: v }));

  const addPurchase = () => {
    const qty = parseFloat(draft.qty) || 0;
    const ppu = parseFloat(draft.pricePerUnit) || 0;
    const entry = {
      id: uid(), date: draft.date, product: draft.product, category: draft.category,
      qty, unit: draft.unit, pricePerUnit: ppu, total: qty * ppu,
      supplier: draft.supplier, invoiceRef: draft.invoiceRef, notes: draft.notes,
      createdAt: new Date().toISOString(),
    };
    setPurchases((prev) => [...prev, entry]);
    setDraft(EMPTY_PURCHASE);
    setShowForm(false);
  };

  const removePurchase = (id) => {
    if (!window.confirm("Delete this purchase record?")) return;
    setPurchases((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <Kicker>Purchase log</Kicker>
        <Button variant={showForm ? "ghost" : "primary"} size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add purchase"}
        </Button>
      </div>

      {showForm && (
        <Card padding={14} style={{ marginBottom: 14 }}>
          <Kicker style={{ marginBottom: 10 }}>New purchase</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <FieldLabel>Date</FieldLabel>
              <input type="date" value={draft.date} onChange={(e) => setField("date", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Product</FieldLabel>
              <input value={draft.product} onChange={(e) => setField("product", e.target.value)} placeholder="e.g. Ammonium Nitrate" style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Category</FieldLabel>
              <select value={draft.category} onChange={(e) => setField("category", e.target.value)} style={{ ...inputStyle, fontSize: 13 }}>
                {PURCHASE_CATEGORIES.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>Quantity</FieldLabel>
              <input type="number" step="0.01" value={draft.qty} onChange={(e) => setField("qty", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Unit</FieldLabel>
              <select value={draft.unit} onChange={(e) => setField("unit", e.target.value)} style={{ ...inputStyle, fontSize: 13 }}>
                {PURCHASE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>Price per unit (£)</FieldLabel>
              <input type="number" step="0.01" value={draft.pricePerUnit} onChange={(e) => setField("pricePerUnit", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Total (£)</FieldLabel>
              <div style={{ ...inputStyle, fontSize: 13, background: brand.bgSection, color: brand.forest, fontWeight: 600 }}>
                {fmtCurrency((parseFloat(draft.qty) || 0) * (parseFloat(draft.pricePerUnit) || 0))}
              </div>
            </div>
            <div>
              <FieldLabel>Supplier</FieldLabel>
              <input value={draft.supplier} onChange={(e) => setField("supplier", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Invoice ref</FieldLabel>
              <input value={draft.invoiceRef} onChange={(e) => setField("invoiceRef", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
            <div>
              <FieldLabel>Notes</FieldLabel>
              <input value={draft.notes} onChange={(e) => setField("notes", e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" size="sm" onClick={addPurchase} disabled={!draft.date || !draft.product || !draft.qty}>
              Save purchase
            </Button>
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>Total purchases {thisYear()}</Kicker>
          <div style={{ fontFamily: fonts.serif, fontSize: 26, color: brand.forest, letterSpacing: "-0.02em" }}>
            {fmtCurrency(totalThisYear)}
          </div>
          <Body size="sm" style={{ marginTop: 4 }}>{yearPurchases.length} purchase{yearPurchases.length === 1 ? "" : "s"} recorded</Body>
        </Card>
        <Card padding={14}>
          <Kicker style={{ marginBottom: 6 }}>By category {thisYear()}</Kicker>
          {byCategory.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              {byCategory.map(([cat, total]) => (
                <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: brand.forest, fontWeight: 500, textTransform: "capitalize" }}>{cat}</span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 11, color: brand.muted }}>{fmtCurrency(total)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Body size="sm" style={{ color: brand.muted }}>No purchases this year</Body>
          )}
        </Card>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          kicker="Purchases"
          title="No purchases recorded"
          description="Use 'Add purchase' to track seed, chemical, fertiliser, fuel, and other input costs."
        />
      ) : (
        <Card padding={0} style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${brand.border}` }}>
                  {["Date", "Product", "Category", "Qty", "Price/unit", "Total", "Supplier", "Ref", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontFamily: fonts.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: brand.muted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${brand.border}` }}>
                    <td style={{ padding: "6px 8px", color: brand.forest }}>{fmtDate(p.date)}</td>
                    <td style={{ padding: "6px 8px", fontWeight: 500, color: brand.forest }}>{p.product}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <Pill tone="neutral" style={{ fontSize: 9, textTransform: "capitalize" }}>{p.category}</Pill>
                    </td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>{p.qty} {p.unit}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11 }}>£{(p.pricePerUnit || 0).toFixed(2)}/{p.unit}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 11, fontWeight: 600 }}>{fmtCurrency(p.total)}</td>
                    <td style={{ padding: "6px 8px", color: brand.bodySoft }}>{p.supplier || "—"}</td>
                    <td style={{ padding: "6px 8px", fontFamily: fonts.mono, fontSize: 10, color: brand.muted }}>{p.invoiceRef || "—"}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <button
                        type="button"
                        onClick={() => removePurchase(p.id)}
                        title="Delete"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: brand.muted, fontFamily: fonts.mono, fontSize: 12, padding: "2px 4px" }}
                      >
                        ×
                      </button>
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

export function MarketWorkspace({ farm }) {
  const farmId = farm?.id;
  const [tab, setTab] = useState("Prices");

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Prices"
          title="Market"
          description="UK commodity prices, sale records, and input purchase tracking."
        />
      }
    >
      <div
        className="tilth-scroll"
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 4px 4px" }}
      >
        <TabBar tabs={TABS} active={tab} onChange={setTab} />
        {tab === "Prices" && <PricesTab farmId={farmId} />}
        {tab === "Sales" && <SalesTab farmId={farmId} />}
        {tab === "Purchases" && <PurchasesTab farmId={farmId} />}
      </div>
    </WorkspaceFrame>
  );
}

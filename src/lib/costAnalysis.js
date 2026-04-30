/**
 * Yield vs input cost analysis for Tilth.
 *
 * Pure functions that compute per-field and whole-farm gross margins,
 * cost breakdowns, profitability rankings, and margin correlations
 * with health/N-rate/spray-count.
 *
 * Commodity prices are approximate 2025/26 AHDB-style UK values.
 * Product costs are indicative per-unit figures for a generic product
 * catalogue — callers should override with actual invoiced costs when
 * available.
 */

// ─── Commodity prices (£/tonne, indicative UK 2025/26) ─────────────

/** @type {Record<string, number>} */
export const COMMODITY_PRICES = {
  "Winter wheat":          180,
  "Spring wheat":          175,
  "Winter barley":         155,
  "Spring barley":         170,
  "Winter oats":           150,
  "Spring oats":           155,
  "Winter oilseed rape":   370,
  "Spring beans":          220,
  "Winter beans":          215,
  "Peas":                  230,
  "Maize":                 160,
  "Sugar beet":             28,
  "Potatoes":              140,
  "Linseed":               350,
};

// ─── Product cost lookup (£ per unit) ──────────────────────────────
// Keyed by product category (lowercase). Real per-product costs can
// be passed by enriching the products array with a `costPerUnit` field.

const CATEGORY_COSTS = {
  fertiliser:   400,
  herbicide:     25,
  fungicide:     35,
  insecticide:   30,
  pgr:           20,
  seed:         200,
};

/**
 * Indicative per-unit cost for a product. Prefers the product's own
 * `costPerUnit` if present, otherwise falls back to the category
 * average.
 *
 * @param {{ category?: string, costPerUnit?: number }} product
 * @returns {number}
 */
export function productCost(product) {
  if (product?.costPerUnit != null && Number.isFinite(product.costPerUnit)) {
    return product.costPerUnit;
  }
  const cat = (product?.category || "").toLowerCase().replace(/s$/, "");
  return CATEGORY_COSTS[cat] ?? 0;
}

/** @type {Record<string, number>} */
export const PRODUCT_COSTS = { ...CATEGORY_COSTS };

// ─── Helpers ───────────────────────────────────────────────────────

function normalise(name) {
  return (name || "").trim();
}

function commodityPrice(cropName) {
  const n = normalise(cropName);
  if (COMMODITY_PRICES[n] != null) return COMMODITY_PRICES[n];
  // Fuzzy: strip trailing 's', try case-insensitive
  const lower = n.toLowerCase();
  for (const [k, v] of Object.entries(COMMODITY_PRICES)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function categorise(product) {
  const cat = (product?.category || "other").toLowerCase().replace(/s$/, "");
  const buckets = ["fertiliser", "herbicide", "fungicide", "insecticide", "pgr", "seed"];
  return buckets.includes(cat) ? cat : "other";
}

function productById(productId, products) {
  return (products || []).find((p) => p.id === productId) || null;
}

// ─── Per-field margin ──────────────────────────────────────────────

/**
 * Compute gross margin for a single field in a given year.
 *
 * @param {string}  fieldId
 * @param {Array}   records   — input/spray records (all fields, all years)
 * @param {Object}  yieldStore — { [year]: { [fieldId]: number (t/ha) } }
 * @param {Object}  plantings  — { [fieldId]: [{ crop, plantingDate, ... }] }
 * @param {Array}   products   — product catalogue
 * @param {number}  year
 * @param {number}  areaHa
 * @returns {{
 *   revenue: number|null,
 *   variableCosts: number,
 *   grossMargin: number|null,
 *   grossMarginPerHa: number|null,
 *   costBreakdown: Record<string, number>,
 *   roi: number|null,
 *   yieldTHa: number|null,
 *   cropName: string|null,
 *   pricePerTonne: number|null,
 *   fieldId: string,
 *   areaHa: number,
 * }}
 */
export function computeFieldMargin(fieldId, records, yieldStore, plantings, products, year, areaHa) {
  const fieldPlantings = plantings?.[fieldId] || [];
  const planting = fieldPlantings.find((p) => {
    if (!p.plantingDate) return false;
    const py = new Date(p.plantingDate).getFullYear();
    return py === year || py === year - 1;
  }) || fieldPlantings[0] || null;

  const cropName = planting?.crop || null;
  const pricePerTonne = cropName ? commodityPrice(cropName) : null;

  const yieldTHa = yieldStore?.[year]?.[fieldId] ?? null;
  const revenue = (yieldTHa != null && pricePerTonne != null)
    ? yieldTHa * pricePerTonne
    : null;

  const costBreakdown = {
    fertiliser: 0,
    herbicide: 0,
    fungicide: 0,
    insecticide: 0,
    pgr: 0,
    seed: 0,
    other: 0,
  };

  let variableCosts = 0;
  const yearRecords = (records || []).filter((r) => {
    if (r.fieldId !== fieldId || !r.date) return false;
    return new Date(r.date).getFullYear() === year;
  });

  for (const r of yearRecords) {
    const prod = productById(r.productId, products);
    const cost = productCost(prod);
    const rate = Number.isFinite(r.rate) ? r.rate : 0;
    const area = Number.isFinite(r.area) ? r.area : areaHa;
    const lineCost = cost * rate * area;
    variableCosts += lineCost;

    const bucket = categorise(prod);
    const perHaCost = areaHa > 0 ? (cost * rate * area) / areaHa : 0;
    costBreakdown[bucket] += perHaCost;
  }

  const grossMargin = revenue != null ? revenue * (areaHa || 1) - variableCosts : null;
  const grossMarginPerHa = grossMargin != null && areaHa > 0
    ? grossMargin / areaHa
    : null;
  const roi = grossMargin != null && variableCosts > 0
    ? grossMargin / variableCosts
    : null;

  return {
    fieldId,
    areaHa,
    cropName,
    pricePerTonne,
    yieldTHa,
    revenue: revenue != null ? revenue * (areaHa || 1) : null,
    variableCosts,
    grossMargin,
    grossMarginPerHa,
    costBreakdown,
    roi,
  };
}

// ─── Farm-level margins ────────────────────────────────────────────

/**
 * Polygon area (ha) from a boundary ring — spherical Shoelace.
 * @param {Array<{lat: number, lng: number}>} boundary
 * @returns {number}
 */
function polygonAreaHa(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) return 0;
  const toRad = Math.PI / 180;
  let area = 0;
  for (let i = 0; i < boundary.length; i++) {
    const j = (i + 1) % boundary.length;
    const p1 = boundary[i];
    const p2 = boundary[j];
    area +=
      (p2.lng - p1.lng) * toRad *
      (2 + Math.sin(p1.lat * toRad) + Math.sin(p2.lat * toRad));
  }
  area = Math.abs((area * 6378137 * 6378137) / 2);
  return area / 10000;
}

/**
 * Compute margins for every field on the farm + aggregate totals.
 *
 * @param {Array}  fields
 * @param {Array}  records
 * @param {Object} yieldStore
 * @param {Object} plantings
 * @param {Object} fieldAttrs
 * @param {Array}  products
 * @param {number} year
 * @returns {{
 *   fieldMargins: Array,
 *   totalRevenue: number,
 *   totalCost: number,
 *   totalMargin: number,
 *   averageMarginPerHa: number|null,
 *   bestField: object|null,
 *   worstField: object|null,
 *   totalAreaHa: number,
 * }}
 */
export function computeFarmMargins(fields, records, yieldStore, plantings, fieldAttrs, products, year) {
  const fieldMargins = (fields || []).map((f) => {
    const areaHa = f.areaHa ?? polygonAreaHa(f.boundary);
    const margin = computeFieldMargin(
      f.id, records, yieldStore, plantings, products, year, areaHa
    );
    return { ...margin, fieldName: f.name || f.id };
  });

  let totalRevenue = 0;
  let totalCost = 0;
  let totalMargin = 0;
  let totalAreaHa = 0;
  let scoredFields = 0;

  for (const fm of fieldMargins) {
    totalCost += fm.variableCosts;
    totalAreaHa += fm.areaHa || 0;
    if (fm.grossMargin != null) {
      totalRevenue += fm.revenue || 0;
      totalMargin += fm.grossMargin;
      scoredFields++;
    }
  }

  const averageMarginPerHa = totalAreaHa > 0 && scoredFields > 0
    ? totalMargin / totalAreaHa
    : null;

  const withMargin = fieldMargins.filter((fm) => fm.grossMarginPerHa != null);
  withMargin.sort((a, b) => b.grossMarginPerHa - a.grossMarginPerHa);

  return {
    fieldMargins,
    totalRevenue,
    totalCost,
    totalMargin,
    averageMarginPerHa,
    bestField: withMargin[0] || null,
    worstField: withMargin[withMargin.length - 1] || null,
    totalAreaHa,
  };
}

// ─── Correlation analysis ──────────────────────────────────────────

/**
 * Pearson correlation coefficient for two numeric arrays (paired).
 * Returns null if fewer than 3 valid pairs.
 *
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null}
 */
function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      pairs.push([xs[i], ys[i]]);
    }
  }
  if (pairs.length < 3) return null;

  const n = pairs.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pairs) {
    sx += x; sy += y;
    sxx += x * x; syy += y * y;
    sxy += x * y;
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

function corrDirection(r) {
  if (r == null) return "insufficient data";
  if (r > 0.3) return "positive";
  if (r < -0.3) return "negative";
  return "weak/none";
}

function corrInsight(label, r, direction) {
  if (r == null) return `Not enough data to correlate ${label}.`;
  const strength = Math.abs(r) > 0.6 ? "strong" : Math.abs(r) > 0.3 ? "moderate" : "weak";
  if (direction === "positive") {
    return `There is a ${strength} positive correlation (r=${r.toFixed(2)}) between ${label} — fields with higher values tend to be more profitable.`;
  }
  if (direction === "negative") {
    return `There is a ${strength} negative correlation (r=${r.toFixed(2)}) between ${label} — higher values are associated with lower margins.`;
  }
  return `No meaningful correlation (r=${r.toFixed(2)}) found between ${label}.`;
}

/**
 * Correlate gross margin with health score, N rate, and spray count.
 *
 * @param {Array} farmMargins — output of computeFarmMargins().fieldMargins
 * @param {Map|Object} healthMap — fieldId → { score: number } (from cropHealth)
 * @param {Array} records — all input records
 * @param {Array} products
 * @param {number} year
 * @returns {{
 *   marginVsScore: { r: number|null, direction: string, insight: string },
 *   marginVsN: { r: number|null, direction: string, insight: string },
 *   marginVsSprays: { r: number|null, direction: string, insight: string },
 * }}
 */
export function marginCorrelation(farmMargins, healthMap, records, products, year) {
  const margins = [];
  const scores = [];
  const nRates = [];
  const sprayCounts = [];

  for (const fm of farmMargins || []) {
    if (fm.grossMarginPerHa == null) continue;

    const healthRec = healthMap instanceof Map
      ? healthMap.get(fm.fieldId)
      : healthMap?.[fm.fieldId];
    const score = healthRec?.score ?? null;

    const yearRecords = (records || []).filter((r) =>
      r.fieldId === fm.fieldId &&
      r.date &&
      new Date(r.date).getFullYear() === year
    );

    let totalN = 0;
    let sprayCount = 0;
    for (const r of yearRecords) {
      const prod = productById(r.productId, products);
      if (prod?.nFraction && Number.isFinite(r.rate)) {
        totalN += r.rate * prod.nFraction;
      }
      const cat = (prod?.category || "").toLowerCase();
      if (/herbicide|fungicide|insecticide|pgr/.test(cat)) {
        sprayCount++;
      }
    }
    const nPerHa = fm.areaHa > 0 ? totalN * (fm.areaHa) / fm.areaHa : totalN;

    margins.push(fm.grossMarginPerHa);
    scores.push(score);
    nRates.push(nPerHa);
    sprayCounts.push(sprayCount);
  }

  const rScore = pearson(margins, scores);
  const rN = pearson(margins, nRates);
  const rSprays = pearson(margins, sprayCounts);

  return {
    marginVsScore: {
      r: rScore,
      direction: corrDirection(rScore),
      insight: corrInsight("margin and health score", rScore, corrDirection(rScore)),
    },
    marginVsN: {
      r: rN,
      direction: corrDirection(rN),
      insight: corrInsight("margin and N application rate", rN, corrDirection(rN)),
    },
    marginVsSprays: {
      r: rSprays,
      direction: corrDirection(rSprays),
      insight: corrInsight("margin and spray count", rSprays, corrDirection(rSprays)),
    },
  };
}

// ─── Profitability ranking ─────────────────────────────────────────

/**
 * Rank fields by gross margin per hectare.
 *
 * @param {Array} farmMargins — fieldMargins array from computeFarmMargins()
 * @returns {Array<{ rank: number, fieldName: string, fieldId: string, marginPerHa: number, percentile: number }>}
 */
export function rankFieldsByProfitability(farmMargins) {
  const scored = (farmMargins || [])
    .filter((fm) => fm.grossMarginPerHa != null)
    .slice()
    .sort((a, b) => b.grossMarginPerHa - a.grossMarginPerHa);

  const n = scored.length;
  return scored.map((fm, i) => ({
    rank: i + 1,
    fieldName: fm.fieldName || fm.fieldId,
    fieldId: fm.fieldId,
    marginPerHa: Math.round(fm.grossMarginPerHa),
    percentile: n > 1 ? Math.round(((n - 1 - i) / (n - 1)) * 100) : 100,
  }));
}

/**
 * Compliance document generator for Tilth.
 *
 * Produces export-ready compliance artefacts for UK farm management:
 *   - Input diary (CSV)
 *   - NVZ evidence report (HTML)
 *   - Scheme claim summary (HTML)
 *   - Field boundaries (GeoJSON)
 *   - Cover-page summary (HTML)
 *
 * All generator functions are pure — no side effects, no hooks.
 * `downloadAllFiles` is the only function with browser side effects
 * (triggering file downloads).
 */

import { SCHEME_CATALOGUE } from "./schemeCatalogue.js";
import {
  SFI26_AGREEMENT_CAP,
  SCHEME_LABELS,
} from "./schemeCatalogue.js";

// ─── NVZ closed periods ────────────────────────────────────────────
// [month (1-based), day] — inclusive start/end.

const NVZ_CLOSED = {
  slurry_grass:       { start: [10, 15], end: [1, 31] },
  slurry_arable:      { start: [10, 1],  end: [1, 31] },
  poultry_grass:      { start: [10, 15], end: [1, 31] },
  poultry_arable:     { start: [10, 1],  end: [1, 31] },
  manufactured:       { start: [9, 15],  end: [1, 31] },
};

// ─── N-max caps (kg N/ha) ──────────────────────────────────────────

const N_MAX_ARABLE  = 220;
const N_MAX_GRASS   = 250;
const N_MAX_ORGANIC = 170;

// ─── Helpers ───────────────────────────────────────────────────────

function escCsv(val) {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function escHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt2(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function fmt0(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-GB") : "—";
}

function fieldName(fieldId, fields) {
  const f = (fields || []).find((x) => x.id === fieldId);
  return f?.name || fieldId;
}

function productById(productId, products) {
  return (products || []).find((p) => p.id === productId) || null;
}

function yearFilter(records, year) {
  return (records || []).filter((r) => {
    if (!r.date) return false;
    return new Date(r.date).getFullYear() === year;
  });
}

/**
 * Compute applied N (kg/ha) for a single record.
 * rate × nFraction gives kg N per unit of area sprayed.
 */
function appliedN(record, products) {
  const prod = productById(record.productId, products);
  if (!prod || !Number.isFinite(prod.nFraction) || !Number.isFinite(record.rate)) {
    return 0;
  }
  return record.rate * prod.nFraction;
}

/**
 * Compute field area in hectares from a boundary ring using the
 * Shoelace formula on a spherical approximation.
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

function dateInClosedPeriod(dateStr, periodKey) {
  const period = NVZ_CLOSED[periodKey];
  if (!period) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const [sm, sd] = period.start;
  const [em, ed] = period.end;

  // Closed periods wrap across the year boundary (e.g. Oct → Jan).
  if (sm > em || (sm === em && sd > ed)) {
    if (m > sm || (m === sm && day >= sd)) return true;
    if (m < em || (m === em && day <= ed)) return true;
    return false;
  }
  if (m > sm || (m === sm && day >= sd)) {
    if (m < em || (m === em && day <= ed)) return true;
  }
  return false;
}

function isGrassLandUse(landUse) {
  return /grass/i.test(landUse || "");
}

function nvzCategoryForProduct(product) {
  if (!product) return null;
  const cat = (product.category || "").toLowerCase();
  if (/slurry|manure/.test(cat)) return "slurry";
  if (/poultry/.test(cat)) return "poultry";
  if (/fert|manufactured|mineral|nitrogen|urea|ammonium|nitrate/.test(cat)) return "manufactured";
  return null;
}

// ─── Input diary ───────────────────────────────────────────────────

/**
 * Generate a spray/input diary as a CSV string.
 *
 * @param {Array} records  — input/spray records
 * @param {Array} fields   — field objects with id, name
 * @param {Array} products — product catalogue with id, name, activeIngredient, category, unit, nFraction
 * @param {number} year
 * @returns {string} CSV
 */
export function generateInputDiary(records, fields, products, year) {
  const rows = yearFilter(records, year).sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  const header = [
    "Date", "Field", "Product", "Active Ingredient", "Category",
    "Rate", "Unit", "Area (ha)", "Operator", "N Applied (kg/ha)", "Notes",
  ];

  const lines = [header.map(escCsv).join(",")];

  for (const r of rows) {
    const prod = productById(r.productId, products);
    const nApplied = appliedN(r, products);
    lines.push(
      [
        escCsv(r.date),
        escCsv(fieldName(r.fieldId, fields)),
        escCsv(prod?.name ?? r.productId),
        escCsv(prod?.activeIngredient ?? ""),
        escCsv(prod?.category ?? ""),
        escCsv(fmt2(r.rate)),
        escCsv(prod?.unit ?? ""),
        escCsv(fmt2(r.area)),
        escCsv(r.operator ?? ""),
        escCsv(fmt2(nApplied)),
        escCsv(r.notes ?? ""),
      ].join(",")
    );
  }

  return lines.join("\n");
}

// ─── NVZ report ────────────────────────────────────────────────────

/**
 * Generate an NVZ evidence report as an HTML string.
 *
 * @param {Array}  records
 * @param {Array}  fields
 * @param {Object} fieldAttrs — { fieldId: { landUse, soil, crop, ... } }
 * @param {Array}  products
 * @param {number} year
 * @returns {string} HTML
 */
export function generateNvzReport(records, fields, fieldAttrs, products, year) {
  const yearRecs = yearFilter(records, year);

  // Per-field N budget
  const fieldBudgets = (fields || []).map((f) => {
    const attrs = fieldAttrs?.[f.id] || {};
    const areaHa = f.areaHa ?? polygonAreaHa(f.boundary);
    const grass = isGrassLandUse(attrs.landUse);
    const nMax = attrs.isOrganic ? N_MAX_ORGANIC : grass ? N_MAX_GRASS : N_MAX_ARABLE;

    const fieldRecs = yearRecs.filter((r) => r.fieldId === f.id);
    let totalN = 0;
    for (const r of fieldRecs) {
      totalN += appliedN(r, products) * (r.area || areaHa || 1);
    }
    const nPerHa = areaHa > 0 ? totalN / areaHa : 0;
    const headroom = nMax - nPerHa;
    const status = headroom >= 0 ? "OK" : "OVER";

    return {
      name: f.name || f.id,
      areaHa,
      nPerHa,
      nMax,
      headroom,
      status,
      grass,
    };
  });

  // Closed period violations
  const violations = [];
  for (const r of yearRecs) {
    const prod = productById(r.productId, products);
    const nvzCat = nvzCategoryForProduct(prod);
    if (!nvzCat) continue;
    const attrs = fieldAttrs?.[r.fieldId] || {};
    const grass = isGrassLandUse(attrs.landUse);
    const terrain = grass ? "grass" : "arable";

    let periodKey;
    if (nvzCat === "slurry") periodKey = `slurry_${terrain}`;
    else if (nvzCat === "poultry") periodKey = `poultry_${terrain}`;
    else periodKey = "manufactured";

    if (dateInClosedPeriod(r.date, periodKey)) {
      violations.push({
        date: r.date,
        field: fieldName(r.fieldId, fields),
        product: prod?.name ?? r.productId,
        category: nvzCat,
        periodKey,
      });
    }
  }

  const compliantCount = fieldBudgets.filter((b) => b.status === "OK").length;
  const overCount = fieldBudgets.filter((b) => b.status === "OVER").length;

  let html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>NVZ Evidence Report — ${year}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; color: #1a1a1a; }
  h1 { color: #2d5016; } h2 { color: #3a6b1e; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #f0f4ec; }
  .ok { color: #2d7a0e; font-weight: 600; }
  .over { color: #b4412e; font-weight: 600; }
  .violation { background: #fef0ee; }
  .summary { background: #f5f9f2; padding: 1rem; border-radius: 6px; margin-top: 2rem; }
</style></head><body>
<h1>NVZ Evidence Report — ${year}</h1>
<p>Generated: ${new Date().toLocaleDateString("en-GB")}</p>

<h2>Nitrogen Budget by Field</h2>
<table>
<tr><th>Field</th><th>Area (ha)</th><th>N Applied (kg/ha)</th><th>N Max (kg/ha)</th><th>Headroom</th><th>Status</th></tr>`;

  for (const b of fieldBudgets) {
    const cls = b.status === "OK" ? "ok" : "over";
    html += `\n<tr>
  <td>${escHtml(b.name)}</td>
  <td>${fmt2(b.areaHa)}</td>
  <td>${fmt2(b.nPerHa)}</td>
  <td>${b.nMax}</td>
  <td>${fmt2(b.headroom)}</td>
  <td class="${cls}">${b.status}</td>
</tr>`;
  }

  html += `\n</table>

<h2>Closed Period Compliance</h2>`;

  if (violations.length === 0) {
    html += `\n<p class="ok">No closed-period violations found for ${year}.</p>`;
  } else {
    html += `\n<table>
<tr><th>Date</th><th>Field</th><th>Product</th><th>Category</th><th>Closed Period</th></tr>`;
    for (const v of violations) {
      const period = NVZ_CLOSED[v.periodKey];
      const periodLabel = period
        ? `${v.periodKey.replace(/_/g, " ")} (${period.start[1]}/${period.start[0]} – ${period.end[1]}/${period.end[0]})`
        : v.periodKey;
      html += `\n<tr class="violation">
  <td>${escHtml(v.date)}</td>
  <td>${escHtml(v.field)}</td>
  <td>${escHtml(v.product)}</td>
  <td>${escHtml(v.category)}</td>
  <td>${escHtml(periodLabel)}</td>
</tr>`;
    }
    html += `\n</table>`;
  }

  html += `\n
<div class="summary">
  <h2>Summary</h2>
  <p>Fields within N budget: <strong>${compliantCount}</strong></p>
  <p>Fields over N budget: <strong class="${overCount ? "over" : "ok"}">${overCount}</strong></p>
  <p>Closed-period violations: <strong class="${violations.length ? "over" : "ok"}">${violations.length}</strong></p>
</div>
</body></html>`;

  return html;
}

// ─── Scheme claim summary ──────────────────────────────────────────

/**
 * Generate a scheme claim summary as an HTML string.
 *
 * @param {Object} assignments   — { fieldId: { codes: [string] } }
 * @param {Array}  schemeResults — per-field evaluation results from schemeEligibility
 * @param {Array}  fields
 * @returns {string} HTML
 */
export function generateSchemeClaimSummary(assignments, schemeResults, fields) {
  const catalogue = new Map(SCHEME_CATALOGUE.map((a) => [a.code, a]));

  const fieldRows = [];
  const schemeTotals = {};
  let grandTotal = 0;

  for (const f of fields || []) {
    const assigned = assignments?.[f.id]?.codes || [];
    if (!assigned.length) continue;

    for (const code of assigned) {
      const action = catalogue.get(code);
      if (!action) continue;

      const areaHa = f.areaHa ?? polygonAreaHa(f.boundary);
      let payment = 0;
      if (action.paymentPerHa && areaHa) {
        payment = action.paymentPerHa * areaHa;
      } else if (action.paymentPerUnit) {
        payment = action.paymentPerUnit;
      }

      fieldRows.push({
        fieldName: f.name || f.id,
        code,
        actionName: action.name,
        scheme: action.scheme,
        payment,
        unit: action.unit,
        areaHa,
      });

      schemeTotals[action.scheme] = (schemeTotals[action.scheme] || 0) + payment;
      grandTotal += payment;
    }
  }

  const sfi26Total = schemeTotals["SFI26"] || 0;
  const capExceeded = sfi26Total > SFI26_AGREEMENT_CAP;

  let html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Scheme Claim Summary</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; color: #1a1a1a; }
  h1 { color: #2d5016; } h2 { color: #3a6b1e; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #f0f4ec; }
  .total { font-weight: 700; }
  .warn { color: #b4412e; font-weight: 600; }
  .ok { color: #2d7a0e; }
  .summary { background: #f5f9f2; padding: 1rem; border-radius: 6px; margin-top: 1.5rem; }
</style></head><body>
<h1>Scheme Claim Summary</h1>
<p>Generated: ${new Date().toLocaleDateString("en-GB")}</p>

<h2>Assigned Actions by Field</h2>
<table>
<tr><th>Field</th><th>Code</th><th>Action</th><th>Scheme</th><th>Est. Payment (£)</th></tr>`;

  for (const r of fieldRows) {
    html += `\n<tr>
  <td>${escHtml(r.fieldName)}</td>
  <td>${escHtml(r.code)}</td>
  <td>${escHtml(r.actionName)}</td>
  <td>${escHtml(SCHEME_LABELS[r.scheme] || r.scheme)}</td>
  <td>£${fmt0(r.payment)}</td>
</tr>`;
  }

  html += `\n</table>

<h2>Farm Totals by Scheme</h2>
<table>
<tr><th>Scheme</th><th>Estimated Payment (£)</th></tr>`;

  for (const [scheme, total] of Object.entries(schemeTotals)) {
    html += `\n<tr>
  <td>${escHtml(SCHEME_LABELS[scheme] || scheme)}</td>
  <td class="total">£${fmt0(total)}</td>
</tr>`;
  }

  html += `\n<tr class="total">
  <td>Grand Total</td>
  <td>£${fmt0(grandTotal)}</td>
</tr>
</table>`;

  if (sfi26Total > 0) {
    html += `\n
<div class="summary">
  <h2>SFI26 Agreement Cap Check</h2>
  <p>SFI26 estimated total: <strong>£${fmt0(sfi26Total)}</strong></p>
  <p>Agreement cap: <strong>£${fmt0(SFI26_AGREEMENT_CAP)}</strong></p>
  <p>Status: <strong class="${capExceeded ? "warn" : "ok"}">${capExceeded ? "EXCEEDS CAP — reduce selections" : "Within cap"}</strong></p>
</div>`;
  }

  html += `\n</body></html>`;
  return html;
}

// ─── GeoJSON boundaries ────────────────────────────────────────────

/**
 * Generate a GeoJSON FeatureCollection of field boundaries.
 *
 * @param {Array} fields — [{ id, name, boundary: [{lat, lng}] }]
 * @returns {string} GeoJSON string
 */
export function generateFieldBoundariesGeoJSON(fields) {
  const features = (fields || [])
    .filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3)
    .map((f) => {
      const coords = f.boundary.map((p) => [p.lng, p.lat]);
      // Close the ring if not already closed
      if (
        coords.length > 0 &&
        (coords[0][0] !== coords[coords.length - 1][0] ||
         coords[0][1] !== coords[coords.length - 1][1])
      ) {
        coords.push([...coords[0]]);
      }
      const areaHa = f.areaHa ?? polygonAreaHa(f.boundary);
      return {
        type: "Feature",
        properties: {
          name: f.name || f.id,
          id: f.id,
          area_ha: Math.round(areaHa * 100) / 100,
        },
        geometry: {
          type: "Polygon",
          coordinates: [coords],
        },
      };
    });

  return JSON.stringify(
    { type: "FeatureCollection", features },
    null,
    2
  );
}

// ─── Full compliance pack ──────────────────────────────────────────

/**
 * Generate the complete compliance pack.
 *
 * @param {Object} data
 * @param {Array}  data.records
 * @param {Array}  data.fields
 * @param {Object} data.fieldAttrs
 * @param {Object} data.plantings
 * @param {Object} data.assignments
 * @param {Array}  data.schemeResults
 * @param {Array}  data.products
 * @param {number} data.year
 * @param {string} data.farmName
 * @returns {{ inputDiaryCsv: string, nvzReportHtml: string, schemeClaimHtml: string, boundariesGeoJson: string, summaryHtml: string }}
 */
export function generateCompliancePack(data) {
  const {
    records, fields, fieldAttrs,
    assignments, schemeResults, products, year, farmName,
  } = data;

  const inputDiaryCsv = generateInputDiary(records, fields, products, year);
  const nvzReportHtml = generateNvzReport(records, fields, fieldAttrs, products, year);
  const schemeClaimHtml = generateSchemeClaimSummary(assignments, schemeResults, fields);
  const boundariesGeoJson = generateFieldBoundariesGeoJSON(fields);

  const totalAreaHa = (fields || []).reduce((sum, f) => {
    return sum + (f.areaHa ?? polygonAreaHa(f.boundary));
  }, 0);

  const summaryHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Compliance Pack — ${escHtml(farmName)} — ${year}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 700px; margin: 3rem auto; color: #1a1a1a; text-align: center; }
  h1 { color: #2d5016; font-size: 1.8rem; }
  .meta { color: #555; margin: 0.3rem 0; }
  .card { background: #f5f9f2; border-radius: 8px; padding: 1.5rem 2rem; margin: 2rem auto; display: inline-block; text-align: left; }
  .card dt { font-weight: 600; color: #3a6b1e; }
  .card dd { margin: 0 0 0.8rem 0; }
  .footer { margin-top: 3rem; font-size: 0.85rem; color: #888; }
</style></head><body>
<h1>${escHtml(farmName)}</h1>
<p class="meta">Compliance Pack — Harvest Year ${year}</p>
<p class="meta">Generated ${new Date().toLocaleDateString("en-GB")}</p>

<div class="card">
  <dl>
    <dt>Farm</dt><dd>${escHtml(farmName)}</dd>
    <dt>Harvest Year</dt><dd>${year}</dd>
    <dt>Fields</dt><dd>${(fields || []).length}</dd>
    <dt>Total Area</dt><dd>${fmt2(totalAreaHa)} ha</dd>
    <dt>Date Generated</dt><dd>${new Date().toISOString().slice(0, 10)}</dd>
  </dl>
</div>

<h2>Contents</h2>
<ol style="text-align:left; display:inline-block;">
  <li>Input Diary (CSV)</li>
  <li>NVZ Evidence Report (HTML)</li>
  <li>Scheme Claim Summary (HTML)</li>
  <li>Field Boundaries (GeoJSON)</li>
</ol>

<p class="footer">Produced by Tilth — farm compliance data platform</p>
</body></html>`;

  return {
    inputDiaryCsv,
    nvzReportHtml,
    schemeClaimHtml,
    boundariesGeoJson,
    summaryHtml,
  };
}

// ─── Download ──────────────────────────────────────────────────────

function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Download all compliance pack files individually.
 *
 * @param {{ inputDiaryCsv: string, nvzReportHtml: string, schemeClaimHtml: string, boundariesGeoJson: string, summaryHtml: string }} pack
 * @param {string} farmName
 * @param {number} year
 */
export function downloadAllFiles(pack, farmName, year) {
  const prefix = `${(farmName || "farm").replace(/\s+/g, "_")}_${year}`;
  const files = [
    { content: pack.summaryHtml,      name: `${prefix}_summary.html`,          mime: "text/html" },
    { content: pack.inputDiaryCsv,    name: `${prefix}_input_diary.csv`,       mime: "text/csv" },
    { content: pack.nvzReportHtml,    name: `${prefix}_nvz_report.html`,       mime: "text/html" },
    { content: pack.schemeClaimHtml,  name: `${prefix}_scheme_claim.html`,     mime: "text/html" },
    { content: pack.boundariesGeoJson, name: `${prefix}_boundaries.geojson`,   mime: "application/geo+json" },
  ];

  // Stagger downloads slightly so browsers don't coalesce them
  files.forEach((f, i) => {
    setTimeout(() => triggerDownload(f.content, f.name, f.mime), i * 200);
  });
}

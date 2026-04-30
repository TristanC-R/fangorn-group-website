/**
 * Scheme eligibility rule engine.
 *
 * Pure functions — no hooks, no side effects, no imports beyond the
 * catalogue. Takes per-field data and returns eligibility assessments
 * with confidence scores and payment estimates.
 */

import {
  SCHEME_CATALOGUE,
  SFI26_AGREEMENT_CAP,
  SFI26_MIN_FARM_HA,
  AREA_CAPPED_CODES,
} from "./schemeCatalogue.js";
import { CROP_CATALOGUE } from "./cropPhenology.js";

// Land-use id → catalogue land-type tokens
const LAND_USE_MAP = {
  arable: ["arable", "horticultural"],
  grass: ["grass_improved"],
  woodland: ["woodland"],
  hedgerow: ["hedgerow"],
  water: ["water"],
  other: ["rough_grazing"],
};

function fieldLandTypes(landUse) {
  return LAND_USE_MAP[landUse] || ["any"];
}

function landTypeMatch(fieldTokens, actionLandTypes) {
  if (!actionLandTypes || !actionLandTypes.length) return true;
  if (actionLandTypes.includes("any")) return true;
  return fieldTokens.some((t) => actionLandTypes.includes(t));
}

/**
 * Evaluate one field against the full catalogue.
 *
 * fieldData shape:
 *   {
 *     landUse:     "arable" | "grass" | "woodland" | ...
 *     soil:        "Clay" | "Loam" | ... | null
 *     crop:        "Winter Wheat" | ... | null
 *     areaHa:      number | null
 *     elevation:   { mean, min, max, slope_mean_deg, slope_max_deg, twi_mean, aspect_dominant } | null
 *     ndviMean:    number | null          (latest OK scene mean)
 *     isOrganic:   boolean
 *     currentPlanting: { crop, plantingDate } | null
 *   }
 *
 * farmData shape:
 *   {
 *     totalHa:     number        (sum of all field areas)
 *     fieldCount:  number
 *   }
 */
export function evaluateField(fieldData, farmData, catalogue = SCHEME_CATALOGUE) {
  const tokens = fieldLandTypes(fieldData.landUse);
  const results = [];

  for (const action of catalogue) {
    const result = evaluateAction(action, fieldData, farmData, tokens);
    results.push(result);
  }

  results.sort((a, b) => {
    if (a.eligible === true && b.eligible !== true) return -1;
    if (a.eligible !== true && b.eligible === true) return 1;
    if (a.eligible === "maybe" && b.eligible === false) return -1;
    if (a.eligible === false && b.eligible === "maybe") return 1;
    return b.confidence - a.confidence;
  });

  return results;
}

function evaluateAction(action, field, farm, fieldTokens) {
  const reasons = [];
  let confidence = 1.0;
  let eligible = true;

  // Farm-level minimum area (SFI26 requires ≥ 3 ha)
  if (action.scheme === "SFI26" && farm.totalHa != null && farm.totalHa < SFI26_MIN_FARM_HA) {
    reasons.push(`Farm < ${SFI26_MIN_FARM_HA} ha (SFI26 minimum)`);
    eligible = false;
  }

  // Land type match
  if (!landTypeMatch(fieldTokens, action.landTypes)) {
    const need = (action.landTypes || []).join(", ");
    reasons.push(`Requires ${need} land`);
    eligible = false;
  }

  // Moorland elevation gate
  if (action.minElevation && eligible !== false) {
    if (field.elevation?.mean != null) {
      if (field.elevation.mean < action.minElevation) {
        reasons.push(`Elevation ${Math.round(field.elevation.mean)} m < ${action.minElevation} m (moorland threshold)`);
        eligible = false;
      }
    } else {
      reasons.push("Elevation data needed to confirm moorland eligibility");
      if (eligible === true) eligible = "maybe";
      confidence = Math.min(confidence, 0.4);
    }
  }

  // Slope constraint
  if (action.slopeMax != null && eligible !== false) {
    if (field.elevation?.slope_mean_deg != null) {
      if (field.elevation.slope_mean_deg > action.slopeMax) {
        reasons.push(`Mean slope ${field.elevation.slope_mean_deg.toFixed(1)}° > ${action.slopeMax}°`);
        eligible = false;
      }
    } else {
      confidence = Math.min(confidence, 0.7);
    }
  }

  // Field area minimum
  if (action.minArea != null && eligible !== false) {
    if (field.areaHa != null) {
      if (field.areaHa < action.minArea) {
        reasons.push(`Field ${field.areaHa.toFixed(1)} ha < minimum ${action.minArea} ha`);
        eligible = false;
      }
    } else {
      confidence = Math.min(confidence, 0.7);
    }
  }

  // Organic actions require organic status
  if (action.theme === "Organic" && eligible !== false) {
    if (field.isOrganic === false || field.isOrganic == null) {
      if (action.code.startsWith("OFM")) {
        reasons.push("Requires certified organic status");
        eligible = false;
      } else if (action.code.startsWith("OFC")) {
        reasons.push("For farms converting to organic");
        if (eligible === true) eligible = "maybe";
        confidence = Math.min(confidence, 0.5);
      }
    }
  }

  // Supplemental actions need base action context
  if (action.isSupplemental && action.baseAction && eligible !== false) {
    reasons.push(`Supplemental — requires ${action.baseAction}`);
    confidence = Math.min(confidence, 0.8);
  }

  // Crop-specific eligibility hints (when planting data is available)
  const planting = field.currentPlanting;
  if (planting?.crop && eligible !== false) {
    const cropInfo = CROP_CATALOGUE[planting.crop];
    const cropFamily = cropInfo?.family;

    // Cover crop actions: flag conflict if field currently has a main crop in the ground
    if (action.name?.toLowerCase().includes("cover crop") || action.code === "SAM2") {
      if (cropFamily && cropFamily !== "cover" && cropFamily !== "grass") {
        reasons.push(`Currently planted with ${planting.crop} — cover crop action applies between cash crops`);
        if (eligible === true) eligible = "maybe";
        confidence = Math.min(confidence, 0.6);
      }
    }

    // Legume fallow actions: incompatible if currently cropped
    if (action.code === "NUM3" && cropFamily && cropFamily !== "cover") {
      reasons.push(`Currently planted with ${planting.crop} — legume fallow requires uncropped land`);
      if (eligible === true) eligible = "maybe";
      confidence = Math.min(confidence, 0.5);
    }

    // Boost confidence for actions that align with the current crop family
    if (cropFamily === "pulse" && action.theme === "Nutrient management") {
      reasons.push(`${planting.crop} is a legume — lower N requirement`);
      confidence = Math.min(confidence, 0.9);
    }
  }

  // Boost confidence when we have planting data
  if (planting?.crop && planting?.plantingDate && eligible !== false) {
    confidence = Math.min(1.0, confidence + 0.05);
  }

  // Penalise confidence if key data is missing
  if (eligible !== false) {
    if (!field.landUse) confidence = Math.min(confidence, 0.5);
    if (!field.soil && action.soilConstraints) confidence = Math.min(confidence, 0.6);
    if (field.areaHa == null) confidence = Math.min(confidence, 0.7);
    if (!planting?.crop) confidence = Math.min(confidence, 0.85);
  }

  // If still eligible with no negatives, add positive reason
  if (eligible === true && !reasons.length) {
    reasons.push("Eligible based on land type and field data");
  }
  if (eligible === "maybe" && !reasons.length) {
    reasons.push("Potentially eligible — more data needed");
  }

  const estimatedPayment = eligible !== false ? estimatePayment(action, field.areaHa) : 0;

  return {
    action,
    eligible,
    confidence: eligible === false ? 0 : confidence,
    reasons,
    estimatedPayment,
  };
}

export function estimatePayment(action, areaHa) {
  if (action.paymentPerHa && areaHa) {
    return Math.round(action.paymentPerHa * areaHa);
  }
  if (action.paymentPerUnit) {
    return action.paymentPerUnit;
  }
  return 0;
}

/**
 * Summarise a full farm evaluation (all fields).
 *
 * fieldResults: Array<{ fieldId, fieldName, areaHa, results: Array<evaluateField result> }>
 * assigned:     Map<fieldId, Set<actionCode>>
 */
export function farmSummary(fieldResults, assigned) {
  let totalEstimated = 0;
  let totalAssigned = 0;
  const byScheme = {};
  const byTheme = {};
  let areaCappedHa = 0;
  let totalFarmHa = 0;
  const warnings = [];

  for (const fr of fieldResults) {
    totalFarmHa += fr.areaHa || 0;
    const fieldAssigned = assigned?.get(fr.fieldId);
    if (!fieldAssigned) continue;
    for (const code of fieldAssigned) {
      const match = fr.results.find((r) => r.action.code === code);
      if (!match) continue;
      totalAssigned++;
      const pay = match.estimatedPayment || 0;
      totalEstimated += pay;

      const s = match.action.scheme;
      byScheme[s] = (byScheme[s] || 0) + pay;
      const t = match.action.theme;
      byTheme[t] = (byTheme[t] || 0) + pay;

      if (AREA_CAPPED_CODES.has(code)) {
        areaCappedHa += fr.areaHa || 0;
      }
    }
  }

  if (totalEstimated > SFI26_AGREEMENT_CAP) {
    warnings.push(`Estimated £${totalEstimated.toLocaleString()} exceeds £${SFI26_AGREEMENT_CAP.toLocaleString()} SFI26 agreement cap`);
  }
  if (totalFarmHa > 0 && areaCappedHa > totalFarmHa * 0.25) {
    warnings.push(`Area-capped actions cover ${((areaCappedHa / totalFarmHa) * 100).toFixed(0)}% of farm (max 25%)`);
  }

  return {
    totalEstimated,
    totalAssigned,
    byScheme,
    byTheme,
    areaCappedHa,
    totalFarmHa,
    warnings,
  };
}

/**
 * Confidence tier for display.
 */
export function confidenceTier(confidence) {
  if (confidence >= 0.8) return { label: "High", tone: "ok" };
  if (confidence >= 0.5) return { label: "Medium", tone: "warn" };
  return { label: "Low", tone: "neutral" };
}

export function eligibleCount(results) {
  return results.filter((r) => r.eligible === true).length;
}

export function maybeCount(results) {
  return results.filter((r) => r.eligible === "maybe").length;
}

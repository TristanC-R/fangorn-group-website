/**
 * Canonical catalogue of environmental / agri-environment scheme actions
 * available to English farms as of April 2026.
 *
 * Source: DEFRA Farming Blog "SFI26: details, definitions and what to
 * expect" (24 Feb 2026) — 71 SFI26 actions, plus selected Countryside
 * Stewardship Higher Tier, EWCO and BNG entries.
 *
 * Each entry carries structured eligibility metadata consumed by the
 * rule engine in schemeEligibility.js.
 *
 * Land type vocabulary:
 *   arable | grass_improved | grass_unimproved | moorland | woodland |
 *   hedgerow | water | rough_grazing | horticultural | top_fruit | any
 *
 * These map to the user-facing land-use categories in landUse.js:
 *   arable      → arable, horticultural
 *   grass       → grass_improved (default; NDVI can refine)
 *   woodland    → woodland
 *   hedgerow    → hedgerow
 *   water       → water
 *   other       → rough_grazing / any
 */

// ─── SFI26 ──────────────────────────────────────────────────────────

const SFI26_ACTIONS = [
  // ── Agroforestry ──
  { code: "AGF1", name: "Maintain very low density in-field agroforestry on less sensitive land", scheme: "SFI26", theme: "Agroforestry", payment: "£248/ha", paymentPerHa: 248, unit: "ha", duration: 3, landTypes: ["arable", "grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AGF2", name: "Maintain low density in-field agroforestry on less sensitive land", scheme: "SFI26", theme: "Agroforestry", payment: "£385/ha", paymentPerHa: 385, unit: "ha", duration: 3, landTypes: ["arable", "grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Boundary features ──
  { code: "CHRW2", name: "Manage hedgerows", scheme: "SFI26", theme: "Boundary features", payment: "£13/100m", paymentPerHa: null, unit: "100m", duration: 3, landTypes: ["hedgerow", "any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 13 },
  { code: "BND1", name: "Maintain dry stone walls", scheme: "SFI26", theme: "Boundary features", payment: "£27/100m", paymentPerHa: null, unit: "100m", duration: 3, landTypes: ["any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 27 },
  { code: "BND2", name: "Maintain earth banks or stone-faced hedgebanks", scheme: "SFI26", theme: "Boundary features", payment: "£11/100m", paymentPerHa: null, unit: "100m", duration: 3, landTypes: ["any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 11 },

  // ── Buffer strips ──
  { code: "CAHL4", name: "4m–12m grass buffer strip on arable and horticultural land", scheme: "SFI26", theme: "Buffer strips", payment: "£515/ha", paymentPerHa: 515, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "CIGL3", name: "4m–12m grass buffer strip on improved grassland", scheme: "SFI26", theme: "Buffer strips", payment: "£235/ha", paymentPerHa: 235, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "BFS1", name: "12m–24m watercourse buffer strips on cultivated land", scheme: "SFI26", theme: "Buffer strips", payment: "£707/ha", paymentPerHa: 707, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "BFS6", name: "6m–12m habitat strip next to watercourses", scheme: "SFI26", theme: "Buffer strips", payment: "£742/ha", paymentPerHa: 742, unit: "ha", duration: 3, landTypes: ["arable", "grass_improved", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Farmland wildlife (arable / horticultural) ──
  { code: "AHW2", name: "Supplementary winter bird food", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£732/t", paymentPerHa: null, unit: "t", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: "CAHL2", paymentPerUnit: 732 },
  { code: "AHW3", name: "Beetle banks", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£764/ha", paymentPerHa: 764, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AHW4", name: "Skylark plots", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£11/plot", paymentPerHa: null, unit: "plot", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 11 },
  { code: "AHW5", name: "Nesting plots for lapwing", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£765/ha", paymentPerHa: 765, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AHW6", name: "Basic overwinter stubble", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£58/ha", paymentPerHa: 58, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AHW7", name: "Enhanced overwinter stubble", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£589/ha", paymentPerHa: 589, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "AHW8", name: "Whole crop spring cereals and overwinter stubble", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£596/ha", paymentPerHa: 596, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AHW9", name: "Unharvested cereal headland", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£1,072/ha", paymentPerHa: 1072, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "AHW10", name: "Low input harvested cereal crop", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£354/ha", paymentPerHa: 354, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AHW11", name: "Cultivated areas for arable plants", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£660/ha", paymentPerHa: 660, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "CAHL1", name: "Pollen and nectar flower mix", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£739/ha", paymentPerHa: 739, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "CAHL2", name: "Winter bird food on arable and horticultural land", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£648/ha", paymentPerHa: 648, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "CAHL3", name: "Grassy field corners or blocks", scheme: "SFI26", theme: "Farmland wildlife (arable)", payment: "£590/ha", paymentPerHa: 590, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: 25, isSupplemental: false, baseAction: null },

  // ── Farmland wildlife (grassland) ──
  { code: "GRH1", name: "Manage rough grazing for birds", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£121/ha", paymentPerHa: 121, unit: "ha", duration: 3, landTypes: ["grass_unimproved", "rough_grazing", "moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "GRH7", name: "Haymaking supplement", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£157/ha", paymentPerHa: 157, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: null },
  { code: "GRH8", name: "Haymaking supplement (late cut)", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£187/ha", paymentPerHa: 187, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: null },
  { code: "GRH10", name: "Lenient grazing supplement", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£28/ha", paymentPerHa: 28, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: null },
  { code: "CLIG3", name: "Manage grassland with very low nutrient inputs", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£151/ha", paymentPerHa: 151, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "CIGL1", name: "Take grassland field corners or blocks out of management", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£333/ha", paymentPerHa: 333, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "CIGL2", name: "Winter bird food on improved grassland", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£515/ha", paymentPerHa: 515, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "SCR1", name: "Create scrub and open habitat mosaics", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£588/ha", paymentPerHa: 588, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved", "arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "SCR2", name: "Manage scrub and open habitat mosaics", scheme: "SFI26", theme: "Farmland wildlife (grass)", payment: "£350/ha", paymentPerHa: 350, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved", "arable", "woodland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Heritage ──
  { code: "HEF1", name: "Maintain weatherproof traditional farm or forestry buildings", scheme: "SFI26", theme: "Heritage", payment: "£5/sq m", paymentPerHa: null, unit: "sqm", duration: 3, landTypes: ["any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 5 },
  { code: "HEF6", name: "Manage historic and archaeological features on grassland", scheme: "SFI26", theme: "Heritage", payment: "£55/ha", paymentPerHa: 55, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── IPM ──
  { code: "CIPM2", name: "Flower-rich grass margins, blocks or in-field strips", scheme: "SFI26", theme: "IPM", payment: "£798/ha", paymentPerHa: 798, unit: "ha", duration: 3, landTypes: ["arable", "grass_improved", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "CIPM3", name: "Companion crop on arable and horticultural land", scheme: "SFI26", theme: "IPM", payment: "£55/ha", paymentPerHa: 55, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "CIPM4", name: "No use of insecticide on arable crops and permanent crops", scheme: "SFI26", theme: "IPM", payment: "£45/ha", paymentPerHa: 45, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Moorland ──
  { code: "UPL1", name: "Moderate livestock grazing on moorland", scheme: "SFI26", theme: "Moorland", payment: "£35/ha", paymentPerHa: 35, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, minElevation: 300 },
  { code: "UPL2", name: "Low livestock grazing on moorland", scheme: "SFI26", theme: "Moorland", payment: "£89/ha", paymentPerHa: 89, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, minElevation: 300 },
  { code: "UPL3", name: "Limited livestock grazing on moorland", scheme: "SFI26", theme: "Moorland", payment: "£111/ha", paymentPerHa: 111, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, minElevation: 300 },
  { code: "UPL5", name: "Keep cattle and ponies on moorland supplement (min. 70% GLU)", scheme: "SFI26", theme: "Moorland", payment: "£18/ha", paymentPerHa: 18, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: "UPL1", minElevation: 300 },
  { code: "UPL6", name: "Keep cattle and ponies on moorland supplement (min. 100% GLU)", scheme: "SFI26", theme: "Moorland", payment: "£23/ha", paymentPerHa: 23, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: "UPL1", minElevation: 300 },
  { code: "UPL8", name: "Shepherding livestock on moorland (remove stock ≥ 4 months)", scheme: "SFI26", theme: "Moorland", payment: "£74/ha", paymentPerHa: 74, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, minElevation: 300 },
  { code: "UPL10", name: "Shepherding livestock on moorland (remove stock ≥ 8 months)", scheme: "SFI26", theme: "Moorland", payment: "£102/ha", paymentPerHa: 102, unit: "ha", duration: 3, landTypes: ["moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, minElevation: 300 },

  // ── Nutrient management ──
  { code: "CNUM2", name: "Legumes on improved grassland", scheme: "SFI26", theme: "Nutrient management", payment: "£102/ha", paymentPerHa: 102, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "CNUM3", name: "Legume fallow", scheme: "SFI26", theme: "Nutrient management", payment: "£532/ha", paymentPerHa: 532, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Organic ──
  { code: "OFC1", name: "Organic conversion – improved permanent grassland", scheme: "SFI26", theme: "Organic", payment: "£187/ha", paymentPerHa: 187, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFC2", name: "Organic conversion – unimproved permanent grassland", scheme: "SFI26", theme: "Organic", payment: "£96/ha", paymentPerHa: 96, unit: "ha", duration: 3, landTypes: ["grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFC3", name: "Organic conversion – rotational land", scheme: "SFI26", theme: "Organic", payment: "£298/ha", paymentPerHa: 298, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFC4", name: "Organic conversion – horticultural land", scheme: "SFI26", theme: "Organic", payment: "£874/ha", paymentPerHa: 874, unit: "ha", duration: 3, landTypes: ["horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFC5", name: "Organic conversion – top fruit", scheme: "SFI26", theme: "Organic", payment: "£1,920/ha", paymentPerHa: 1920, unit: "ha", duration: 3, landTypes: ["top_fruit", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFM1", name: "Organic land management – improved permanent grassland", scheme: "SFI26", theme: "Organic", payment: "£20/ha", paymentPerHa: 20, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFM2", name: "Organic land management – unimproved permanent grassland", scheme: "SFI26", theme: "Organic", payment: "£41/ha", paymentPerHa: 41, unit: "ha", duration: 3, landTypes: ["grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFM3", name: "Organic land management – enclosed rough grazing", scheme: "SFI26", theme: "Organic", payment: "£97/ha", paymentPerHa: 97, unit: "ha", duration: 3, landTypes: ["rough_grazing", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFM4", name: "Organic land management – rotational land", scheme: "SFI26", theme: "Organic", payment: "£132/ha", paymentPerHa: 132, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFM5", name: "Organic land management – horticultural land", scheme: "SFI26", theme: "Organic", payment: "£707/ha", paymentPerHa: 707, unit: "ha", duration: 3, landTypes: ["horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "OFM6", name: "Organic land management – top fruit", scheme: "SFI26", theme: "Organic", payment: "£1,920/ha", paymentPerHa: 1920, unit: "ha", duration: 3, landTypes: ["top_fruit", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Precision farming ──
  { code: "PRF1", name: "Variable rate application of nutrients", scheme: "SFI26", theme: "Precision farming", payment: "£27/ha", paymentPerHa: 27, unit: "ha", duration: 3, landTypes: ["arable", "grass_improved", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "PRF2", name: "Camera or remote sensor guided herbicide spraying", scheme: "SFI26", theme: "Precision farming", payment: "£43/ha", paymentPerHa: 43, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "PRF4", name: "Mechanical robotic weeding", scheme: "SFI26", theme: "Precision farming", payment: "£150/ha", paymentPerHa: 150, unit: "ha", duration: 3, landTypes: ["arable", "horticultural"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Species recovery ──
  { code: "SPM3", name: "Keep native breeds on grazed habitats supplement (> 80%)", scheme: "SFI26", theme: "Species recovery", payment: "£146/ha", paymentPerHa: 146, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved", "moorland"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: null },
  { code: "SPM5", name: "Keep native breeds on extensively managed habitats supplement (> 80%)", scheme: "SFI26", theme: "Species recovery", payment: "£11/ha", paymentPerHa: 11, unit: "ha", duration: 3, landTypes: ["grass_unimproved", "moorland", "rough_grazing"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: true, baseAction: null },

  // ── Soil health ──
  { code: "CSAM2", name: "Multi-species winter cover crop", scheme: "SFI26", theme: "Soil health", payment: "£129/ha", paymentPerHa: 129, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "CSAM3", name: "Herbal leys", scheme: "SFI26", theme: "Soil health", payment: "£224/ha", paymentPerHa: 224, unit: "ha", duration: 3, landTypes: ["arable", "grass_improved"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "SOH1", name: "No-till farming", scheme: "SFI26", theme: "Soil health", payment: "£73/ha", paymentPerHa: 73, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "SOH3", name: "Multi-species summer-sown cover crop", scheme: "SFI26", theme: "Soil health", payment: "£163/ha", paymentPerHa: 163, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },

  // ── Waterbodies ──
  { code: "WBD1", name: "Manage ponds", scheme: "SFI26", theme: "Waterbodies", payment: "£257/pond", paymentPerHa: null, unit: "pond", duration: 3, landTypes: ["any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 257 },
  { code: "WBD2", name: "Manage ditches", scheme: "SFI26", theme: "Waterbodies", payment: "£4/100m", paymentPerHa: null, unit: "100m", duration: 3, landTypes: ["any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 4 },
  { code: "WBD3", name: "In-field grass strips", scheme: "SFI26", theme: "Waterbodies", payment: "£765/ha", paymentPerHa: 765, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: 25, isSupplemental: false, baseAction: null },
  { code: "WBD4", name: "Arable reversion to grassland with low fertiliser input", scheme: "SFI26", theme: "Waterbodies", payment: "£489/ha", paymentPerHa: 489, unit: "ha", duration: 3, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "WBD6", name: "Remove livestock from intensive grassland autumn/winter (outside SDAs)", scheme: "SFI26", theme: "Waterbodies", payment: "£115/ha", paymentPerHa: 115, unit: "ha", duration: 3, landTypes: ["grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "WBD7", name: "Remove livestock from grassland autumn/winter (SDAs)", scheme: "SFI26", theme: "Waterbodies", payment: "£115/ha", paymentPerHa: 115, unit: "ha", duration: 3, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
];

// ─── CS Higher Tier (selected options, invitation only) ─────────────

const CSHT_ACTIONS = [
  { code: "GS1", name: "Create and maintain species-rich grassland", scheme: "CSHT", theme: "Grassland", payment: "£280/ha", paymentPerHa: 280, unit: "ha", duration: 10, landTypes: ["arable", "grass_improved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "GS2", name: "Permanent grassland with very low inputs (outside SDAs)", scheme: "CSHT", theme: "Grassland", payment: "£132/ha", paymentPerHa: 132, unit: "ha", duration: 5, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "GS6", name: "Manage land for species-rich grassland", scheme: "CSHT", theme: "Grassland", payment: "£182/ha", paymentPerHa: 182, unit: "ha", duration: 5, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "GS7", name: "Restore species-rich grassland", scheme: "CSHT", theme: "Grassland", payment: "£426/ha", paymentPerHa: 426, unit: "ha", duration: 10, landTypes: ["grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AB1", name: "Nectar flower mix", scheme: "CSHT", theme: "Arable birds", payment: "£579/ha", paymentPerHa: 579, unit: "ha", duration: 5, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AB8", name: "Flower-rich margins and plots", scheme: "CSHT", theme: "Arable birds", payment: "£539/ha", paymentPerHa: 539, unit: "ha", duration: 5, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "AB9", name: "Winter bird food", scheme: "CSHT", theme: "Arable birds", payment: "£640/ha", paymentPerHa: 640, unit: "ha", duration: 5, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: true, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "BE3", name: "Management of hedgerows", scheme: "CSHT", theme: "Boundaries", payment: "£13/100m", paymentPerHa: null, unit: "100m", duration: 5, landTypes: ["hedgerow", "any"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null, paymentPerUnit: 13 },
  { code: "HS7", name: "Arable reversion to grassland on historic/archaeological sites", scheme: "CSHT", theme: "Heritage", payment: "£480/ha", paymentPerHa: 480, unit: "ha", duration: 10, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "SW1", name: "4–6m buffer strip on cultivated land", scheme: "CSHT", theme: "Water", payment: "£353/ha", paymentPerHa: 353, unit: "ha", duration: 5, landTypes: ["arable"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "WD1", name: "Woodland creation – native broadleaf", scheme: "CSHT", theme: "Woodland", payment: "£300/ha", paymentPerHa: 300, unit: "ha", duration: 15, landTypes: ["arable", "grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
];

// ─── Other schemes ──────────────────────────────────────────────────

const OTHER_ACTIONS = [
  { code: "EWCO", name: "England Woodland Creation Offer", scheme: "EWCO", theme: "Woodland creation", payment: "Up to £10,200/ha", paymentPerHa: 6800, unit: "ha", duration: 15, landTypes: ["arable", "grass_improved", "grass_unimproved"], slopeMax: null, minArea: 1, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
  { code: "BNG", name: "Biodiversity Net Gain (habitat creation)", scheme: "BNG", theme: "Biodiversity", payment: "Varies (market)", paymentPerHa: null, unit: "ha", duration: 30, landTypes: ["arable", "grass_improved", "grass_unimproved"], slopeMax: null, minArea: null, isRotational: false, areaCapPct: null, isSupplemental: false, baseAction: null },
];

// ─── Exports ────────────────────────────────────────────────────────

export const SCHEME_CATALOGUE = [...SFI26_ACTIONS, ...CSHT_ACTIONS, ...OTHER_ACTIONS];

export const SFI26_AGREEMENT_CAP = 100_000;
export const SFI26_AREA_CAP_PCT = 25;
export const SFI26_MIN_FARM_HA = 3;
export const SFI26_DURATION_YEARS = 3;

export const AREA_CAPPED_CODES = new Set(
  SCHEME_CATALOGUE.filter((a) => a.areaCapPct === 25).map((a) => a.code)
);

export const SCHEME_LABELS = {
  SFI26: "Sustainable Farming Incentive 2026",
  CSHT: "Countryside Stewardship Higher Tier",
  EWCO: "England Woodland Creation Offer",
  BNG: "Biodiversity Net Gain",
};

export const THEMES = [...new Set(SCHEME_CATALOGUE.map((a) => a.theme))].sort();

export function catalogueByScheme(scheme) {
  return SCHEME_CATALOGUE.filter((a) => a.scheme === scheme);
}

export function catalogueByTheme(theme) {
  return SCHEME_CATALOGUE.filter((a) => a.theme === theme);
}

/**
 * UK crop phenology catalogue.
 *
 * Each crop defines its typical growth stages with expected day-ranges
 * (days after planting) and NDVI envelopes [lo, hi] for each stage.
 * The engine uses these to:
 *   1. Determine the *expected* growth stage from planting date + crop type
 *   2. Set crop-specific NDVI expectations (not just universal thresholds)
 *   3. Flag anomalies relative to the crop's own calendar
 *   4. Power recommendations tied to the actual growth cycle
 *
 * All day ranges are approximate midpoints for UK conditions.
 */

export const CROP_CATALOGUE = {
  "Winter wheat": {
    id: "winter-wheat",
    family: "cereal",
    typicalSowWindow: [9, 11],   // Sep–Nov
    typicalHarvestWindow: [7, 8], // Jul–Aug
    cycleDays: 300,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 35],    ndvi: [0.12, 0.35] },
      { name: "tillering",   dayRange: [36, 120],   ndvi: [0.30, 0.55] },
      { name: "stem extension", dayRange: [121, 170], ndvi: [0.50, 0.75] },
      { name: "booting",     dayRange: [171, 200],  ndvi: [0.65, 0.85] },
      { name: "heading",     dayRange: [201, 220],  ndvi: [0.70, 0.90] },
      { name: "grain fill",  dayRange: [221, 265],  ndvi: [0.55, 0.85] },
      { name: "ripening",    dayRange: [266, 290],  ndvi: [0.25, 0.55] },
      { name: "harvest",     dayRange: [291, 320],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["Split: Feb tillering, Mar stem ext, Apr–May flag leaf"],
    keyRisks: ["Septoria", "Yellow rust", "Lodging", "BYDV (autumn)"],
  },
  "Spring wheat": {
    id: "spring-wheat",
    family: "cereal",
    typicalSowWindow: [2, 4],
    typicalHarvestWindow: [8, 9],
    cycleDays: 170,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 25],    ndvi: [0.12, 0.35] },
      { name: "tillering",   dayRange: [26, 60],   ndvi: [0.30, 0.55] },
      { name: "stem extension", dayRange: [61, 95], ndvi: [0.50, 0.75] },
      { name: "heading",     dayRange: [96, 120],   ndvi: [0.70, 0.90] },
      { name: "grain fill",  dayRange: [121, 150],  ndvi: [0.55, 0.85] },
      { name: "ripening",    dayRange: [151, 165],  ndvi: [0.25, 0.55] },
      { name: "harvest",     dayRange: [166, 180],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["Single or split: at drilling + GS30"],
    keyRisks: ["Septoria", "Fusarium", "Late drought"],
  },
  "Winter barley": {
    id: "winter-barley",
    family: "cereal",
    typicalSowWindow: [9, 10],
    typicalHarvestWindow: [7, 7],
    cycleDays: 280,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 30],    ndvi: [0.12, 0.35] },
      { name: "tillering",   dayRange: [31, 110],   ndvi: [0.30, 0.55] },
      { name: "stem extension", dayRange: [111, 155], ndvi: [0.50, 0.75] },
      { name: "heading",     dayRange: [156, 185],  ndvi: [0.70, 0.88] },
      { name: "grain fill",  dayRange: [186, 240],  ndvi: [0.50, 0.80] },
      { name: "ripening",    dayRange: [241, 270],  ndvi: [0.20, 0.50] },
      { name: "harvest",     dayRange: [271, 295],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["Split: Feb–Mar"],
    keyRisks: ["Rhynchosporium", "Net blotch", "Lodging"],
  },
  "Spring barley": {
    id: "spring-barley",
    family: "cereal",
    typicalSowWindow: [2, 4],
    typicalHarvestWindow: [8, 9],
    cycleDays: 150,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 20],    ndvi: [0.12, 0.35] },
      { name: "tillering",   dayRange: [21, 50],   ndvi: [0.30, 0.55] },
      { name: "stem extension", dayRange: [51, 80], ndvi: [0.50, 0.75] },
      { name: "heading",     dayRange: [81, 105],   ndvi: [0.70, 0.88] },
      { name: "grain fill",  dayRange: [106, 130],  ndvi: [0.50, 0.80] },
      { name: "ripening",    dayRange: [131, 145],  ndvi: [0.20, 0.50] },
      { name: "harvest",     dayRange: [146, 160],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["All at drilling for malting"],
    keyRisks: ["Ramularia", "Net blotch", "Brackling"],
  },
  "Winter oats": {
    id: "winter-oats",
    family: "cereal",
    typicalSowWindow: [9, 10],
    typicalHarvestWindow: [8, 8],
    cycleDays: 300,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 30],    ndvi: [0.12, 0.35] },
      { name: "tillering",   dayRange: [31, 120],   ndvi: [0.30, 0.55] },
      { name: "stem extension", dayRange: [121, 175], ndvi: [0.50, 0.75] },
      { name: "heading",     dayRange: [176, 210],  ndvi: [0.70, 0.88] },
      { name: "grain fill",  dayRange: [211, 265],  ndvi: [0.50, 0.80] },
      { name: "ripening",    dayRange: [266, 290],  ndvi: [0.20, 0.50] },
      { name: "harvest",     dayRange: [291, 310],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["Split: Feb + Apr"],
    keyRisks: ["Crown rust", "BYDV", "Lodging"],
  },
  "Spring oats": {
    id: "spring-oats",
    family: "cereal",
    typicalSowWindow: [2, 4],
    typicalHarvestWindow: [8, 9],
    cycleDays: 160,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 22],    ndvi: [0.12, 0.35] },
      { name: "tillering",   dayRange: [23, 55],   ndvi: [0.30, 0.55] },
      { name: "stem extension", dayRange: [56, 85], ndvi: [0.50, 0.75] },
      { name: "heading",     dayRange: [86, 110],   ndvi: [0.70, 0.88] },
      { name: "grain fill",  dayRange: [111, 140],  ndvi: [0.50, 0.80] },
      { name: "ripening",    dayRange: [141, 155],  ndvi: [0.20, 0.50] },
      { name: "harvest",     dayRange: [156, 170],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["At drilling + GS30"],
    keyRisks: ["Crown rust", "Frit fly"],
  },
  "Winter oilseed rape": {
    id: "wosr",
    family: "oilseed",
    typicalSowWindow: [8, 9],
    typicalHarvestWindow: [7, 8],
    cycleDays: 330,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 25],    ndvi: [0.12, 0.35] },
      { name: "rosette",     dayRange: [26, 140],   ndvi: [0.35, 0.65] },
      { name: "stem extension", dayRange: [141, 200], ndvi: [0.55, 0.80] },
      { name: "flowering",   dayRange: [201, 240],  ndvi: [0.40, 0.65] },
      { name: "pod fill",    dayRange: [241, 300],  ndvi: [0.35, 0.60] },
      { name: "ripening",    dayRange: [301, 325],  ndvi: [0.15, 0.40] },
      { name: "harvest",     dayRange: [326, 340],  ndvi: [0.05, 0.20] },
    ],
    nTimings: ["Autumn + Feb/Mar split"],
    keyRisks: ["Phoma", "Light leaf spot", "Cabbage stem flea beetle", "Sclerotinia"],
  },
  "Spring beans": {
    id: "spring-beans",
    family: "pulse",
    typicalSowWindow: [2, 3],
    typicalHarvestWindow: [8, 9],
    cycleDays: 180,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 25],    ndvi: [0.12, 0.30] },
      { name: "vegetative",  dayRange: [26, 70],   ndvi: [0.30, 0.55] },
      { name: "flowering",   dayRange: [71, 110],   ndvi: [0.55, 0.80] },
      { name: "pod fill",    dayRange: [111, 150],  ndvi: [0.45, 0.75] },
      { name: "ripening",    dayRange: [151, 175],  ndvi: [0.15, 0.40] },
      { name: "harvest",     dayRange: [176, 190],  ndvi: [0.05, 0.20] },
    ],
    nTimings: ["Zero N — legume"],
    keyRisks: ["Chocolate spot", "Bruchid beetle", "Rust"],
  },
  "Winter beans": {
    id: "winter-beans",
    family: "pulse",
    typicalSowWindow: [10, 11],
    typicalHarvestWindow: [8, 9],
    cycleDays: 280,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 30],    ndvi: [0.12, 0.30] },
      { name: "vegetative",  dayRange: [31, 140],   ndvi: [0.25, 0.55] },
      { name: "flowering",   dayRange: [141, 200],  ndvi: [0.55, 0.80] },
      { name: "pod fill",    dayRange: [201, 250],  ndvi: [0.45, 0.75] },
      { name: "ripening",    dayRange: [251, 275],  ndvi: [0.15, 0.40] },
      { name: "harvest",     dayRange: [276, 290],  ndvi: [0.05, 0.20] },
    ],
    nTimings: ["Zero N — legume"],
    keyRisks: ["Chocolate spot", "Downy mildew", "Bruchid beetle"],
  },
  "Peas": {
    id: "peas",
    family: "pulse",
    typicalSowWindow: [2, 4],
    typicalHarvestWindow: [7, 8],
    cycleDays: 140,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 20],    ndvi: [0.12, 0.30] },
      { name: "vegetative",  dayRange: [21, 55],   ndvi: [0.30, 0.60] },
      { name: "flowering",   dayRange: [56, 85],   ndvi: [0.55, 0.80] },
      { name: "pod fill",    dayRange: [86, 115],   ndvi: [0.45, 0.70] },
      { name: "ripening",    dayRange: [116, 135],  ndvi: [0.15, 0.40] },
      { name: "harvest",     dayRange: [136, 150],  ndvi: [0.05, 0.20] },
    ],
    nTimings: ["Zero N — legume"],
    keyRisks: ["Downy mildew", "Pea moth", "Ascochyta"],
  },
  "Maize": {
    id: "maize",
    family: "cereal",
    typicalSowWindow: [4, 5],
    typicalHarvestWindow: [9, 10],
    cycleDays: 170,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 25],    ndvi: [0.10, 0.30] },
      { name: "vegetative",  dayRange: [26, 70],   ndvi: [0.30, 0.60] },
      { name: "tasselling",  dayRange: [71, 100],   ndvi: [0.65, 0.90] },
      { name: "grain fill",  dayRange: [101, 145],  ndvi: [0.55, 0.85] },
      { name: "maturity",    dayRange: [146, 165],  ndvi: [0.25, 0.50] },
      { name: "harvest",     dayRange: [166, 180],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["At drilling or early side-dress"],
    keyRisks: ["Eyespot", "Fusarium stalk rot", "Late frost at emergence"],
  },
  "Sugar beet": {
    id: "sugar-beet",
    family: "root",
    typicalSowWindow: [3, 4],
    typicalHarvestWindow: [9, 11],
    cycleDays: 210,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 25],    ndvi: [0.10, 0.30] },
      { name: "canopy build", dayRange: [26, 80],   ndvi: [0.30, 0.65] },
      { name: "full canopy",  dayRange: [81, 150],  ndvi: [0.65, 0.90] },
      { name: "sugar storage", dayRange: [151, 195], ndvi: [0.50, 0.80] },
      { name: "senescence",   dayRange: [196, 210], ndvi: [0.25, 0.50] },
      { name: "harvest",     dayRange: [211, 230],  ndvi: [0.05, 0.25] },
    ],
    nTimings: ["At drilling"],
    keyRisks: ["Cercospora", "Virus yellows", "Aphids"],
  },
  "Potatoes": {
    id: "potatoes",
    family: "root",
    typicalSowWindow: [3, 4],
    typicalHarvestWindow: [8, 10],
    cycleDays: 170,
    stages: [
      { name: "planting",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 30],    ndvi: [0.10, 0.30] },
      { name: "canopy build", dayRange: [31, 65],   ndvi: [0.35, 0.65] },
      { name: "full canopy",  dayRange: [66, 110],  ndvi: [0.70, 0.92] },
      { name: "tuber bulking", dayRange: [111, 145], ndvi: [0.55, 0.85] },
      { name: "senescence",   dayRange: [146, 165], ndvi: [0.20, 0.50] },
      { name: "harvest",     dayRange: [166, 185],  ndvi: [0.05, 0.20] },
    ],
    nTimings: ["At planting, occasionally split"],
    keyRisks: ["Late blight", "PCN", "Blackleg"],
  },
  "Grass ley": {
    id: "grass-ley",
    family: "grass",
    typicalSowWindow: [3, 9],
    typicalHarvestWindow: [5, 10],
    cycleDays: 365,
    stages: [
      { name: "establishment", dayRange: [0, 30],   ndvi: [0.15, 0.35] },
      { name: "growing",      dayRange: [31, 365],  ndvi: [0.40, 0.80] },
    ],
    nTimings: ["Split across cuts: Mar, May, Jul"],
    keyRisks: ["Poaching", "Leatherjackets", "Clover rot"],
  },
  "Permanent pasture": {
    id: "permanent-pasture",
    family: "grass",
    typicalSowWindow: [1, 12],
    typicalHarvestWindow: [1, 12],
    cycleDays: 365,
    stages: [
      { name: "dormant",     dayRange: [0, 60],    ndvi: [0.20, 0.40] },
      { name: "spring flush", dayRange: [61, 150],  ndvi: [0.45, 0.80] },
      { name: "summer",      dayRange: [151, 270],  ndvi: [0.40, 0.75] },
      { name: "autumn",      dayRange: [271, 330],  ndvi: [0.30, 0.55] },
      { name: "winter",      dayRange: [331, 365],  ndvi: [0.20, 0.40] },
    ],
    nTimings: ["Low input — 0–100 kg N/ha/yr in splits"],
    keyRisks: ["Poaching", "Rushes", "Overgrazing"],
  },
  "Cover crop": {
    id: "cover-crop",
    family: "cover",
    typicalSowWindow: [8, 9],
    typicalHarvestWindow: [2, 3],
    cycleDays: 180,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "establishment", dayRange: [8, 30],   ndvi: [0.15, 0.40] },
      { name: "peak biomass", dayRange: [31, 120],  ndvi: [0.40, 0.70] },
      { name: "winter kill/senesce", dayRange: [121, 170], ndvi: [0.15, 0.45] },
      { name: "termination",  dayRange: [171, 185], ndvi: [0.05, 0.25] },
    ],
    nTimings: ["Zero N"],
    keyRisks: ["Poor establishment", "Slug damage", "Delayed termination"],
  },
  "Linseed": {
    id: "linseed",
    family: "oilseed",
    typicalSowWindow: [3, 4],
    typicalHarvestWindow: [8, 9],
    cycleDays: 160,
    stages: [
      { name: "drilling",    dayRange: [0, 7],     ndvi: [0.05, 0.18] },
      { name: "emergence",   dayRange: [8, 22],    ndvi: [0.12, 0.30] },
      { name: "vegetative",  dayRange: [23, 60],   ndvi: [0.30, 0.55] },
      { name: "flowering",   dayRange: [61, 95],   ndvi: [0.45, 0.70] },
      { name: "capsule fill", dayRange: [96, 135],  ndvi: [0.35, 0.60] },
      { name: "ripening",    dayRange: [136, 155],  ndvi: [0.15, 0.35] },
      { name: "harvest",     dayRange: [156, 170],  ndvi: [0.05, 0.20] },
    ],
    nTimings: ["40–60 kg N/ha at drilling"],
    keyRisks: ["Alternaria", "Pasmo", "Sclerotinia"],
  },
};

export const CROP_NAMES = Object.keys(CROP_CATALOGUE).sort();

/**
 * Get the expected growth stage for a crop given days since planting.
 * Returns { stageName, ndviExpected: [lo, hi], progress (0-1 within stage) }
 * or null if no match.
 */
export function expectedStage(cropName, daysSincePlanting) {
  const crop = CROP_CATALOGUE[cropName];
  if (!crop || !Number.isFinite(daysSincePlanting) || daysSincePlanting < 0) return null;

  const stages = crop.stages;
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    if (daysSincePlanting >= s.dayRange[0]) {
      const span = s.dayRange[1] - s.dayRange[0];
      const progress = span > 0
        ? Math.min(1, (daysSincePlanting - s.dayRange[0]) / span)
        : 1;
      return {
        stageName: s.name,
        stageIndex: i,
        totalStages: stages.length,
        ndviExpected: s.ndvi,
        progress,
        isLate: daysSincePlanting > s.dayRange[1],
      };
    }
  }
  return null;
}

/**
 * Calculate days since planting.
 */
export function daysSincePlanting(plantingDateIso, now = Date.now()) {
  if (!plantingDateIso) return null;
  const t = new Date(plantingDateIso).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * Get the crop-specific NDVI expectation for the current time.
 * Falls back to universal thresholds if crop/planting data unavailable.
 */
export function cropNdviExpectation(cropName, plantingDateIso, now = Date.now()) {
  const days = daysSincePlanting(plantingDateIso, now);
  if (days == null) return null;
  const stage = expectedStage(cropName, days);
  if (!stage) return null;
  return {
    lo: stage.ndviExpected[0],
    hi: stage.ndviExpected[1],
    stageName: stage.stageName,
    daysSincePlanting: days,
    progress: stage.progress,
    isLate: stage.isLate,
    stageIndex: stage.stageIndex,
    totalStages: stage.totalStages,
  };
}

/**
 * Map a generic stage name (from phenology) to a simplified stage key
 * compatible with the existing health system's stage vocabulary.
 */
export function phenologyToHealthStage(stageName) {
  if (!stageName) return "unknown";
  const s = stageName.toLowerCase();
  if (s === "drilling" || s === "planting") return "bare";
  if (s === "emergence" || s === "establishment") return "emerging";
  if (s.includes("harvest") || s === "termination") return "harvested";
  if (s.includes("ripen") || s.includes("senesce") || s === "maturity" || s === "winter kill/senesce") return "senescing";
  if (s.includes("peak") || s === "full canopy" || s === "heading" || s === "tasselling" || s === "flowering") return "peak";
  return "growing";
}

/**
 * Summarise the expected crop timeline for display.
 */
export function cropTimeline(cropName) {
  const crop = CROP_CATALOGUE[cropName];
  if (!crop) return null;
  return {
    name: cropName,
    family: crop.family,
    cycleDays: crop.cycleDays,
    stages: crop.stages.map((s) => ({
      name: s.name,
      startDay: s.dayRange[0],
      endDay: s.dayRange[1],
      ndviLo: s.ndvi[0],
      ndviHi: s.ndvi[1],
    })),
    nTimings: crop.nTimings,
    keyRisks: crop.keyRisks,
    sowMonths: crop.typicalSowWindow,
    harvestMonths: crop.typicalHarvestWindow,
  };
}

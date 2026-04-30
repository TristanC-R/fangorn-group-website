/**
 * Tilth workspace design tokens. Shared with the marketing site palette in
 * `src/components/FangornWebsite.jsx` so Tilth feels native to Fangorn.
 */

export const brand = {
  sage: "#C3D3C4",
  muted: "#839788",
  forest: "#104E3F",
  forestDeep: "#0A3A2F",
  moss: "#649A5C",
  mossDark: "#4A8443",
  orange: "#EC9A29",
  amber: "#D98119",
  body: "#3A4F47",
  bodySoft: "#54695F",
  bgSection: "#EFF4F0",
  bgCard: "#FFFFFF",
  bgInk: "#0E2A24",
  border: "#D5E5D7",
  borderSoft: "#DCE9DE",
  tagBorder: "#CADBD0",
  white: "#FFFFFF",
  danger: "#B4412E",
  dangerSoft: "#F5E1DC",
  warn: "#C07C12",
  warnSoft: "#FBEAC9",
  ok: "#3F7A4A",
  okSoft: "#DCEBDE",
  info: "#2F6077",
  infoSoft: "#DCE7EE",
};

export const fonts = {
  serif: "'Instrument Serif', Georgia, serif",
  sans: "'DM Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

export const shadow = {
  card: "0 18px 70px rgba(16,78,63,0.06)",
  cardDeep: "0 24px 80px rgba(16,78,63,0.12)",
  inset: "inset 0 0 0 1px rgba(16,78,63,0.04)",
};

export const radius = { base: 2, pill: 999 };

export const inputStyle = {
  width: "100%",
  fontFamily: fonts.sans,
  fontSize: 14,
  fontWeight: 400,
  color: brand.body,
  padding: "10px 12px",
  border: `1px solid ${brand.border}`,
  borderRadius: radius.base,
  background: brand.bgCard,
  boxSizing: "border-box",
};

export const SECTION_IDS = [
  "home",
  "fields",
  "weather",
  "calendar",
  "livestock",
  "records",
  "submissions",
  "yield",
  "rotation",
  "observations",
  "inventory",
  "insights",
  "compare",
  "sensing",
  "soil",
  "costs",
  "market",
  "reports",
  "compliance",
  "audit",
  "finance",
  "documents",
  "contacts",
  "team",
];

export const SECTIONS = {
  home: {
    id: "home",
    label: "Today",
    kicker: "Dashboard",
    blurb: "Actionable daily snapshot of the farm.",
  },
  fields: {
    id: "fields",
    label: "Fields",
    kicker: "Mapping",
    blurb: "Boundaries, registry, history.",
  },
  records: {
    id: "records",
    label: "Records",
    kicker: "Operations",
    blurb: "Inputs, sprays, compliance.",
  },
  submissions: {
    id: "submissions",
    label: "Scheme claims",
    kicker: "Funding & schemes",
    blurb: "SFI26, CS & environmental funding.",
  },
  yield: {
    id: "yield",
    label: "Yield",
    kicker: "Harvest",
    blurb: "Upload, clean, compare.",
  },
  rotation: {
    id: "rotation",
    label: "Rotation",
    kicker: "Planning",
    blurb: "Multi-year crop rotation planner.",
  },
  observations: {
    id: "observations",
    label: "Observations",
    kicker: "Field notes",
    blurb: "Photos, disease, pest & weed logs.",
  },
  insights: {
    id: "insights",
    label: "Crop health",
    kicker: "Analysis",
    blurb: "Crop health, yield analytics, and field comparison.",
  },
  compare: {
    id: "compare",
    label: "Compare",
    kicker: "Analysis",
    blurb: "Side-by-side field comparison.",
  },
  sensing: {
    id: "sensing",
    label: "Satellite maps",
    kicker: "Satellite",
    blurb: "NDVI, radar, and terrain data.",
  },
  soil: {
    id: "soil",
    label: "Soil & land",
    kicker: "Environmental",
    blurb: "Soil, geology & land-use overlays.",
  },
  weather: {
    id: "weather",
    label: "Weather",
    kicker: "Forecast",
    blurb: "7-day forecast, spray windows & GDD.",
  },
  reports: {
    id: "reports",
    label: "Reports",
    kicker: "Reporting",
    blurb: "Weekly, monthly & quarterly reports.",
  },
  compliance: {
    id: "compliance",
    label: "Compliance",
    kicker: "Exports",
    blurb: "NVZ, input diary & scheme claim packs.",
  },
  costs: {
    id: "costs",
    label: "Margins",
    kicker: "Finance",
    blurb: "Yield vs input cost analysis.",
  },
  team: {
    id: "team",
    label: "Team",
    kicker: "Access",
    blurb: "Invite agronomists, contractors & staff.",
  },
  calendar: {
    id: "calendar",
    label: "Calendar",
    kicker: "Planning",
    blurb: "Tasks, deadlines & spray windows.",
  },
  livestock: {
    id: "livestock",
    label: "Livestock",
    kicker: "Animals",
    blurb: "Register, movements, medicines & breeding.",
  },
  inventory: {
    id: "inventory",
    label: "Store",
    kicker: "Inventory",
    blurb: "Chemical, seed, fertiliser & fuel stock.",
  },
  finance: {
    id: "finance",
    label: "Finance",
    kicker: "Money",
    blurb: "Income, expenses, VAT & profit/loss.",
  },
  documents: {
    id: "documents",
    label: "Docs",
    kicker: "Vault",
    blurb: "Certificates, receipts & compliance evidence.",
  },
  contacts: {
    id: "contacts",
    label: "Contacts",
    kicker: "Directory",
    blurb: "Suppliers, agronomist, vet & merchants.",
  },
  market: {
    id: "market",
    label: "Market",
    kicker: "Prices",
    blurb: "Grain, livestock & input price tracking.",
  },
  audit: {
    id: "audit",
    label: "Audit",
    kicker: "Inspections",
    blurb: "Red Tractor, NVZ & cross-compliance checklists.",
  },
};

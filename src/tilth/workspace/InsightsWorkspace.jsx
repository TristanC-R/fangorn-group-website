import { useEffect, useMemo, useState } from "react";
import { brand, fonts } from "../ui/theme.js";
import { HealthWorkspace } from "./HealthWorkspace.jsx";
import { AnalyticsWorkspace } from "./AnalyticsWorkspace.jsx";
import { useFarmHealth } from "../../lib/cropHealth.js";
import { tilthStore } from "../state/localStore.js";

const TABS = [
  { id: "health", label: "Crop health", sub: "What needs attention" },
  { id: "analytics", label: "Farm analytics", sub: "Satellite · inputs · yield · soil" },
];

const panelStyle = (visible) => ({
  flex: "1 1 auto",
  minHeight: 0,
  display: visible ? "flex" : "none",
  flexDirection: "column",
  overflow: "hidden",
});

export function InsightsWorkspace({ farm, fields, onNavigate }) {
  const [tab, setTab] = useState("health");

  const mappedFields = useMemo(
    () => (fields || []).filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3),
    [fields],
  );

  const [plantingsMap, setPlantingsMap] = useState(() => tilthStore.loadPlantings(farm?.id));
  useEffect(() => {
    setPlantingsMap(tilthStore.loadPlantings(farm?.id));
  }, [farm?.id]);

  const farmHealth = useFarmHealth(mappedFields, plantingsMap);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{
        display: "flex",
        gap: 0,
        borderBottom: `1px solid ${brand.border}`,
        background: brand.white,
        padding: "0 16px",
        flex: "0 0 auto",
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              fontFamily: fonts.sans,
              fontSize: 12.5,
              fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? brand.forest : brand.muted,
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${tab === t.id ? brand.forest : "transparent"}`,
              padding: "12px 16px 10px",
              cursor: "pointer",
              letterSpacing: "-0.005em",
              transition: "color 120ms ease, border-color 120ms ease",
            }}
          >
            <span>{t.label}</span>
            <span style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: tab === t.id ? brand.bodySoft : brand.muted,
              marginLeft: 8,
              display: "inline",
            }}>{t.sub}</span>
          </button>
        ))}
      </div>

      <div style={panelStyle(tab === "health")}>
        <HealthWorkspace farm={farm} fields={mappedFields} farmHealth={farmHealth} onNavigate={onNavigate} />
      </div>
      <div style={panelStyle(tab === "analytics")}>
        <AnalyticsWorkspace farm={farm} fields={mappedFields} farmHealth={farmHealth} />
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { brand, fonts } from "../ui/theme.js";
import { SatelliteWorkspace } from "./SatelliteWorkspace.jsx";
import { SarWorkspace } from "./SarWorkspace.jsx";
import { TopographyWorkspace } from "./TopographyWorkspace.jsx";
import { useMediaQuery } from "../ui/mobileUx.js";

const TABS = [
  { id: "ndvi", label: "Optical insights", sub: "Sentinel-2" },
  { id: "radar", label: "Radar", sub: "Sentinel-1 SAR" },
  { id: "terrain", label: "Terrain", sub: "Copernicus DEM 30 m" },
];

const panelStyle = (visible) => ({
  flex: "1 1 auto",
  minHeight: 0,
  display: visible ? "flex" : "none",
  flexDirection: "column",
  overflow: "hidden",
});

export function RemoteSensingWorkspace({ farm, fields }) {
  const [tab, setTab] = useState("ndvi");
  const mobile = useMediaQuery("(max-width: 760px)");
  const visibleTabs = mobile ? TABS.filter((t) => t.id === "ndvi") : TABS;

  useEffect(() => {
    if (mobile && tab !== "ndvi") setTab("ndvi");
  }, [mobile, tab]);

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
        {visibleTabs.map(t => (
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

      {/* All panels stay mounted so state + data are preserved across tab switches */}
      <div style={panelStyle(tab === "ndvi")}>
        <SatelliteWorkspace farm={farm} fields={fields} />
      </div>
      {!mobile && <div style={panelStyle(tab === "radar")}>
        <SarWorkspace farm={farm} fields={fields} />
      </div>}
      {!mobile && <div style={panelStyle(tab === "terrain")}>
        <TopographyWorkspace farm={farm} fields={fields} />
      </div>}
    </div>
  );
}

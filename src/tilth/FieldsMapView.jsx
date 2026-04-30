import { useEffect, useMemo, useState } from "react";
import { getTilthApiBase } from "../lib/tilthApi.js";
import { ringCentroid } from "./geoPointInPolygon.js";
import { FieldMapThree2D } from "./FieldMapThree2D.jsx";

const brand = {
  muted: "#839788",
  forest: "#104E3F",
  moss: "#649A5C",
  bodySoft: "#54695F",
  bgSection: "#EFF4F0",
  border: "#D5E5D7",
  white: "#FFFFFF",
};

function bestInitialCenter(farm, fields) {
  const first = Array.isArray(fields) ? fields.find((f) => Array.isArray(f.boundary) && f.boundary.length >= 3) : null;
  if (first) {
    const c = ringCentroid(first.boundary);
    return { lat: c.lat, lng: c.lng, zoom: 16 };
  }
  if (farm?.postcode && farm?.country) return { lat: 54, lng: -2, zoom: 6 };
  return { lat: 54, lng: -2, zoom: 6 };
}

async function geocodeFarmToView(farm, signal) {
  const parts = [
    farm?.address_line1,
    farm?.address_line2,
    farm?.city,
    farm?.region,
    farm?.postcode,
    farm?.country,
  ]
    .filter(Boolean)
    .join(", ");
  if (!parts.trim()) return null;

  const api = getTilthApiBase();
  const p = new URLSearchParams({ format: "json", limit: "1", q: parts });
  const url = api
    ? `${api}/api/nominatim/search?${p.toString()}`
    : `https://nominatim.openstreetmap.org/search?${p.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) return null;
  const json = await res.json();
  const hit = Array.isArray(json) ? json[0] : null;
  const lat = hit?.lat ? parseFloat(hit.lat) : NaN;
  const lng = hit?.lon ? parseFloat(hit.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, zoom: 15 };
}

export function FieldsMapView({ farm, fields, onBack }) {
  const [view, setView] = useState(() => bestInitialCenter(farm, fields));
  const [note, setNote] = useState(null);

  const items = useMemo(() => {
    const arr = Array.isArray(fields) ? fields : [];
    return arr
      .filter((f) => Array.isArray(f.boundary) && f.boundary.length >= 3)
      .map((f) => ({
        id: f.id,
        name: f.name,
        boundary: f.boundary,
        centroid: ringCentroid(f.boundary),
      }));
  }, [fields]);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setNote(null);
    // If we already have at least one field, the centroid-based view is fine.
    if (items.length > 0) return () => ac.abort();
    (async () => {
      try {
        setNote("Locating your farm on the map…");
        const v = await geocodeFarmToView(farm, ac.signal);
        if (cancelled || !v) return;
        setView(v);
        setNote(null);
      } catch {
        if (!cancelled) setNote("Could not locate farm — pan the map manually.");
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [farm, items.length]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 20px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: brand.moss,
              marginBottom: 8,
            }}
          >
            Fields
          </div>
          <div
            style={{
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: "clamp(28px, 4.5vw, 40px)",
              fontWeight: 400,
              color: brand.forest,
              letterSpacing: "-0.02em",
              lineHeight: 1.1,
            }}
          >
            {farm?.name ? farm.name : "Your farm"}
          </div>
        </div>
        <button
          type="button"
          onClick={onBack}
          style={{
            fontFamily: "'DM Sans', system-ui, sans-serif",
            fontSize: 12,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            padding: "10px 12px",
            borderRadius: 2,
            border: `1px solid ${brand.border}`,
            background: brand.white,
            color: brand.forest,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Back
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 320px)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div>
          <FieldMapThree2D
            key={`${view.lat.toFixed(6)}-${view.lng.toFixed(6)}-${view.zoom}`}
            center={[view.lat, view.lng]}
            zoom={view.zoom}
            savedFields={fields || []}
            draftRing={[]}
            mapMode="pan"
            onAddVertex={() => {}}
            onFindFieldClick={() => {}}
          />
          {note ? (
            <div
              style={{
                marginTop: 10,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10,
                color: brand.muted,
                lineHeight: 1.55,
              }}
            >
              {note}
            </div>
          ) : null}
        </div>

        <div
          style={{
            border: `1px solid ${brand.border}`,
            borderRadius: 2,
            background: brand.white,
            padding: 16,
          }}
        >
          <div
            style={{
              fontFamily: "'DM Sans', system-ui, sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: brand.forest,
              marginBottom: 10,
            }}
          >
            Your fields ({items.length})
          </div>
          {items.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {items.map((f) => (
                <button
                  key={f.id || f.name}
                  type="button"
                  onClick={() => setView({ lat: f.centroid.lat, lng: f.centroid.lng, zoom: 18 })}
                  style={{
                    textAlign: "left",
                    fontFamily: "'DM Sans', system-ui, sans-serif",
                    fontSize: 13,
                    padding: "10px 12px",
                    borderRadius: 2,
                    border: `1px solid ${brand.border}`,
                    background: brand.bgSection,
                    color: brand.forest,
                    cursor: "pointer",
                  }}
                >
                  {f.name || "Unnamed field"}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 13, color: brand.bodySoft, lineHeight: 1.5 }}>
              No fields saved yet.
            </div>
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .tilth-fields-map-layout { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}


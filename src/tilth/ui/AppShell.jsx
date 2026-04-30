import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import treeLogo from "../../../Fangorn Assets/Grey logo tree only.png";
import { brand, fonts, radius, SECTIONS } from "./theme.js";

const SIDEBAR_WIDTH = 220;
const HEADER_HEIGHT = 56;
const NAV_MODE_KEY = "tilth_nav_mode";

const NAV_GROUPS = {
  simple: [
    { title: "Start here", sections: ["home", "calendar", "fields", "weather"] },
    { title: "Daily work", sections: ["livestock", "records", "inventory", "observations", "insights"] },
    { title: "Money & paperwork", sections: ["finance", "documents", "contacts", "reports"] },
    { title: "Rules", sections: ["compliance", "audit", "team"] },
  ],
  full: [
    { title: "Start here", sections: ["home", "calendar", "fields", "weather"] },
    { title: "Crops", sections: ["records", "yield", "rotation", "observations", "submissions"] },
    { title: "Animals & store", sections: ["livestock", "inventory"] },
    { title: "Business", sections: ["finance", "costs", "market", "documents", "contacts", "reports"] },
    { title: "Advanced maps", sections: ["insights", "compare", "sensing", "soil"] },
    { title: "Admin", sections: ["compliance", "audit", "team"] },
  ],
};

function NavItem({ section, isActive, onSelect }) {
  const meta = SECTIONS[section];
  if (!meta) return null;
  return (
    <button
      type="button"
      onClick={() => onSelect(section)}
      aria-current={isActive ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: radius.base,
        border: `1px solid ${isActive ? brand.forest : "transparent"}`,
        background: isActive ? brand.bgSection : "transparent",
        color: brand.forest,
        cursor: "pointer",
        fontFamily: fonts.sans,
        fontSize: 13.5,
        fontWeight: isActive ? 600 : 450,
        letterSpacing: "-0.005em",
        lineHeight: 1.25,
        transition: "border-color 140ms ease, background 140ms ease",
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {meta.label}
      </span>
      {isActive ? (
        <span
          aria-hidden
          style={{
            width: 5,
            height: 5,
            background: brand.moss,
            borderRadius: radius.pill,
            flexShrink: 0,
          }}
        />
      ) : null}
    </button>
  );
}

function NavGroup({ title, sections, active, onSelect }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: brand.muted,
          padding: "0 10px 5px",
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        {sections.map((s) => (
          <NavItem key={s} section={s} isActive={active === s} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

export function AppShell({
  user,
  farm,
  activeSection,
  onSelectSection,
  onSignOut,
  children,
  showNav = true,
  statusBadge,
  notificationCount = 0,
  onFieldMode,
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [navMode, setNavMode] = useState(() => {
    try {
      return window.localStorage.getItem(NAV_MODE_KEY) || "simple";
    } catch {
      return "simple";
    }
  });

  // Prevent the page itself from scrolling while the app shell is mounted.
  // Workspaces handle their own internal scroll inside panels.
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  const handleSelect = (s) => {
    setMobileOpen(false);
    onSelectSection?.(s);
  };

  const setMode = (mode) => {
    setNavMode(mode);
    try {
      window.localStorage.setItem(NAV_MODE_KEY, mode);
    } catch {
      /* private mode */
    }
  };

  const navGroups = NAV_GROUPS[navMode] || NAV_GROUPS.simple;

  return (
    <div
      style={{
        height: "100dvh",
        width: "100%",
        background: brand.white,
        color: brand.body,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=JetBrains+Mono:wght@300;400&display=swap');
        .tilth-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .tilth-scroll::-webkit-scrollbar-thumb { background: ${brand.borderSoft}; border-radius: 4px; }
        .tilth-scroll::-webkit-scrollbar-thumb:hover { background: ${brand.tagBorder}; }
        @media (max-width: 1180px) {
          .tilth-shell-grid { grid-template-columns: 1fr !important; }
          .tilth-sidebar { display: none !important; }
          .tilth-sidebar.open { display: block !important; position: absolute; top: ${HEADER_HEIGHT}px; bottom: 0; left: 0; right: 0; z-index: 40; overflow-y: auto; }
          .tilth-mobile-toggle { display: inline-flex !important; }
        }
        .tilth-mobile-live-map { display: none !important; }
        @media (max-width: 720px) {
          .tilth-shell-actions { display: none !important; }
          .tilth-mobile-live-map { display: inline-flex !important; }
          main input:not([type="checkbox"]):not([type="radio"]),
          main select,
          main textarea {
            min-height: 46px !important;
            font-size: 16px !important;
            padding: 12px 13px !important;
            border-radius: 8px !important;
          }
          main textarea {
            min-height: 96px !important;
            line-height: 1.45 !important;
          }
          main button:not(.tilth-icon-button),
          main a[role="button"] {
            min-height: 44px;
            border-radius: 8px !important;
            touch-action: manipulation;
          }
          main label {
            min-height: 32px;
          }
          .tilth-mobile-stack {
            grid-template-columns: 1fr !important;
          }
          .tilth-mobile-actions {
            display: grid !important;
            grid-template-columns: 1fr !important;
            width: 100%;
          }
          .tilth-mobile-actions > * {
            width: 100% !important;
          }
          .tilth-mobile-card {
            padding: 14px !important;
          }
          .tilth-mobile-hide {
            display: none !important;
          }
          .tilth-workspace-frame {
            padding: 10px !important;
            gap: 10px !important;
          }
        }
        @media (max-width: 480px) {
          .tilth-sidebar.open button { padding: 10px 14px !important; font-size: 14px !important; min-height: 44px; }
        }
      `}</style>

      <header
        style={{
          height: HEADER_HEIGHT,
          flex: `0 0 ${HEADER_HEIGHT}px`,
          background: brand.white,
          borderBottom: `1px solid ${brand.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 12,
        }}
      >
        <button
          type="button"
          className="tilth-mobile-toggle"
          onClick={() => setMobileOpen((o) => !o)}
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          style={{
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            border: `1px solid ${brand.border}`,
            background: brand.white,
            borderRadius: radius.base,
            color: brand.forest,
            cursor: "pointer",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            {mobileOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <img
            src={treeLogo}
            alt="Fangorn"
            style={{ height: 30, width: "auto", objectFit: "contain", display: "block" }}
          />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 9.5,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: brand.muted,
                lineHeight: 1.1,
              }}
            >
              Tilth {statusBadge ? null : <span style={{ color: brand.moss }}>· beta</span>}
            </div>
            <div
              style={{
                fontFamily: fonts.serif,
                fontSize: 16,
                letterSpacing: "-0.01em",
                color: brand.forest,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                lineHeight: 1.15,
              }}
            >
              {farm?.name || "Farm management"}
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {onFieldMode ? (
          <button
            type="button"
            className="tilth-mobile-live-map"
            onClick={onFieldMode}
            style={{
              alignItems: "center",
              justifyContent: "center",
              fontFamily: fonts.mono,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.white,
              background: brand.forest,
              border: `1px solid ${brand.forest}`,
              borderRadius: 8,
              padding: "8px 10px",
              minHeight: 38,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Live
          </button>
        ) : null}

        <div className="tilth-shell-actions" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {onFieldMode ? (
            <button
              type="button"
              onClick={onFieldMode}
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: brand.forest,
                padding: "6px 9px",
                borderRadius: radius.base,
                border: `1px solid ${brand.forest}`,
                background: brand.white,
                cursor: "pointer",
              }}
            >
              Live map
            </button>
          ) : null}

          {notificationCount > 0 ? (
            <button
              type="button"
              onClick={() => handleSelect("home")}
              style={{
                position: "relative",
                fontFamily: fonts.mono,
                fontSize: 10,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: brand.danger,
                padding: "6px 9px",
                borderRadius: radius.base,
                border: `1px solid ${brand.dangerSoft}`,
                background: brand.dangerSoft,
                cursor: "pointer",
              }}
            >
              {notificationCount} alert{notificationCount === 1 ? "" : "s"}
            </button>
          ) : null}

          {statusBadge ? (
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: brand.moss,
                padding: "6px 9px",
                borderRadius: radius.base,
                border: `1px solid ${brand.border}`,
                background: brand.bgSection,
              }}
            >
              {statusBadge}
            </div>
          ) : null}

          <Link
            to="/"
            style={{
              fontFamily: fonts.sans,
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.muted,
              textDecoration: "none",
              padding: "7px 10px",
              borderRadius: radius.base,
              border: `1px solid ${brand.border}`,
              background: brand.white,
            }}
          >
            Fangorn
          </Link>

          {user ? (
            <>
              <div
                title={user.email || ""}
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10.5,
                  color: brand.bodySoft,
                  padding: "7px 10px",
                  borderRadius: radius.base,
                  border: `1px solid ${brand.border}`,
                  background: brand.white,
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {user.email || "Signed in"}
              </div>
              <button
                type="button"
                onClick={onSignOut}
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: brand.white,
                  background: brand.forest,
                  border: `1px solid ${brand.forest}`,
                  padding: "7px 10px",
                  borderRadius: radius.base,
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div
        className="tilth-shell-grid"
        style={{
          display: "grid",
          gridTemplateColumns: showNav ? `${SIDEBAR_WIDTH}px minmax(0, 1fr)` : "minmax(0, 1fr)",
          flex: "1 1 auto",
          minHeight: 0,
          position: "relative",
        }}
      >
        {showNav ? (
          <aside
            className={`tilth-sidebar tilth-scroll ${mobileOpen ? "open" : ""}`}
            style={{
              borderRight: `1px solid ${brand.border}`,
              background: brand.white,
              padding: "14px 12px 72px",
              height: "100%",
              overflowY: "auto",
              minHeight: 0,
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 4,
                padding: "0 0 14px",
                marginBottom: 12,
                borderBottom: `1px solid ${brand.border}`,
              }}
            >
              {[
                ["simple", "Simple"],
                ["full", "Full"],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMode(mode)}
                  aria-pressed={navMode === mode}
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 9.5,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: navMode === mode ? brand.white : brand.forest,
                    background: navMode === mode ? brand.forest : brand.white,
                    border: `1px solid ${navMode === mode ? brand.forest : brand.border}`,
                    borderRadius: radius.base,
                    padding: "7px 8px",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {navGroups.map((group) => (
              <NavGroup
                key={group.title}
                title={group.title}
                sections={group.sections}
                active={activeSection}
                onSelect={handleSelect}
              />
            ))}
          </aside>
        ) : null}

        <main
          style={{
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflowX: "hidden",
            overflowY: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

import { Fragment, useEffect, useRef } from "react";
import { brand, fonts, radius, shadow } from "./theme.js";
import { useMediaQuery } from "./mobileUx.js";

/**
 * Small overline label. Matches the `kicker` motif used across the Fangorn
 * marketing site (mono, uppercase, wide-tracked moss-green text).
 */
export function Kicker({ children, color, style }) {
  return (
    <div
      className="tilth-workspace-frame"
      style={{
        fontFamily: fonts.mono,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: color || brand.moss,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Headline({ as, children, size = "lg", style }) {
  const Tag = as || "h1";
  const sizes = {
    xl: "clamp(36px, 6vw, 56px)",
    lg: "clamp(28px, 5vw, 44px)",
    md: "clamp(24px, 3.4vw, 32px)",
    sm: "clamp(20px, 2.6vw, 24px)",
  };
  return (
    <Tag
      style={{
        fontFamily: fonts.serif,
        fontSize: sizes[size] || sizes.lg,
        fontWeight: 400,
        letterSpacing: "-0.02em",
        lineHeight: 1.08,
        color: brand.forest,
        margin: 0,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

export function Body({ children, size = "md", color, style }) {
  const sizes = { lg: 18, md: 15, sm: 13 };
  return (
    <p
      style={{
        fontFamily: fonts.sans,
        fontSize: sizes[size] || sizes.md,
        fontWeight: 300,
        lineHeight: 1.7,
        color: color || brand.bodySoft,
        margin: 0,
        ...style,
      }}
    >
      {children}
    </p>
  );
}

export function Card({
  children,
  padding = 18,
  tone = "white",
  elevated,
  interactive,
  onClick,
  as,
  style,
  ...rest
}) {
  const bg = tone === "section" ? brand.bgSection : brand.white;
  const Tag = as || (onClick ? "button" : "div");
  const isButton = Tag === "button";
  return (
    <Tag
      type={isButton ? "button" : undefined}
      onClick={onClick}
      style={{
        border: `1px solid ${brand.border}`,
        background: bg,
        borderRadius: radius.base,
        padding,
        boxShadow: elevated ? shadow.card : "none",
        textAlign: "left",
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        cursor: interactive || onClick ? "pointer" : "default",
        transition: "box-shadow 160ms ease, transform 160ms ease, border-color 160ms ease",
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function SectionHeader({ kicker, title, description, actions, style, compact = false }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: compact ? 0 : 16,
        ...style,
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 320px" }}>
        {kicker ? <Kicker style={{ marginBottom: compact ? 4 : 8 }}>{kicker}</Kicker> : null}
        {title ? (
          <Headline size={compact ? "sm" : "md"} style={{ fontSize: compact ? 24 : undefined }}>
            {title}
          </Headline>
        ) : null}
        {description ? (
          <Body
            size="sm"
            style={{ marginTop: 6, maxWidth: 780, lineHeight: 1.55 }}
          >
            {description}
          </Body>
        ) : null}
      </div>
      {actions ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "flex-end",
            maxWidth: "100%",
          }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fixed-viewport workspace frame. Fills the available vertical space,
 * hides outer overflow, and lets children (panels / lists) scroll internally.
 * Every workspace should be wrapped in this so the Tilth shell never scrolls
 * at the page level.
 */
export function WorkspaceFrame({ header, children, style, padding = "14px 18px", gap = 12 }) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding,
        gap,
        overflow: "hidden",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {header ? <div style={{ flex: "0 0 auto" }}>{header}</div> : null}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  disabled,
  as,
  href,
  onClick,
  type,
  style,
  ...rest
}) {
  const palette = {
    primary: {
      bg: brand.forest,
      border: brand.forest,
      color: brand.white,
      hover: brand.forestDeep,
    },
    secondary: {
      bg: brand.white,
      border: brand.border,
      color: brand.forest,
      hover: brand.bgSection,
    },
    ghost: {
      bg: "transparent",
      border: "transparent",
      color: brand.forest,
      hover: brand.bgSection,
    },
    accent: {
      bg: brand.orange,
      border: brand.orange,
      color: "#1c1400",
      hover: brand.amber,
    },
    danger: {
      bg: brand.white,
      border: brand.danger,
      color: brand.danger,
      hover: brand.dangerSoft,
    },
  };
  const p = palette[variant] || palette.primary;
  const sizes = {
    sm: { pad: "8px 10px", font: 11 },
    md: { pad: "12px 16px", font: 12 },
    lg: { pad: "15px 20px", font: 13 },
  };
  const s = sizes[size] || sizes.md;

  const base = {
    fontFamily: fonts.sans,
    fontSize: s.font,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    padding: s.pad,
    borderRadius: radius.base,
    border: `1px solid ${p.border}`,
    background: p.bg,
    color: p.color,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: size === "sm" ? 36 : 42,
    maxWidth: "100%",
    boxSizing: "border-box",
    whiteSpace: "nowrap",
    transition: "background 160ms ease, border-color 160ms ease, color 160ms ease",
    ...style,
  };

  if (as === "a" || href) {
    return (
      <a href={href} onClick={onClick} style={base} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button type={type || "button"} disabled={disabled} onClick={onClick} style={base} {...rest}>
      {children}
    </button>
  );
}

export function MobileSheet({
  open,
  title,
  kicker,
  description,
  children,
  footer,
  onClose,
  initialFocusRef,
  closeLabel = "Close",
}) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!open || !isMobile) return undefined;
    previousFocusRef.current = document.activeElement;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => {
      const focusTarget =
        initialFocusRef?.current ||
        panelRef.current?.querySelector?.("input, select, textarea, button, a[href]");
      focusTarget?.focus?.({ preventScroll: true });
    }, 80);

    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
      previousFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [initialFocusRef, isMobile, onClose, open]);

  if (!open || !isMobile) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3000,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        padding: "max(12px, env(safe-area-inset-top, 0px)) 10px max(10px, env(safe-area-inset-bottom, 0px))",
        background: "rgba(14, 42, 36, 0.38)",
        boxSizing: "border-box",
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || kicker || "Form"}
        style={{
          width: "100%",
          maxHeight: "min(88dvh, 760px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: `1px solid ${brand.border}`,
          borderRadius: "16px 16px 8px 8px",
          background: brand.white,
          boxShadow: "0 -18px 70px rgba(14,42,36,0.22)",
        }}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "16px 16px 12px",
            borderBottom: `1px solid ${brand.border}`,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            {kicker ? <Kicker style={{ marginBottom: 5 }}>{kicker}</Kicker> : null}
            {title ? <Headline size="sm" style={{ fontSize: 24 }}>{title}</Headline> : null}
            {description ? <Body size="sm" style={{ marginTop: 6, lineHeight: 1.5 }}>{description}</Body> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            style={{
              flex: "0 0 auto",
              width: 44,
              height: 44,
              border: `1px solid ${brand.border}`,
              borderRadius: radius.lg,
              background: brand.bgSection,
              color: brand.forest,
              cursor: "pointer",
              fontSize: 24,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </header>
        <div
          className="tilth-scroll"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: 16,
            WebkitOverflowScrolling: "touch",
          }}
        >
          {children}
        </div>
        {footer ? (
          <footer
            style={{
              flex: "0 0 auto",
              display: "grid",
              gap: 8,
              padding: "12px 16px max(16px, env(safe-area-inset-bottom, 0px))",
              borderTop: `1px solid ${brand.border}`,
              background: brand.white,
            }}
          >
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title = "Are you sure?",
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  danger = false,
}) {
  return (
    <MobileSheet
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      footer={
        <>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} style={{ width: "100%" }}>
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={onCancel} style={{ width: "100%" }}>
            {cancelLabel}
          </Button>
        </>
      }
    />
  );
}

export function Pill({ children, tone = "neutral", style }) {
  const tones = {
    neutral: { bg: brand.bgSection, color: brand.forest, border: brand.border },
    ok: { bg: brand.okSoft, color: brand.ok, border: brand.ok },
    warn: { bg: brand.warnSoft, color: brand.warn, border: brand.warn },
    danger: { bg: brand.dangerSoft, color: brand.danger, border: brand.danger },
    info: { bg: brand.infoSoft, color: brand.info, border: brand.info },
    forest: { bg: brand.forest, color: brand.white, border: brand.forest },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: "4px 8px",
        borderRadius: radius.base,
        border: `1px solid ${t.border}`,
        background: t.bg,
        color: t.color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Stat({ kicker, value, sub, tone = "neutral" }) {
  const valueColor = tone === "forest" ? brand.white : brand.forest;
  const subColor = tone === "forest" ? "rgba(255,255,255,0.72)" : brand.bodySoft;
  return (
    <Card
      tone={tone === "forest" ? "forest" : "white"}
      style={{
        background: tone === "forest" ? brand.forest : brand.white,
        borderColor: tone === "forest" ? brand.forest : brand.border,
        padding: "16px 18px",
      }}
    >
      {kicker ? (
        <Kicker
          color={tone === "forest" ? "rgba(255,255,255,0.66)" : brand.moss}
          style={{ marginBottom: 8 }}
        >
          {kicker}
        </Kicker>
      ) : null}
      <div
        style={{
          fontFamily: fonts.serif,
          fontSize: 28,
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
          color: valueColor,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            marginTop: 6,
            fontFamily: fonts.sans,
            fontSize: 12,
            color: subColor,
            lineHeight: 1.5,
          }}
        >
          {sub}
        </div>
      ) : null}
    </Card>
  );
}

export function EmptyState({ kicker, title, description, actions, icon }) {
  return (
    <div
      style={{
        border: `1px dashed ${brand.tagBorder}`,
        background: brand.bgSection,
        borderRadius: radius.base,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      {icon ? (
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            margin: "0 auto 14px",
            borderRadius: radius.base,
            border: `1px solid ${brand.border}`,
            background: brand.white,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: brand.forest,
          }}
        >
          {icon}
        </div>
      ) : null}
      {kicker ? <Kicker style={{ marginBottom: 10 }}>{kicker}</Kicker> : null}
      {title ? <Headline size="sm">{title}</Headline> : null}
      {description ? (
        <Body style={{ marginTop: 10, maxWidth: 540, marginInline: "auto" }}>{description}</Body>
      ) : null}
      {actions ? (
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Subtle section label + stacked content group, used inside panels. */
export function Subpanel({ kicker, title, actions, children, style }) {
  return (
    <div style={{ marginBottom: 18, ...style }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          {kicker ? <Kicker style={{ marginBottom: 4 }}>{kicker}</Kicker> : null}
          {title ? (
            <div
              style={{
                fontFamily: fonts.sans,
                fontSize: 14,
                fontWeight: 600,
                color: brand.forest,
                letterSpacing: "-0.005em",
              }}
            >
              {title}
            </div>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

/** Small bordered row used for field lists, record lists, alerts, etc. */
export function Row({ children, onClick, active, style, ...rest }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        textAlign: "left",
        padding: "11px 13px",
        borderRadius: radius.base,
        border: `1px solid ${active ? brand.forest : brand.border}`,
        background: active ? brand.bgSection : brand.white,
        color: brand.forest,
        fontFamily: fonts.sans,
        fontSize: 13,
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 140ms ease, background 140ms ease",
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function DefinitionList({ items, style }) {
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        columnGap: 14,
        rowGap: 6,
        ...style,
      }}
    >
      {items.map((it) => (
        <Fragment key={it.label}>
          <dt
            style={{
              fontFamily: fonts.mono,
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: brand.muted,
              paddingTop: 2,
            }}
          >
            {it.label}
          </dt>
          <dd
            style={{
              margin: 0,
              fontFamily: fonts.sans,
              fontSize: 13,
              color: brand.forest,
              lineHeight: 1.5,
              wordBreak: "break-word",
            }}
          >
            {it.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Divider({ style }) {
  return (
    <div
      style={{
        height: 1,
        background: brand.border,
        margin: "18px 0",
        ...style,
      }}
    />
  );
}

/** `label` + input wrapper sharing the setup-form style. */
export function FieldLabel({ children, htmlFor }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: "block",
        fontFamily: fonts.sans,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: brand.muted,
        marginBottom: 8,
      }}
    >
      {children}
    </label>
  );
}


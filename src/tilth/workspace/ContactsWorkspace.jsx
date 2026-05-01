import { useMemo, useRef, useState } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  EmptyState,
  FieldLabel,
  Kicker,
  MobileSheet,
  Pill,
  SectionHeader,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { useMediaQuery } from "../ui/mobileUx.js";
import { useLocalValue } from "../state/localStore.js";

const ROLES = [
  "agronomist",
  "vet",
  "grain_merchant",
  "seed_rep",
  "chemical_rep",
  "contractor",
  "fuel_supplier",
  "machinery_dealer",
  "accountant",
  "landlord",
  "tenant",
  "rpa_officer",
  "organic_body",
  "other",
];

const ROLE_LABELS = {
  agronomist: "Agronomist",
  vet: "Vet",
  grain_merchant: "Grain Merchant",
  seed_rep: "Seed Rep",
  chemical_rep: "Chemical Rep",
  contractor: "Contractor",
  fuel_supplier: "Fuel Supplier",
  machinery_dealer: "Machinery Dealer",
  accountant: "Accountant",
  landlord: "Landlord",
  tenant: "Tenant",
  rpa_officer: "RPA Officer",
  organic_body: "Organic Body",
  other: "Other",
};

const ROLE_GROUPS = {
  advisors: { label: "Advisors", roles: ["agronomist", "vet", "accountant"] },
  suppliers: {
    label: "Suppliers",
    roles: ["seed_rep", "chemical_rep", "fuel_supplier", "machinery_dealer"],
  },
  trade: { label: "Trade", roles: ["grain_merchant", "contractor"] },
  admin: { label: "Admin", roles: ["landlord", "tenant", "rpa_officer", "organic_body"] },
  other: { label: "Other", roles: ["other"] },
};

const GROUP_ORDER = ["advisors", "suppliers", "trade", "admin", "other"];

function roleToGroup(role) {
  for (const [gid, g] of Object.entries(ROLE_GROUPS)) {
    if (g.roles.includes(role)) return gid;
  }
  return "other";
}

function uid() {
  return crypto.randomUUID?.() || Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

const EMPTY_FORM = {
  name: "",
  company: "",
  role: "other",
  phone: "",
  email: "",
  address: "",
  notes: "",
};

function copyToClipboard(text) {
  try {
    navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

export function ContactsWorkspace({ farm }) {
  const farmId = farm?.id || null;
  const [contacts, setContacts] = useLocalValue("contacts", farmId, []);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const isMobileForm = useMediaQuery("(max-width: 760px)");
  const nameInputRef = useRef(null);

  const patch = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const filtered = useMemo(() => {
    let result = contacts;
    if (roleFilter !== "all") {
      const groupRoles = ROLE_GROUPS[roleFilter]?.roles;
      if (groupRoles) {
        result = result.filter((c) => groupRoles.includes(c.role));
      }
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.company || "").toLowerCase().includes(q) ||
          (ROLE_LABELS[c.role] || c.role || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [contacts, roleFilter, search]);

  const groupedContacts = useMemo(() => {
    const groups = {};
    for (const gid of GROUP_ORDER) groups[gid] = [];
    for (const c of filtered) {
      const gid = roleToGroup(c.role);
      if (!groups[gid]) groups[gid] = [];
      groups[gid].push(c);
    }
    return groups;
  }, [filtered]);

  const groupCounts = useMemo(() => {
    const counts = {};
    for (const gid of GROUP_ORDER) counts[gid] = 0;
    for (const c of contacts) {
      const gid = roleToGroup(c.role);
      counts[gid] = (counts[gid] || 0) + 1;
    }
    return counts;
  }, [contacts]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    if (editingId) {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === editingId
            ? {
                ...c,
                name: form.name.trim(),
                company: form.company.trim(),
                role: form.role,
                phone: form.phone.trim(),
                email: form.email.trim(),
                address: form.address.trim(),
                notes: form.notes.trim(),
              }
            : c
        )
      );
    } else {
      const contact = {
        id: uid(),
        name: form.name.trim(),
        company: form.company.trim(),
        role: form.role,
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
        notes: form.notes.trim(),
        createdAt: new Date().toISOString(),
      };
      setContacts((prev) => [contact, ...prev]);
    }
    resetForm();
  };

  const handleEdit = (contact) => {
    setForm({
      name: contact.name || "",
      company: contact.company || "",
      role: contact.role || "other",
      phone: contact.phone || "",
      email: contact.email || "",
      address: contact.address || "",
      notes: contact.notes || "",
    });
    setEditingId(contact.id);
    setShowForm(true);
  };

  const handleDelete = (id) => {
    if (!window.confirm("Delete this contact?")) return;
    setContacts((prev) => prev.filter((c) => c.id !== id));
    if (editingId === id) resetForm();
  };

  const handleCopyPhone = (id, phone) => {
    copyToClipboard(phone);
    setCopiedId(id + "-phone");
    setTimeout(() => setCopiedId(null), 1500);
  };

  const nonEmptyGroups = useMemo(
    () => GROUP_ORDER.filter((gid) => groupedContacts[gid]?.length > 0),
    [groupedContacts]
  );

  const contactForm = (
    <>
      <Kicker style={{ marginBottom: 10 }}>
        {editingId ? "Edit contact" : "New contact"}
      </Kicker>
      <div className="tilth-contacts-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <FieldLabel>Name</FieldLabel>
          <input
            ref={nameInputRef}
            value={form.name}
            onChange={(e) => patch("name", e.target.value)}
            placeholder="e.g. John Smith"
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
          />
        </div>
        <div>
          <FieldLabel>Company</FieldLabel>
          <input
            value={form.company}
            onChange={(e) => patch("company", e.target.value)}
            placeholder="e.g. AgriChem Ltd"
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
          />
        </div>
        <div>
          <FieldLabel>Role</FieldLabel>
          <select
            value={form.role}
            onChange={(e) => patch("role", e.target.value)}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <FieldLabel>Phone</FieldLabel>
          <input
            value={form.phone}
            onChange={(e) => patch("phone", e.target.value)}
            placeholder="e.g. 07700 900000"
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
          />
        </div>
        <div>
          <FieldLabel>Email</FieldLabel>
          <input
            type="email"
            value={form.email}
            onChange={(e) => patch("email", e.target.value)}
            placeholder="e.g. john@example.com"
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
          />
        </div>
        <div>
          <FieldLabel>Address</FieldLabel>
          <input
            value={form.address}
            onChange={(e) => patch("address", e.target.value)}
            placeholder="e.g. Farm Lane, Hereford HR1 1AA"
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
          />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <FieldLabel>Notes (optional)</FieldLabel>
          <textarea
            value={form.notes}
            onChange={(e) => patch("notes", e.target.value)}
            rows={2}
            placeholder="Any additional notes..."
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, resize: "vertical" }}
          />
        </div>
      </div>
    </>
  );

  const contactFormActions = (
    <div className="tilth-contacts-actions" style={{ display: "flex", gap: 8, marginTop: isMobileForm ? 0 : 12 }}>
      <Button
        variant="primary"
        size="sm"
        onClick={handleSave}
        disabled={!form.name.trim()}
        style={isMobileForm ? { width: "100%" } : undefined}
      >
        {editingId ? "Save changes" : "Add contact"}
      </Button>
      <Button variant="ghost" size="sm" onClick={resetForm} style={isMobileForm ? { width: "100%" } : undefined}>
        Cancel
      </Button>
    </div>
  );

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Directory"
          title="Contacts"
          description="Suppliers, agronomists, merchants and service providers. Click a phone number to copy, or an email to open your mail client."
          actions={
            <Button
              variant={showForm ? "secondary" : "primary"}
              size="sm"
              onClick={() => {
                if (showForm) resetForm();
                else setShowForm(true);
              }}
            >
              {showForm ? "Cancel" : "Add contact"}
            </Button>
          }
        />
      }
    >
      <div
        className="tilth-contacts-layout"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 280px",
          gap: 12,
          overflow: "hidden",
        }}
      >
        {/* Main column */}
        <div
          className="tilth-contacts-main tilth-scroll"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            paddingRight: 4,
          }}
        >
          {/* Add/edit form */}
          {showForm && !isMobileForm && (
            <Card className="tilth-contacts-form-card" padding={14}>
              {contactForm}
              {contactFormActions}
            </Card>
          )}

          {/* Filters */}
          <div className="tilth-contacts-filters" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, company or role…"
              style={{ ...inputStyle, padding: "8px 10px", fontSize: 12, maxWidth: 260 }}
            />
            <div className="tilth-contacts-filter-tabs" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {[{ id: "all", label: "All" }, ...GROUP_ORDER.map((gid) => ({ id: gid, label: ROLE_GROUPS[gid].label }))].map(
                (g) => {
                  const active = roleFilter === g.id;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setRoleFilter(g.id)}
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        padding: "5px 9px",
                        borderRadius: radius.base,
                        border: `1px solid ${active ? brand.forest : brand.border}`,
                        background: active ? brand.forest : brand.white,
                        color: active ? brand.white : brand.forest,
                        cursor: "pointer",
                      }}
                    >
                      {g.label}
                      {g.id !== "all" ? ` (${groupCounts[g.id] || 0})` : ""}
                    </button>
                  );
                }
              )}
            </div>
          </div>

          {/* Grouped contact list */}
          {contacts.length === 0 ? (
            <EmptyState
              kicker="No contacts"
              title="Your directory is empty"
              description="Add your agronomist, vet, seed rep, grain merchant and other key contacts. Keep phone numbers and emails handy for when you need them."
              actions={
                <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                  Add first contact
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              kicker="No matches"
              title="No contacts match"
              description="Try adjusting your search or role filter."
            />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {nonEmptyGroups.map((gid) => (
                <div key={gid}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <Kicker>{ROLE_GROUPS[gid].label}</Kicker>
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        color: brand.muted,
                      }}
                    >
                      {groupedContacts[gid].length}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {groupedContacts[gid].map((c) => (
                      <Card key={c.id} padding={12}>
                        <div
                          className="tilth-contact-card-row"
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 10,
                          }}
                        >
                          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                            <div
                              className="tilth-contact-meta-row"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                marginBottom: 4,
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: fonts.sans,
                                  fontSize: 14,
                                  fontWeight: 600,
                                  color: brand.forest,
                                }}
                              >
                                {c.name}
                              </span>
                              <Pill tone="neutral">{ROLE_LABELS[c.role] || c.role}</Pill>
                            </div>
                            {c.company && (
                              <div
                                style={{
                                  fontFamily: fonts.sans,
                                  fontSize: 12,
                                  color: brand.bodySoft,
                                  marginBottom: 4,
                                }}
                              >
                                {c.company}
                              </div>
                            )}
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 8,
                                marginTop: 6,
                              }}
                            >
                              {c.phone && (
                                <button
                                  type="button"
                                  onClick={() => handleCopyPhone(c.id, c.phone)}
                                  title="Click to copy phone number"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 5,
                                    padding: "4px 10px",
                                    border: `1px solid ${brand.border}`,
                                    borderRadius: radius.base,
                                    background: brand.bgSection,
                                    cursor: "pointer",
                                    fontFamily: fonts.mono,
                                    fontSize: 11,
                                    color: brand.forest,
                                  }}
                                >
                                  <span aria-hidden style={{ fontSize: 13 }}>
                                    &#9743;
                                  </span>
                                  {copiedId === c.id + "-phone" ? "Copied!" : c.phone}
                                </button>
                              )}
                              {c.email && (
                                <a
                                  href={`mailto:${c.email}`}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 5,
                                    padding: "4px 10px",
                                    border: `1px solid ${brand.border}`,
                                    borderRadius: radius.base,
                                    background: brand.bgSection,
                                    textDecoration: "none",
                                    fontFamily: fonts.mono,
                                    fontSize: 11,
                                    color: brand.forest,
                                  }}
                                  title="Click to email"
                                >
                                  <span aria-hidden style={{ fontSize: 12 }}>
                                    &#9993;
                                  </span>
                                  {c.email}
                                </a>
                              )}
                            </div>
                            {c.address && (
                              <div
                                style={{
                                  fontFamily: fonts.sans,
                                  fontSize: 11,
                                  color: brand.muted,
                                  marginTop: 6,
                                }}
                              >
                                {c.address}
                              </div>
                            )}
                            {c.notes && (
                              <div
                                style={{
                                  fontFamily: fonts.sans,
                                  fontSize: 11,
                                  color: brand.bodySoft,
                                  marginTop: 4,
                                  fontStyle: "italic",
                                  lineHeight: 1.5,
                                }}
                              >
                                {c.notes}
                              </div>
                            )}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 4,
                              flex: "0 0 auto",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => handleEdit(c)}
                              style={{
                                fontFamily: fonts.mono,
                                fontSize: 10,
                                letterSpacing: "0.10em",
                                textTransform: "uppercase",
                                color: brand.forest,
                                background: "transparent",
                                border: `1px solid ${brand.border}`,
                                borderRadius: radius.base,
                                padding: "4px 8px",
                                cursor: "pointer",
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(c.id)}
                              style={{
                                fontFamily: fonts.mono,
                                fontSize: 10,
                                color: brand.danger,
                                background: "transparent",
                                border: `1px solid ${brand.border}`,
                                borderRadius: radius.base,
                                padding: "4px 8px",
                                cursor: "pointer",
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div
          className="tilth-contacts-sidebar tilth-scroll"
          style={{
            minHeight: 0,
            minWidth: 0,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            paddingRight: 4,
          }}
        >
          {/* Summary */}
          <Card padding={12}>
            <Kicker style={{ marginBottom: 8 }}>Summary</Kicker>
            <div
              style={{
                fontFamily: fonts.serif,
                fontSize: 28,
                color: brand.forest,
                letterSpacing: "-0.02em",
                marginBottom: 8,
              }}
            >
              {contacts.length}
            </div>
            <Body size="sm" style={{ color: brand.muted, marginBottom: 10 }}>
              {contacts.length === 1 ? "contact" : "contacts"} in directory
            </Body>
            {GROUP_ORDER.filter((gid) => groupCounts[gid] > 0).length > 0 && (
              <div style={{ display: "grid", gap: 4 }}>
                {GROUP_ORDER.filter((gid) => groupCounts[gid] > 0).map((gid) => (
                  <div
                    key={gid}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      border: `1px solid ${brand.border}`,
                      borderRadius: radius.base,
                      background: brand.white,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: fonts.sans,
                        fontSize: 12,
                        color: brand.forest,
                      }}
                    >
                      {ROLE_GROUPS[gid].label}
                    </span>
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 11,
                        color: brand.muted,
                      }}
                    >
                      {groupCounts[gid]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Quick-add suggestions */}
          <Card padding={12} tone="section">
            <Kicker style={{ marginBottom: 6 }}>Key contacts</Kicker>
            <Body size="sm" style={{ lineHeight: 1.55, marginBottom: 8 }}>
              Every farm should have these contacts to hand:
            </Body>
            <div style={{ display: "grid", gap: 3 }}>
              {[
                { role: "agronomist", why: "Crop advice & spray plans" },
                { role: "vet", why: "Animal health & medicines" },
                { role: "grain_merchant", why: "Marketing & haulage" },
                { role: "accountant", why: "Tax, BPS & VAT" },
                { role: "contractor", why: "Combining, drilling & spraying" },
                { role: "seed_rep", why: "Variety recommendations" },
              ].map((s) => {
                const exists = contacts.some((c) => c.role === s.role);
                return (
                  <div
                    key={s.role}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 8px",
                      borderRadius: radius.base,
                      border: `1px solid ${brand.border}`,
                      background: brand.white,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background: exists ? brand.ok : brand.border,
                        flex: "0 0 auto",
                      }}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontFamily: fonts.sans,
                          fontSize: 11,
                          fontWeight: 600,
                          color: brand.forest,
                        }}
                      >
                        {ROLE_LABELS[s.role]}
                      </div>
                      <div
                        style={{
                          fontFamily: fonts.sans,
                          fontSize: 10,
                          color: brand.muted,
                        }}
                      >
                        {s.why}
                      </div>
                    </div>
                    {exists ? (
                      <Pill tone="ok" style={{ fontSize: 8 }}>
                        Added
                      </Pill>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setForm({ ...EMPTY_FORM, role: s.role });
                          setEditingId(null);
                          setShowForm(true);
                        }}
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 9,
                          letterSpacing: "0.10em",
                          textTransform: "uppercase",
                          color: brand.forest,
                          background: "transparent",
                          border: `1px solid ${brand.border}`,
                          borderRadius: radius.base,
                          padding: "3px 7px",
                          cursor: "pointer",
                        }}
                      >
                        + Add
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* About */}
          <Card padding={12} tone="section">
            <Kicker style={{ marginBottom: 6 }}>About</Kicker>
            <Body size="sm" style={{ lineHeight: 1.55 }}>
              Contact records are stored locally on this device. Click a phone number
              to copy it to the clipboard, or click an email address to open a new
              message in your default mail client.
            </Body>
          </Card>
        </div>
      </div>

      <MobileSheet
        open={showForm && isMobileForm}
        kicker="Directory"
        title={editingId ? "Edit contact" : "New contact"}
        description="Add the details you need, then save to return to the directory."
        onClose={resetForm}
        initialFocusRef={nameInputRef}
        footer={contactFormActions}
      >
        {contactForm}
      </MobileSheet>

      <style>{`
        @media (max-width: 1100px) {
          .tilth-contacts-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .tilth-contacts-layout {
            display: flex !important;
            flex-direction: column !important;
            overflow-y: auto !important;
            gap: 12px !important;
            padding-bottom: 18px !important;
          }
          .tilth-contacts-main,
          .tilth-contacts-sidebar {
            overflow: visible !important;
            min-height: auto !important;
            padding-right: 0 !important;
          }
          .tilth-contacts-sidebar {
            order: 2;
          }
          .tilth-contacts-main {
            order: 1;
          }
          .tilth-contacts-form-card {
            padding: 14px !important;
          }
          .tilth-contacts-form-grid {
            grid-template-columns: 1fr !important;
            gap: 10px !important;
          }
          .tilth-contacts-actions {
            display: grid !important;
            grid-template-columns: 1fr !important;
          }
          .tilth-contacts-actions button {
            width: 100% !important;
          }
          .tilth-contacts-filters {
            display: grid !important;
            grid-template-columns: 1fr !important;
            align-items: stretch !important;
          }
          .tilth-contacts-filters > input {
            max-width: none !important;
            width: 100% !important;
          }
          .tilth-contacts-filter-tabs {
            overflow-x: auto !important;
            flex-wrap: nowrap !important;
            padding-bottom: 4px !important;
          }
          .tilth-contacts-filter-tabs button {
            flex: 0 0 auto;
            min-height: 40px !important;
            border-radius: 8px !important;
          }
          .tilth-contact-card-row {
            display: grid !important;
            grid-template-columns: 1fr !important;
            gap: 10px !important;
          }
          .tilth-contact-meta-row {
            flex-wrap: wrap !important;
            align-items: flex-start !important;
          }
          .tilth-contact-card-row button,
          .tilth-contact-card-row a {
            min-height: 40px !important;
            border-radius: 8px !important;
          }
        }
      `}</style>
    </WorkspaceFrame>
  );
}

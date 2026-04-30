import { useCallback, useEffect, useState } from "react";
import { brand, fonts, radius, inputStyle } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  Kicker,
  Pill,
  Row,
  SectionHeader,
  Stat,
  WorkspaceFrame,
  FieldLabel,
} from "../ui/primitives.jsx";
import { supabase } from "../../lib/supabaseClient.js";

const ROLES = [
  { id: "viewer", label: "Viewer", desc: "Read-only access to all data" },
  { id: "operator", label: "Operator", desc: "Log records, observations & yield" },
  { id: "manager", label: "Manager", desc: "Full access except team management" },
  { id: "admin", label: "Admin", desc: "Full access including team management" },
];

const ROLE_COLORS = { viewer: brand.info, operator: brand.moss, manager: brand.forest, admin: brand.warn };

export function TeamWorkspace({ farm, user }) {
  const farmId = farm?.id;
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("operator");
  const [inviteNote, setInviteNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const storageKey = `tilth:team:${farmId}`;
  const inviteKey = `tilth:invites:${farmId}`;

  const loadTeam = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    setError(null);
    if (supabase) {
      const [{ data: memberRows, error: memberError }, { data: inviteRows, error: inviteError }] =
        await Promise.all([
          supabase
            .from("farm_members")
            .select("*")
            .eq("farm_id", farmId)
            .order("created_at", { ascending: true }),
          supabase
            .from("farm_invites")
            .select("*")
            .eq("farm_id", farmId)
            .order("created_at", { ascending: false }),
        ]);
      if (memberError || inviteError) {
        setError(memberError?.message || inviteError?.message || "Could not load team.");
      } else {
        setMembers((memberRows || []).map((m) => ({
          id: m.id,
          userId: m.user_id,
          email: m.user_id,
          role: m.role,
          joinedAt: m.created_at,
        })));
        setInvites((inviteRows || []).map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          note: i.note || "",
          status: i.status,
          sentAt: i.created_at,
        })));
        setLoading(false);
        return;
      }
    }
    try {
      const m = JSON.parse(localStorage.getItem(storageKey) || "[]");
      const inv = JSON.parse(localStorage.getItem(inviteKey) || "[]");
      setMembers(m);
      setInvites(inv);
    } catch {
      setMembers([]);
      setInvites([]);
    }
    setLoading(false);
  }, [farmId, storageKey, inviteKey]);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  const saveMembers = useCallback((m) => {
    try { localStorage.setItem(storageKey, JSON.stringify(m)); } catch { /* local storage unavailable */ }
    setMembers(m);
  }, [storageKey]);

  const saveInvites = useCallback((inv) => {
    try { localStorage.setItem(inviteKey, JSON.stringify(inv)); } catch { /* local storage unavailable */ }
    setInvites(inv);
  }, [inviteKey]);

  const handleInvite = useCallback(async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (invites.some((i) => i.email === email) || members.some((m) => m.email === email)) {
      setError("This email has already been invited.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      if (supabase && farmId) {
        const { error: inviteError } = await supabase.from("farm_invites").insert({
          farm_id: farmId,
          email,
          role: inviteRole,
          invited_by: user?.id,
          note: inviteNote.trim() || null,
        });
        if (inviteError) throw new Error(inviteError.message);
        await loadTeam();
      } else {
        const newInvite = {
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          email,
          role: inviteRole,
          note: inviteNote.trim(),
          status: "pending",
          sentAt: new Date().toISOString(),
        };
        saveInvites([...invites, newInvite]);
      }
      setInviteEmail("");
      setInviteNote("");
      setShowInvite(false);
    } catch (err) {
      setError(err?.message || "Could not send invite.");
    } finally {
      setSending(false);
    }
  }, [inviteEmail, inviteRole, inviteNote, invites, members, saveInvites, farmId, user?.id, loadTeam]);

  const revokeInvite = useCallback(async (id) => {
    if (supabase) {
      const { error: revokeError } = await supabase
        .from("farm_invites")
        .update({ status: "revoked" })
        .eq("id", id);
      if (revokeError) setError(revokeError.message);
      await loadTeam();
      return;
    }
    saveInvites(invites.filter((i) => i.id !== id));
  }, [invites, saveInvites, loadTeam]);

  const removeMember = useCallback(async (id) => {
    if (supabase) {
      const { error: removeError } = await supabase.from("farm_members").delete().eq("id", id);
      if (removeError) setError(removeError.message);
      await loadTeam();
      return;
    }
    saveMembers(members.filter((m) => m.id !== id));
  }, [members, saveMembers, loadTeam]);

  const changeRole = useCallback(async (id, newRole) => {
    if (supabase) {
      const { error: roleError } = await supabase
        .from("farm_members")
        .update({ role: newRole })
        .eq("id", id);
      if (roleError) setError(roleError.message);
      await loadTeam();
      return;
    }
    saveMembers(members.map((m) => m.id === id ? { ...m, role: newRole } : m));
  }, [members, saveMembers, loadTeam]);

  const isOwner = farm?.owner_user_id === user?.id;

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Access"
          title="Team"
          description="Invite agronomists, contractors, and staff to collaborate on your farm data."
          actions={isOwner ? (
            <Button variant="primary" size="sm" onClick={() => setShowInvite(true)}>Invite member</Button>
          ) : null}
        />
      }
    >
      <div className="tilth-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 4px 4px" }}>
        {loading && <Body size="sm" style={{ color: brand.muted, marginBottom: 10 }}>Loading team…</Body>}
        {/* Stats */}
        <div className="tilth-team-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat kicker="Owner" value={user?.email?.split("@")[0] || "You"} sub="Full control" tone="forest" />
          <Stat kicker="Members" value={members.length} sub="active" />
          <Stat kicker="Pending" value={invites.filter((i) => i.status === "pending").length} sub="invitations" />
          <Stat kicker="Roles" value={ROLES.length} sub="available" />
        </div>

        {/* Invite form */}
        {showInvite && (
          <Card className="tilth-team-invite-card" padding={16} style={{ marginBottom: 14, border: `2px solid ${brand.forest}` }}>
            <Kicker style={{ marginBottom: 10 }}>Invite team member</Kicker>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <FieldLabel>Email address</FieldLabel>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  style={{ ...inputStyle, fontSize: 13 }}
                />
              </div>
              <div>
                <FieldLabel>Role</FieldLabel>
                <div className="tilth-team-role-picker" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                  {ROLES.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setInviteRole(r.id)}
                      style={{
                        padding: "8px 10px",
                        border: `1px solid ${inviteRole === r.id ? ROLE_COLORS[r.id] : brand.border}`,
                        borderRadius: radius.base,
                        background: inviteRole === r.id ? brand.bgSection : brand.white,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: ROLE_COLORS[r.id] }}>{r.label}</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, marginTop: 2 }}>{r.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <FieldLabel>Note (optional)</FieldLabel>
                <input
                  value={inviteNote}
                  onChange={(e) => setInviteNote(e.target.value)}
                  placeholder="Add a note for the invite…"
                  style={{ ...inputStyle, fontSize: 13 }}
                />
              </div>
              {error && <Body size="sm" style={{ color: brand.danger }}>{error}</Body>}
              <div className="tilth-team-actions" style={{ display: "flex", gap: 8 }}>
                <Button variant="primary" size="sm" onClick={handleInvite} disabled={sending}>Send invite</Button>
                <Button variant="secondary" size="sm" onClick={() => { setShowInvite(false); setError(null); }}>Cancel</Button>
              </div>
            </div>
          </Card>
        )}

        <div className="tilth-team-panels" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
          {/* Team members */}
          <Card padding={14}>
            <Kicker style={{ marginBottom: 10 }}>Team members</Kicker>
            {/* Owner */}
            <div style={{ padding: "8px 10px", borderRadius: radius.base, border: `1px solid ${brand.forest}`, background: brand.bgSection, marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>{user?.email || "Owner"}</span>
                </div>
                <Pill tone="neutral" style={{ fontSize: 9 }}>Owner</Pill>
              </div>
            </div>
            {members.length === 0 ? (
              <Body size="sm" style={{ color: brand.muted, padding: "8px 0" }}>
                No team members yet. Invite someone to get started.
              </Body>
            ) : members.map((m) => (
              <Row key={m.id} style={{ padding: "6px 8px", marginBottom: 4 }}>
                <div className="tilth-team-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 500, color: brand.forest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</div>
                    <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>Joined {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}</div>
                  </div>
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.id, e.target.value)}
                    style={{ fontFamily: fonts.mono, fontSize: 10, padding: "3px 6px", border: `1px solid ${brand.border}`, borderRadius: radius.base, background: brand.white }}
                  >
                    {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                  {isOwner && (
                    <button className="tilth-team-link-button" type="button" onClick={() => removeMember(m.id)} style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.danger, background: "transparent", border: "none", cursor: "pointer" }}>Remove</button>
                  )}
                </div>
              </Row>
            ))}
          </Card>

          {/* Pending invites */}
          <Card padding={14}>
            <Kicker style={{ marginBottom: 10 }}>Pending invitations</Kicker>
            {invites.length === 0 ? (
              <Body size="sm" style={{ color: brand.muted, padding: "8px 0" }}>No pending invitations.</Body>
            ) : invites.map((inv) => (
              <Row key={inv.id} style={{ padding: "6px 8px", marginBottom: 4 }}>
                <div className="tilth-team-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 500, color: brand.forest }}>{inv.email}</div>
                    <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted }}>
                      {ROLES.find((r) => r.id === inv.role)?.label || inv.role} · sent {new Date(inv.sentAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Pill tone="neutral" style={{ fontSize: 8 }}>{inv.status}</Pill>
                  {isOwner && (
                    <button className="tilth-team-link-button" type="button" onClick={() => revokeInvite(inv.id)} style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.danger, background: "transparent", border: "none", cursor: "pointer" }}>Revoke</button>
                  )}
                </div>
              </Row>
            ))}
          </Card>
        </div>

        {/* Role descriptions */}
        <Card padding={14} style={{ marginTop: 14 }}>
          <Kicker style={{ marginBottom: 10 }}>Role permissions</Kicker>
          <div className="tilth-team-role-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {ROLES.map((r) => (
              <div key={r.id} style={{ padding: "10px 12px", borderRadius: radius.base, border: `1px solid ${brand.border}`, background: brand.bgSection }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: ROLE_COLORS[r.id], marginBottom: 4 }}>{r.label}</div>
                <div style={{ fontFamily: fonts.sans, fontSize: 11, color: brand.bodySoft, lineHeight: 1.4 }}>{r.desc}</div>
                <div style={{ fontFamily: fonts.mono, fontSize: 9, color: brand.muted, marginTop: 6 }}>
                  {r.id === "viewer" && "View fields, data, reports"}
                  {r.id === "operator" && "View + log records, observations, yield"}
                  {r.id === "manager" && "View + edit fields, records, schemes, reports"}
                  {r.id === "admin" && "Everything + manage team & farm settings"}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <style>{`
          @media (max-width: 760px) {
            .tilth-team-stats {
              grid-template-columns: 1fr 1fr !important;
              gap: 8px !important;
            }
            .tilth-team-invite-card {
              padding: 14px !important;
            }
            .tilth-team-role-picker,
            .tilth-team-role-grid,
            .tilth-team-panels {
              grid-template-columns: 1fr !important;
            }
            .tilth-team-role-picker button {
              min-height: 64px !important;
              border-radius: 8px !important;
            }
            .tilth-team-actions {
              display: grid !important;
              grid-template-columns: 1fr !important;
            }
            .tilth-team-actions button {
              width: 100% !important;
            }
            .tilth-team-row {
              display: grid !important;
              grid-template-columns: 1fr !important;
              align-items: stretch !important;
              gap: 8px !important;
            }
            .tilth-team-row select,
            .tilth-team-link-button {
              width: 100% !important;
            }
            .tilth-team-link-button {
              min-height: 40px !important;
              border: 1px solid ${brand.border} !important;
              border-radius: 8px !important;
              background: ${brand.white} !important;
            }
          }
          @media (max-width: 430px) {
            .tilth-team-stats {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </div>
    </WorkspaceFrame>
  );
}

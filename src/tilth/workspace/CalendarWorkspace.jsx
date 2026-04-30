import { useCallback, useEffect, useMemo, useState } from "react";
import { brand, fonts, inputStyle, radius } from "../ui/theme.js";
import {
  Body,
  Button,
  Card,
  EmptyState,
  FieldLabel,
  Kicker,
  Pill,
  Row,
  SectionHeader,
  WorkspaceFrame,
} from "../ui/primitives.jsx";
import { useLocalValue } from "../state/localStore.js";
import { supabase } from "../../lib/supabaseClient.js";
import { getTilthApiBase } from "../../lib/tilthApi.js";
import { syncTasksToGoogle } from "../../lib/googleCalendarSync.js";

const uid = () =>
  crypto.randomUUID?.() ||
  Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const CATEGORIES = [
  "general",
  "spray",
  "fertiliser",
  "harvest",
  "livestock",
  "inventory",
  "documents",
  "market",
  "records",
  "maintenance",
  "compliance",
  "meeting",
  "other",
];
const PRIORITIES = ["urgent", "high", "medium", "low"];
const STATUSES = ["pending", "in_progress", "done", "cancelled"];
const RECURRENCE = [
  "none",
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "yearly",
];
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

function priorityColor(p) {
  switch (p) {
    case "urgent": return brand.danger;
    case "high": return brand.orange;
    case "medium": return brand.muted;
    case "low": return brand.ok;
    default: return brand.muted;
  }
}

function categoryTone(c) {
  switch (c) {
    case "spray": return "warn";
    case "fertiliser": return "ok";
    case "harvest": return "forest";
    case "livestock": return "info";
    case "compliance": return "danger";
    default: return "neutral";
  }
}

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();

  let startDow = first.getDay();
  startDow = startDow === 0 ? 6 : startDow - 1;

  const cells = [];

  const prevMonthLast = new Date(year, month, 0).getDate();
  for (let i = startDow - 1; i >= 0; i--) {
    const d = prevMonthLast - i;
    const dt = new Date(year, month - 1, d);
    cells.push({ date: dt, day: d, inMonth: false });
  }

  for (let d = 1; d <= lastDay; d++) {
    cells.push({ date: new Date(year, month, d), day: d, inMonth: true });
  }

  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let d = 1; d <= remaining; d++) {
      cells.push({ date: new Date(year, month + 1, d), day: d, inMonth: false });
    }
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(dateStr, days) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function calendarErrorMessage(err, fallback = "Google Calendar request failed.") {
  const raw = err?.message || String(err || "");
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Could not reach the Tilth API. Check that npm run tilth-api is running, then try again.";
  }
  return raw || fallback;
}

async function readJsonResponse(res, fallback) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || fallback);
  return body;
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            padding: "6px 12px",
            borderRadius: radius.base,
            border: `1px solid ${active === t ? brand.forest : brand.border}`,
            background: active === t ? brand.bgSection : brand.white,
            color: brand.forest,
            cursor: "pointer",
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function CalendarSyncCard({ farmId, tasks }) {
  const [status, setStatus] = useState({ connected: false, connection: null });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const apiBase = getTilthApiBase();

  const authHeaders = useCallback(async () => {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("You need to be signed in.");
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }, []);

  const loadStatus = useCallback(async () => {
    if (!apiBase || !farmId) return;
    try {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase}/api/calendar/google/status?farmId=${encodeURIComponent(farmId)}`, { headers });
      const body = await readJsonResponse(res, "Could not read Google Calendar status.");
      setStatus(body);
    } catch (err) {
      setStatus({ connected: false, connection: null });
      setMessage(calendarErrorMessage(err, "Could not read Google Calendar status."));
    }
  }, [apiBase, authHeaders, farmId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const connect = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (!apiBase) throw new Error("Tilth API is not configured.");
      const headers = await authHeaders();
      const res = await fetch(`${apiBase}/api/calendar/google/connect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ farmId }),
      });
      const body = await readJsonResponse(res, "Could not connect Google Calendar.");
      window.location.href = body.authUrl;
    } catch (err) {
      setMessage(calendarErrorMessage(err, "Could not connect Google Calendar."));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (!apiBase) throw new Error("Tilth API is not configured.");
      const headers = await authHeaders();
      const res = await fetch(`${apiBase}/api/calendar/google/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ farmId }),
      });
      const body = await readJsonResponse(res, "Could not sync Google Calendar.");
      setMessage(`Synced: ${body.created} new, ${body.updated} updated, ${body.deleted} removed.`);
      await loadStatus();
    } catch (err) {
      setMessage(calendarErrorMessage(err, "Could not sync Google Calendar."));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Google Calendar sync for this farm?")) return;
    setBusy(true);
    setMessage("");
    try {
      if (!apiBase) throw new Error("Tilth API is not configured.");
      const headers = await authHeaders();
      const res = await fetch(`${apiBase}/api/calendar/google/disconnect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ farmId }),
      });
      await readJsonResponse(res, "Could not disconnect Google Calendar.");
      setStatus({ connected: false, connection: null });
      setMessage("Google Calendar disconnected.");
    } catch (err) {
      setMessage(calendarErrorMessage(err, "Could not disconnect Google Calendar."));
    } finally {
      setBusy(false);
    }
  };

  const dueTasks = tasks.filter((t) => t.dueDate && t.status !== "done" && t.status !== "cancelled").length;

  return (
    <Card padding={12} tone="section" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <Kicker style={{ marginBottom: 4 }}>Google Calendar</Kicker>
          <Body size="sm" style={{ lineHeight: 1.45 }}>
            {status.connected
              ? `Connected${status.connection?.google_email ? ` as ${status.connection.google_email}` : ""}. ${dueTasks} dated task${dueTasks === 1 ? "" : "s"} ready to mirror.`
              : "One-way sync sends Tilth jobs to a dedicated Google calendar."}
          </Body>
          {status.connection?.last_synced_at ? (
            <div style={{ marginTop: 4, fontFamily: fonts.mono, fontSize: 9.5, color: brand.muted }}>
              Last sync {new Date(status.connection.last_synced_at).toLocaleString()}
            </div>
          ) : null}
          {message ? (
            <div style={{ marginTop: 6, fontFamily: fonts.sans, fontSize: 12, color: message.includes("Could not") ? brand.danger : brand.forest }}>
              {message}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {!apiBase ? (
            <Pill tone="warn">API not configured</Pill>
          ) : status.connected ? (
            <>
              <Button size="sm" onClick={sync} disabled={busy || !dueTasks}>Sync now</Button>
              <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
            </>
          ) : (
            <Button size="sm" onClick={connect} disabled={busy}>Connect Google</Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function FormField({ label, children }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

// ─── Month Calendar View ──────────────────────────────────────────────

function MonthView({ tasks, year, month, onMonthChange, onSelectDate, selectedDate }) {
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);

  const tasksByDate = useMemo(() => {
    const map = {};
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const key = t.dueDate;
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    return map;
  }, [tasks]);

  const today = dateKey(new Date());
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const selectedTasks = selectedDate ? (tasksByDate[selectedDate] || []) : [];

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMonthChange(-1)}
        >
          ← Prev
        </Button>
        <span
          style={{
            fontFamily: fonts.serif,
            fontSize: 20,
            color: brand.forest,
            letterSpacing: "-0.02em",
          }}
        >
          {monthNames[month]} {year}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMonthChange(1)}
        >
          Next →
        </Button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 1,
          background: brand.border,
          border: `1px solid ${brand.border}`,
          borderRadius: radius.base,
          overflow: "hidden",
          marginBottom: 14,
        }}
      >
        {DAY_LABELS.map((d) => (
          <div
            key={d}
            style={{
              padding: "6px 4px",
              textAlign: "center",
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: brand.muted,
              background: brand.bgSection,
            }}
          >
            {d}
          </div>
        ))}
        {weeks.flat().map((cell, idx) => {
          const key = dateKey(cell.date);
          const isToday = key === today;
          const isSelected = key === selectedDate;
          const dayTasks = tasksByDate[key] || [];
          const hasTasks = dayTasks.length > 0;

          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectDate(key)}
              style={{
                padding: "6px 4px 8px",
                minHeight: 52,
                textAlign: "center",
                background: isSelected
                  ? brand.bgSection
                  : isToday
                  ? brand.forest
                  : brand.white,
                color: isToday
                  ? brand.white
                  : cell.inMonth
                  ? brand.forest
                  : brand.muted,
                border: isSelected ? `2px solid ${brand.forest}` : "none",
                cursor: "pointer",
                fontFamily: fonts.sans,
                fontSize: 13,
                fontWeight: isToday ? 700 : 400,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                opacity: cell.inMonth ? 1 : 0.4,
              }}
            >
              <span>{cell.day}</span>
              {hasTasks ? (
                <div style={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center" }}>
                  {dayTasks.length <= 4 ? (
                    dayTasks.map((t) => (
                      <span
                        key={t.id}
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: priorityColor(t.priority),
                        }}
                      />
                    ))
                  ) : (
                    <>
                      {dayTasks.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: priorityColor(t.priority),
                          }}
                        />
                      ))}
                      <span
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 8,
                          color: isToday ? "rgba(255,255,255,0.8)" : brand.muted,
                        }}
                      >
                        +{dayTasks.length - 3}
                      </span>
                    </>
                  )}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {selectedDate ? (
        <Card padding={12}>
          <Kicker style={{ marginBottom: 8 }}>
            {fmtDate(selectedDate)} · {selectedTasks.length} task
            {selectedTasks.length === 1 ? "" : "s"}
          </Kicker>
          {selectedTasks.length === 0 ? (
            <Body size="sm" color={brand.muted}>
              No tasks on this day.
            </Body>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              {selectedTasks.map((t) => (
                <TaskRow key={t.id} task={t} fields={[]} compact />
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}

// ─── Task Row ─────────────────────────────────────────────────────────

function TaskRow({ task, fields, compact, onToggle, onDelete }) {
  const field = task.fieldId
    ? fields.find((f) => f.id === task.fieldId)
    : null;
  const reminderDays = Number(task.reminderDays) || 0;
  const warningDate = task.dueDate && reminderDays > 0 ? addDaysIso(task.dueDate, -reminderDays) : "";

  return (
    <Row style={{ padding: "8px 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          {onToggle ? (
            <button
              type="button"
              onClick={() => onToggle(task.id)}
              style={{
                width: 18,
                height: 18,
                borderRadius: 3,
                border: `1.5px solid ${
                  task.status === "done" ? brand.ok : brand.border
                }`,
                background:
                  task.status === "done" ? brand.okSoft : brand.white,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: fonts.mono,
                fontSize: 11,
                color: brand.ok,
                padding: 0,
                flex: "0 0 auto",
              }}
            >
              {task.status === "done" ? "✓" : ""}
            </button>
          ) : null}
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: priorityColor(task.priority),
              flex: "0 0 auto",
            }}
          />
          <span
            style={{
              fontFamily: fonts.sans,
              fontSize: 12,
              fontWeight: 600,
              color: brand.forest,
              textDecoration: task.status === "done" ? "line-through" : "none",
              opacity: task.status === "done" ? 0.6 : 1,
            }}
          >
            {task.title}
          </span>
          <Pill tone={categoryTone(task.category)} style={{ fontSize: 9 }}>
            {task.category}
          </Pill>
          {field ? (
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: brand.muted,
              }}
            >
              {field.name || "Unnamed field"}
            </span>
          ) : null}
          {task.assignee && !compact ? (
            <span
              style={{
                fontFamily: fonts.sans,
                fontSize: 11,
                color: brand.bodySoft,
              }}
            >
              → {task.assignee}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {task.dueDate ? (
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: brand.muted,
              }}
            >
              {fmtDate(task.dueDate)}
            </span>
          ) : null}
          {warningDate && !compact ? (
            <Pill tone="warn" style={{ fontSize: 9, textTransform: "none" }}>
              warn {fmtDate(warningDate)}
            </Pill>
          ) : null}
          {task.status !== "pending" && task.status !== "done" ? (
            <Pill
              tone={task.status === "cancelled" ? "danger" : "info"}
              style={{ fontSize: 9 }}
            >
              {task.status.replace("_", " ")}
            </Pill>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(task.id)}
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                letterSpacing: "0.10em",
                textTransform: "uppercase",
                color: brand.danger,
                background: "transparent",
                border: `1px solid ${brand.border}`,
                borderRadius: radius.base,
                padding: "4px 8px",
                cursor: "pointer",
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
    </Row>
  );
}

// ─── Task List View ───────────────────────────────────────────────────

function ListView({ tasks, setTasks, fields, selectedDate, onClearSelectedDate, onDelete }) {
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterPriority, setFilterPriority] = useState("");

  const filtered = useMemo(() => {
    let list = [...tasks];
    if (selectedDate) list = list.filter((t) => t.dueDate === selectedDate);
    if (filterStatus) list = list.filter((t) => t.status === filterStatus);
    if (filterCategory) list = list.filter((t) => t.category === filterCategory);
    if (filterPriority) list = list.filter((t) => t.priority === filterPriority);
    list.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
    return list;
  }, [tasks, selectedDate, filterStatus, filterCategory, filterPriority]);

  const toggle = (id) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: t.status === "done" ? "pending" : "done" }
          : t
      )
    );
  };

  return (
    <>
      {selectedDate ? (
        <Card padding={10} tone="section" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <Body size="sm" style={{ color: brand.forest }}>
              Showing tasks for <strong>{fmtDate(selectedDate)}</strong>
            </Body>
            <Button variant="ghost" size="sm" onClick={onClearSelectedDate}>
              Show all dates
            </Button>
          </div>
        </Card>
      ) : null}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 10,
          alignItems: "center",
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.muted,
            }}
          >
            Status
          </span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ ...inputStyle, width: "auto", padding: "4px 8px", fontSize: 11 }}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.muted,
            }}
          >
            Category
          </span>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            style={{ ...inputStyle, width: "auto", padding: "4px 8px", fontSize: 11 }}
          >
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: brand.muted,
            }}
          >
            Priority
          </span>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            style={{ ...inputStyle, width: "auto", padding: "4px 8px", fontSize: 11 }}
          >
            <option value="">All</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          kicker="No tasks"
          title="Nothing here"
          description="No tasks match your current filters."
        />
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {filtered.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              fields={fields}
              onToggle={toggle}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Add Task Form ────────────────────────────────────────────────────

function AddTaskForm({ onSave, onCancel, fields }) {
  const blank = () => ({
    id: uid(),
    title: "",
    description: "",
    category: "general",
    priority: "medium",
    dueDate: "",
    dueTime: "",
    reminderDays: 7,
    fieldId: "",
    recurrence: "none",
    assignee: "",
    notes: "",
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  const [form, setForm] = useState(blank);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    if (!form.title.trim()) return;
    onSave(form);
    setForm(blank());
  };

  return (
    <Card className="tilth-mobile-card" padding={14}>
      <Kicker style={{ marginBottom: 10 }}>New task</Kicker>
      <div style={{ display: "grid", gap: 8 }}>
        <FormField label="Title">
          <input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            style={inputStyle}
            placeholder="What needs doing?"
          />
        </FormField>
        <FormField label="Description">
          <textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={2}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </FormField>
        <div className="tilth-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <FormField label="Category">
            <select
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
              style={inputStyle}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Priority">
            <select
              value={form.priority}
              onChange={(e) => set("priority", e.target.value)}
              style={inputStyle}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Due date">
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
              style={inputStyle}
            />
          </FormField>
          <FormField label="Due time (optional)">
            <input
              type="time"
              value={form.dueTime}
              onChange={(e) => set("dueTime", e.target.value)}
              style={inputStyle}
            />
          </FormField>
          <FormField label="Warn before">
            <select
              value={form.reminderDays}
              onChange={(e) => set("reminderDays", Number(e.target.value))}
              style={inputStyle}
            >
              <option value={0}>No warning</option>
              <option value={1}>1 day before</option>
              <option value={3}>3 days before</option>
              <option value={7}>7 days before</option>
              <option value={14}>14 days before</option>
              <option value={30}>30 days before</option>
            </select>
          </FormField>
          <FormField label="Field (optional)">
            <select
              value={form.fieldId}
              onChange={(e) => set("fieldId", e.target.value)}
              style={inputStyle}
            >
              <option value="">None</option>
              {(fields || []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name || "Unnamed field"}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Recurrence">
            <select
              value={form.recurrence}
              onChange={(e) => set("recurrence", e.target.value)}
              style={inputStyle}
            >
              {RECURRENCE.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Assigned to (optional)">
          <input
            value={form.assignee}
            onChange={(e) => set("assignee", e.target.value)}
            style={inputStyle}
            placeholder="e.g. John"
          />
        </FormField>
        <FormField label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </FormField>
      </div>
      <div className="tilth-mobile-actions" style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <Button size="sm" onClick={handleSave} disabled={!form.title.trim()}>
          Save task
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ─── Main Workspace ───────────────────────────────────────────────────

export function CalendarWorkspace({ farm, fields }) {
  const farmId = farm?.id;
  const [tasks, setTasks] = useLocalValue("tasks", farmId, []);
  const [view, setView] = useState("month");
  const [showAddForm, setShowAddForm] = useState(false);

  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [selectedDate, setSelectedDate] = useState(null);
  const [autoSyncMessage, setAutoSyncMessage] = useState("");

  const handleMonthChange = (delta) => {
    let m = calMonth + delta;
    let y = calYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setCalMonth(m);
    setCalYear(y);
    setSelectedDate(null);
  };

  const handleAddTask = (task) => {
    const next = [...tasks, task];
    setTasks(next);
    setShowAddForm(false);
    if (task.dueDate) {
      setAutoSyncMessage("Syncing new task to Google Calendar…");
      syncTasksToGoogle(farmId, next)
        .then((result) => {
          if (result?.skipped) {
            setAutoSyncMessage("");
            return;
          }
          setAutoSyncMessage("New task synced to Google Calendar.");
        })
        .catch((err) => {
          setAutoSyncMessage(err?.message || "Could not sync new task to Google Calendar.");
        });
    }
  };

  const handleSelectDate = (date) => {
    setSelectedDate(date);
    setView("list");
  };

  const handleDeleteTask = (id) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (!window.confirm(`Delete "${task.title}" from the calendar?`)) return;
    const next = tasks.filter((t) => t.id !== id);
    setTasks(next);
    if (task.dueDate) {
      setAutoSyncMessage("Syncing deleted task to Google Calendar…");
      syncTasksToGoogle(farmId, next)
        .then((result) => {
          if (result?.skipped) {
            setAutoSyncMessage("");
            return;
          }
          setAutoSyncMessage("Deleted task synced to Google Calendar.");
        })
        .catch((err) => {
          setAutoSyncMessage(err?.message || "Could not sync deleted task to Google Calendar.");
        });
    }
  };

  const pendingCount = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  ).length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const activeWarnings = useMemo(() => {
    const today = dateKey(new Date());
    return tasks
      .filter((t) => t.dueDate && t.status !== "done" && t.status !== "cancelled" && Number(t.reminderDays) > 0)
      .map((t) => ({ ...t, warningDate: addDaysIso(t.dueDate, -Number(t.reminderDays)) }))
      .filter((t) => t.warningDate <= today && t.dueDate >= today)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [tasks]);

  return (
    <WorkspaceFrame
      header={
        <SectionHeader
          kicker="Planning"
          title="Calendar"
          description="Farm tasks, deadlines and scheduling."
          actions={
            <Button
              size="sm"
              onClick={() => {
                setShowAddForm((v) => !v);
                if (!showAddForm) setView("add");
              }}
            >
              {showAddForm ? "Cancel" : "+ New task"}
            </Button>
          }
        />
      }
    >
      <div
        className="tilth-scroll"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <CalendarSyncCard farmId={farmId} tasks={tasks} />
        {autoSyncMessage ? (
          <div
            style={{
              marginBottom: 10,
              fontFamily: fonts.sans,
              fontSize: 13,
              color: autoSyncMessage.includes("Could not") ? brand.danger : brand.forest,
            }}
          >
            {autoSyncMessage}
          </div>
        ) : null}

        {activeWarnings.length > 0 ? (
          <Card padding={12} tone="section" style={{ marginBottom: 12 }}>
            <Kicker style={{ marginBottom: 6 }}>Advance warnings</Kicker>
            <div style={{ display: "grid", gap: 4 }}>
              {activeWarnings.slice(0, 5).map((task) => (
                <div key={task.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 8px", border: `1px solid ${brand.warn}`, borderRadius: radius.base, background: brand.warnSoft }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: brand.forest }}>{task.title}</span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 10, color: brand.warn }}>expires {fmtDate(task.dueDate)}</span>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 12,
            alignItems: "center",
          }}
        >
          <Pill tone="forest">{pendingCount} pending</Pill>
          <Pill tone="ok">{doneCount} done</Pill>
          <Pill tone="neutral">{tasks.length} total</Pill>
        </div>

        {showAddForm ? (
          <AddTaskForm
            onSave={handleAddTask}
            onCancel={() => setShowAddForm(false)}
            fields={fields}
          />
        ) : (
          <>
            <TabBar
              tabs={["month", "list"]}
              active={view}
              onChange={setView}
            />

            {view === "month" ? (
              <MonthView
                tasks={tasks}
                year={calYear}
                month={calMonth}
                onMonthChange={handleMonthChange}
                onSelectDate={handleSelectDate}
                selectedDate={selectedDate}
              />
            ) : (
              <ListView
                tasks={tasks}
                setTasks={setTasks}
                fields={fields || []}
                selectedDate={selectedDate}
                onClearSelectedDate={() => setSelectedDate(null)}
                onDelete={handleDeleteTask}
              />
            )}
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}

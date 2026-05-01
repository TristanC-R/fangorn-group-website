import { getTilthApiBase } from "./tilthApi.js";
import { supabase } from "./supabaseClient.js";

export async function syncTasksToGoogle(farmId, tasks) {
  const apiBase = getTilthApiBase();
  if (!apiBase || !farmId || !supabase) return { skipped: true };
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) return { skipped: true };
  try {
    const res = await fetch(`${apiBase}/api/calendar/google/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ farmId, tasks }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not sync Google Calendar.");
    return body;
  } catch (err) {
    if (/failed to fetch|networkerror|load failed/i.test(err?.message || "")) {
      throw new Error("Calendar sync is not reachable right now. Check your connection and try again.");
    }
    throw err;
  }
}

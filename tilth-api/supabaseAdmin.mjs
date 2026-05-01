/**
 * Server-side Supabase clients for the Tilth API extractor.
 *
 * Two client factories:
 *   - `adminClient()` — uses the SERVICE ROLE key, bypasses RLS. Used to
 *     write extracted data into `tilth_field_layer_data` on behalf of users.
 *     Keep this scoped to background work only.
 *   - `userClient(jwt)` — uses the ANON key + the caller's auth JWT. RLS
 *     applies, so any read it does respects ownership rules. Used to verify
 *     a field actually belongs to the calling user before we run extraction.
 *
 * If the env vars aren't set, both factories return null and `isConfigured`
 * goes false; the extraction routes then short-circuit with a clear error.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = (
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  ""
).trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

export const isConfigured = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
);

let _admin = null;
export function adminClient() {
  if (!isConfigured) return null;
  if (!_admin) {
    _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

export function userClient(jwt) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!jwt) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/**
 * Resolve the calling user's id from a Supabase JWT. Returns null on any
 * failure — callers should treat that as "not authenticated".
 */
export async function userIdFromJwt(jwt) {
  if (!jwt) return null;
  const admin = adminClient();
  if (!admin) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error) return null;
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

/**
 * Confirm that `userId` can edit `fieldId` (via the field's farm). Returns the
 * full field row (id, name, boundary, farm_id) when access is OK, or null when
 * not. Field refresh/extraction routes trigger background work, so membership
 * is limited to roles that can edit the farm.
 */
export async function fetchOwnedField(userId, fieldId) {
  if (!userId || !fieldId) return null;
  const admin = adminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("tilth_fields")
    .select("id, name, boundary, farm_id, farms!inner(owner_user_id)")
    .eq("id", fieldId)
    .maybeSingle();
  if (error || !data) return null;
  if (data.farms?.owner_user_id === userId) return data;

  const { data: member, error: memberError } = await admin
    .from("farm_members")
    .select("id")
    .eq("farm_id", data.farm_id)
    .eq("user_id", userId)
    .in("role", ["operator", "manager", "admin"])
    .maybeSingle();
  if (memberError || !member) return null;
  return data;
}

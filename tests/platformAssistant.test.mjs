import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const api = await readFile(new URL("../tilth-api/platformAssistant.mjs", import.meta.url), "utf8");
const server = await readFile(new URL("../tilth-api/server.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../src/tilth/ui/GlobalAssistant.jsx", import.meta.url), "utf8");

test("platform assistant tables are farm-scoped with RLS", () => {
  for (const table of [
    "assistant_chat_sessions",
    "assistant_chat_messages",
    "assistant_suggested_actions",
    "assistant_generated_reports",
  ]) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}`, "i"));
    assert.match(schema, new RegExp(`farm_id uuid not null references public\\.farms`, "i"));
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(schema, /public\.can_read_farm\(farm_id\)/i);
  assert.match(schema, /public\.can_edit_farm\(farm_id\)/i);
});

test("platform assistant route is registered and auth-gated", () => {
  assert.match(server, /handlePlatformAssistantRoute/);
  assert.match(api, /POST" && pathname === "\/api\/platform-assistant\/chat"/);
  assert.match(api, /POST" && pathname === "\/api\/platform-assistant\/reports\/generate"/);
  assert.match(api, /GET" && pathname === "\/api\/platform-assistant\/context\/status"/);
  assert.match(api, /userCanReadFarm\(auth\.userId, farmId\)/);
  assert.match(api, /userCanEditFarm\(auth\.userId, farmId\)/);
});

test("platform assistant collects all major feature sources", () => {
  for (const token of [
    "farm_app_data",
    "tilth_fields",
    "tilth_field_ndvi",
    "tilth_field_sar",
    "tilth_field_elevation",
    "tilth_field_layer_data",
    "document_vault_match_chunks",
  ]) {
    assert.match(api, new RegExp(token));
  }
});

test("global assistant uses platform route, report mode, and confirmed actions", () => {
  assert.match(ui, /\/api\/platform-assistant\/chat/);
  assert.match(ui, /\/api\/platform-assistant\/reports\/generate/);
  assert.match(ui, /Generate report/);
  assert.match(ui, /assistant_suggested_actions/);
  assert.match(ui, /applyAction/);
  assert.match(ui, /updateActionStatus/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const api = await readFile(new URL("../tilth-api/platformAssistant.mjs", import.meta.url), "utf8");
const server = await readFile(new URL("../tilth-api/server.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../src/tilth/ui/GlobalAssistant.jsx", import.meta.url), "utf8");
const { __platformAssistantTestHooks: hooks } = await import("../tilth-api/platformAssistant.mjs");

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
  assert.match(api, /POST" && pathname === "\/api\/platform-assistant\/actions\/status"/);
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
  assert.match(ui, /Automatic context/);
  assert.match(ui, /assistant_chat_messages/);
  assert.match(ui, /assistant_suggested_actions/);
  assert.match(ui, /applyAction/);
  assert.match(ui, /updateActionStatus/);
});

test("platform assistant restores history and infers focused context", () => {
  assert.match(api, /loadSessionHistory/);
  assert.match(api, /retrievalTextFromHistory/);
  assert.match(api, /normaliseScope/);
  assert.match(api, /contextProfile/);
  assert.match(api, /ASSISTANT_TOOL_SCHEMAS/);
  assert.match(api, /executeAssistantTool/);
  assert.match(api, /find_invoice_or_payable/);
  assert.match(api, /get_field_performance/);
  assert.match(api, /mentionedFieldIds/);
  assert.match(api, /performanceByField90d/);
  assert.match(api, /fieldAdvice90d/);
  assert.match(api, /generic recommendations|generic farming advice/);
  assert.match(api, /historicNdvi/);
  assert.match(api, /historicSar/);
});

test("assistant tool schemas expose integrated platform capabilities", () => {
  const names = hooks.ASSISTANT_TOOL_SCHEMAS.map((tool) => tool.function.name);
  for (const name of [
    "get_available_context",
    "search_documents",
    "find_invoice_or_payable",
    "resolve_field",
    "get_field_performance",
    "get_finance_summary",
    "get_operations_summary",
    "get_compliance_status",
  ]) {
    assert.ok(names.includes(name), `${name} should be exposed as a tool`);
  }
});

test("assistant tool argument validation clamps unsafe values", () => {
  assert.deepEqual(
    hooks.validateToolArgs({ name: "get_field_performance" }, { fieldName: "America Field", periodDays: 9999 }),
    { fieldName: "America Field", fieldId: null, periodDays: 365 },
  );
  assert.deepEqual(
    hooks.validateToolArgs({ name: "search_documents" }, { query: "invoice", matchCount: 999 }),
    { query: "invoice", category: null, matchCount: 30 },
  );
});

test("assistant action examples cover every action type and validate", () => {
  const actionTypes = [...hooks.ACTION_TYPES].sort();
  const exampleTypes = Object.keys(hooks.ACTION_EXAMPLE_CATALOG).sort();
  assert.deepEqual(exampleTypes, actionTypes);

  for (const actionType of actionTypes) {
    const example = hooks.ACTION_EXAMPLE_CATALOG[actionType];
    assert.equal(example.action_type, actionType);
    assert.ok(example.title);
    assert.ok(example.summary);
    assert.ok(example.payload && typeof example.payload === "object");

    const rows = hooks.validateSuggestedActions([example], "farm-id", "user-id", "session-id");
    assert.equal(rows.length, 1, `${actionType} example should validate`);
    assert.equal(rows[0].action_type, actionType);
    assert.ok(Object.keys(rows[0].payload).length > 0, `${actionType} example should keep payload fields`);
  }
});

test("assistant prompt includes canonical action JSON examples", () => {
  const prompt = hooks.assistantToolSystemPrompt({ mode: "chat", reportType: null, scope: "whole_farm" });
  const examples = JSON.parse(hooks.actionExamplesForPrompt());
  assert.match(prompt, /Suggested action JSON examples/);
  for (const example of examples) {
    assert.match(prompt, new RegExp(`"action_type": "${example.action_type}"`));
  }
});

test("assistant suggested actions are schema-cleaned before persistence", () => {
  const rows = hooks.validateSuggestedActions([
    {
      action_type: "finance_transaction",
      title: "Pay invoice",
      confidence: 2,
      payload: {
        type: "expense",
        amount: "123.45",
        vatAmount: "24.69",
        counterparty: "Fangorn Group Limited",
        invoiceRef: "INV-1",
        unknownKey: "drop me",
      },
    },
    { action_type: "delete_everything", title: "bad" },
  ], "farm-id", "user-id", "session-id");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confidence, 1);
  assert.equal(rows[0].payload.amount, 123.45);
  assert.equal(rows[0].payload.unknownKey, undefined);
  assert.equal(rows[0].origin_id, "session-id");
});

test("assistant normalises invoice-style finance payload fields", () => {
  const rows = hooks.validateSuggestedActions([
    {
      action_type: "finance_transaction",
      title: "Add Fangorn Invoice-0000022",
      payload: {
        type: "expense",
        amountDue: "2051.25",
        invoiceDate: "2025-12-18",
        supplier: "Fangorn Group Limited",
        invoiceNumber: "Fangorn Invoice-0000022",
        vat: "410.25",
      },
    },
  ], "farm-id", "user-id", "session-id");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.amount, 2051.25);
  assert.equal(rows[0].payload.vatAmount, 410.25);
  assert.equal(rows[0].payload.date, "2025-12-18");
  assert.equal(rows[0].payload.counterparty, "Fangorn Group Limited");
  assert.equal(rows[0].payload.invoiceRef, "Fangorn Invoice-0000022");
});

test("field observations are normalised to DB-safe persisted actions", () => {
  const rows = hooks.validateSuggestedActions([
    {
      action_type: "field_observation",
      title: "Black grass in America Field",
      summary: "Create a field observation for black grass in the south east corner.",
      payload: {
        fieldName: "America Field",
        type: "weed",
        notes: "Black grass seen in the south east corner.",
        recommendedAction: "Review whether a follow-up spray is needed.",
      },
    },
  ], "farm-id", "user-id", "session-id");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action_type, "field_observation");
  assert.equal(rows[0].payload.type, "weed");

  const persisted = hooks.persistableSuggestedActions(rows);
  assert.equal(persisted[0].action_type, "spray_record");
  assert.equal(persisted[0].payload.recordAs, "field_observation");
  assert.equal(persisted[0].metadata.intendedActionType, "field_observation");
});

test("suggested action insert failures return a warning instead of throwing", async () => {
  const fakeAdmin = {
    from(table) {
      assert.equal(table, "assistant_suggested_actions");
      return {
        insert(rows) {
          assert.equal(rows[0].action_type, "spray_record");
          return {
            select() {
              return Promise.resolve({
                data: null,
                error: {
                  message: "violates check constraint",
                  code: "23514",
                  details: "assistant_suggested_actions_action_type_check",
                },
              });
            },
          };
        },
      };
    },
  };
  const result = await hooks.persistSuggestedActions(fakeAdmin, [{
    action_type: "field_observation",
    title: "Black grass",
    payload: { notes: "Black grass seen", type: "weed" },
    metadata: {},
  }], "test");
  assert.deepEqual(result.actions, []);
  assert.match(result.warning, /could not save the suggested action/i);
});

test("global assistant applies intended observations and guards unsupported actions", () => {
  assert.match(ui, /function intendedActionType\(action\)/);
  assert.match(ui, /payload\?\.recordAs === "field_observation"/);
  assert.match(ui, /upsertObservationAction\(action, p\)/);
  assert.match(ui, /Unsupported assistant action type/);
});

test("assistant final payload parser tolerates non-json model output", () => {
  assert.deepEqual(hooks.parseFinalAssistantPayload("plain answer"), {
    answer: "plain answer",
    suggested_actions: [],
    source_ids: [],
  });
});

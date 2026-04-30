import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const api = await readFile(new URL("../tilth-api/documentVault.mjs", import.meta.url), "utf8");
const worker = await readFile(new URL("../tilth-api/document-worker/worker.py", import.meta.url), "utf8");
const graph = await readFile(new URL("../tilth-api/document-worker/graph.py", import.meta.url), "utf8");

test("document vault tenant tables have RLS enabled", () => {
  for (const table of [
    "document_processing_jobs",
    "document_audit_events",
    "document_chunks",
    "document_chunk_embeddings",
    "document_extracted_entities",
    "document_chat_sessions",
    "document_chat_messages",
    "document_generated_reports",
  ]) {
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
});

test("vector retrieval is farm-filtered at the database boundary", () => {
  assert.match(schema, /document_vault_match_chunks/i);
  assert.match(schema, /where e\.farm_id = p_farm_id/i);
  assert.match(schema, /and c\.farm_id = p_farm_id/i);
  assert.match(schema, /and d\.farm_id = p_farm_id/i);
  assert.match(schema, /and d\.deleted_at is null/i);
});

test("API resolves farm access server-side before document operations", () => {
  assert.match(api, /userCanReadFarm\(auth\.userId, farmId\)/);
  assert.match(api, /userCanEditFarm\(auth\.userId, farmId\)/);
  assert.doesNotMatch(api, /neo4j_database_name/);
  assert.match(api, /failed_access/);
});

test("worker leases jobs and writes farm-scoped outputs", () => {
  assert.match(worker, /locked_by/);
  assert.match(worker, /locked_until/);
  assert.match(worker, /farm_id/);
  assert.match(worker, /document_chunk_embeddings/);
  assert.match(worker, /document_extracted_entities/);
});

test("Neo4j graph loader uses shared database with farm-scoped constraints", () => {
  assert.match(graph, /REQUIRE f\.farm_id IS UNIQUE/);
  assert.match(graph, /REQUIRE \(d\.farm_id, d\.document_id\) IS UNIQUE/);
  assert.match(graph, /REQUIRE \(c\.farm_id, c\.chunk_id\) IS UNIQUE/);
  assert.match(graph, /farm_id: \$farm_id/);
  assert.doesNotMatch(graph, /session\(database=/);
});

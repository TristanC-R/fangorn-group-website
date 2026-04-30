# Document Vault Worker

Python worker for the Tilth Document Vault. It claims queued jobs from Supabase,
downloads the source file, parses/chunks with Docling where available, stores
chunks and embeddings in Postgres, and mirrors the document graph into a shared
Neo4j database with mandatory `farm_id` scoping.

## Setup

```bash
cd tilth-api/document-worker
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python worker.py
```

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional environment variables:

- `OPENAI_API_KEY` for real embeddings. Without it, the worker uses deterministic
  local hash embeddings so the pipeline can be exercised locally.
- `DOCUMENT_VAULT_EMBEDDING_MODEL`, default `text-embedding-3-small`.
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` for graph loading.
- `DOCUMENT_VAULT_WORKER_ID`, `DOCUMENT_VAULT_POLL_SECONDS`,
  `DOCUMENT_VAULT_LEASE_MINUTES`.

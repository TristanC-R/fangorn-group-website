import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from supabase import create_client

from graph import GraphLoader


WORKER_DIR = Path(__file__).resolve().parent
load_dotenv(WORKER_DIR.parent / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
WORKER_ID = os.getenv("DOCUMENT_VAULT_WORKER_ID", f"doc-worker-{os.getpid()}")
POLL_SECONDS = float(os.getenv("DOCUMENT_VAULT_POLL_SECONDS", "5"))
LEASE_MINUTES = int(os.getenv("DOCUMENT_VAULT_LEASE_MINUTES", "15"))
BUCKET = os.getenv("DOCUMENT_VAULT_BUCKET", "farm-documents")
EMBEDDING_MODEL = os.getenv("DOCUMENT_VAULT_EMBEDDING_MODEL", "text-embedding-3-small")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
PROCESSING_VERSION = os.getenv("DOCUMENT_VAULT_PROCESSING_VERSION", "docling-v1")
ALLOWED_CATEGORIES = {
    "certificate",
    "soil_analysis",
    "receipt",
    "invoice",
    "tenancy",
    "insurance",
    "spray_test",
    "nptc",
    "organic",
    "red_tractor",
    "scheme_evidence",
    "map",
    "photo",
    "photograph",
    "report",
    "notice",
    "contract",
    "letter",
    "email",
    "asset",
    "vehicle",
    "field_evidence",
    "other",
    "general",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalise(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def title_from_filename(filename: str) -> str:
    stem = Path(filename or "Untitled document").stem
    return re.sub(r"\s+", " ", re.sub(r"[_-]+", " ", stem)).strip() or "Untitled document"


def fallback_embedding(text: str, dimensions: int = 1536) -> list[float]:
    seed = hashlib.sha256(text.encode("utf-8", errors="ignore")).digest()
    values = []
    norm = 0.0
    for idx in range(dimensions):
        signed = (seed[idx % len(seed)] / 255.0) * 2.0 - 1.0
        values.append(signed)
        norm += signed * signed
    denom = norm ** 0.5 or 1.0
    return [v / denom for v in values]


def embed_text(text: str) -> tuple[str, int, list[float], str]:
    if not OPENAI_API_KEY:
        model = f"local-hash-{EMBEDDING_MODEL}"
        return model, 1536, fallback_embedding(text), "local-hash"
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)
    result = client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    embedding = result.data[0].embedding
    return EMBEDDING_MODEL, len(embedding), embedding, "openai"


def infer_document_details(text: str, document: dict[str, Any]) -> dict[str, Any]:
    sample = (text or "")[:8000]
    fallback_title = title_from_filename(document.get("filename") or document.get("title") or "")
    details = {
        "title": fallback_title,
        "category": "general",
        "tags": [],
        "notes": "",
        "expiry_date": None,
        "confidence": 0.25,
        "method": "fallback",
    }
    lowered = sample.lower()
    if "invoice" in lowered:
        details["category"] = "invoice"
    elif "receipt" in lowered:
        details["category"] = "receipt"
    elif "certificate" in lowered:
        details["category"] = "certificate"
    elif "contract" in lowered or "agreement" in lowered:
        details["category"] = "contract"
    elif "notice" in lowered:
        details["category"] = "notice"
    elif "report" in lowered:
        details["category"] = "report"
    date_match = re.search(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b", sample)
    if date_match:
        yyyy, mm, dd = date_match.groups()
        details["expiry_date"] = f"{yyyy}-{int(mm):02d}-{int(dd):02d}"

    first_lines = [line.strip("# ").strip() for line in sample.splitlines() if len(line.strip()) > 6]
    if first_lines:
        details["title"] = first_lines[0][:120]

    if not OPENAI_API_KEY or not sample.strip():
        return details

    try:
        from openai import OpenAI

        client = OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model=os.getenv("DOCUMENT_VAULT_CHAT_MODEL", "gpt-4o-mini"),
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Extract concise document metadata as JSON. Use only these categories: "
                        + ", ".join(sorted(ALLOWED_CATEGORIES))
                        + ". Return keys: title, category, tags, notes, expiry_date, confidence. "
                        "expiry_date must be YYYY-MM-DD or null. tags must be an array of short strings."
                    ),
                },
                {"role": "user", "content": sample},
            ],
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
        category = parsed.get("category") if parsed.get("category") in ALLOWED_CATEGORIES else details["category"]
        tags = parsed.get("tags") if isinstance(parsed.get("tags"), list) else details["tags"]
        return {
            "title": str(parsed.get("title") or details["title"])[:160],
            "category": category,
            "tags": [str(tag).strip()[:40] for tag in tags if str(tag).strip()][:8],
            "notes": str(parsed.get("notes") or details["notes"])[:500],
            "expiry_date": parsed.get("expiry_date") or details["expiry_date"],
            "confidence": float(parsed.get("confidence") or 0.75),
            "method": "openai",
        }
    except Exception as exc:
        return {**details, "error": str(exc)}


def parse_date_to_iso(value: str) -> str | None:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y"):
        try:
            parsed = datetime.strptime(value, fmt)
            if parsed.year < 2000:
                parsed = parsed.replace(year=parsed.year + 100)
            return parsed.date().isoformat()
        except ValueError:
            continue
    return None


def first_date_near(text: str, keywords: list[str]) -> str | None:
    for keyword in keywords:
        pattern = re.compile(
            rf"{keyword}.{{0,80}}?(\b20\d{{2}}-\d{{1,2}}-\d{{1,2}}\b|\b\d{{1,2}}[/-]\d{{1,2}}[/-]\d{{2,4}}\b)",
            re.I | re.S,
        )
        match = pattern.search(text)
        if match:
            iso = parse_date_to_iso(match.group(1))
            if iso:
                return iso
    return None


def first_date(text: str) -> str | None:
    match = re.search(r"\b20\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", text or "")
    return parse_date_to_iso(match.group(0)) if match else None


def money_to_number(value: str) -> float | None:
    cleaned = re.sub(r"[^\d.]", "", value or "")
    try:
        return round(float(cleaned), 2)
    except ValueError:
        return None


def money_values(text: str) -> list[float]:
    values = []
    for match in re.finditer(r"\b(?:£|GBP\s?)\d[\d,]*(?:\.\d{2})?\b", text or "", re.I):
        parsed = money_to_number(match.group(0))
        if parsed is not None:
            values.append(parsed)
    return values


def invoice_reference(text: str) -> str:
    match = re.search(r"\b(?:invoice|inv)[\s:#-]*([A-Z0-9-]{4,})\b", text or "", re.I)
    return match.group(1) if match else ""


def likely_counterparty(text: str, fallback: str) -> str:
    for line in (text or "").splitlines()[:12]:
        clean = re.sub(r"\s+", " ", line.strip("# :-"))
        if len(clean) < 3 or len(clean) > 80:
            continue
        if re.search(r"invoice|receipt|statement|tax|vat|date|amount", clean, re.I):
            continue
        return clean
    return fallback


def quantity_and_unit(text: str) -> tuple[float, str] | tuple[None, str]:
    match = re.search(r"\b(\d+(?:\.\d+)?)\s?(litres?|l|kg|tonnes?|t|bags?|units?)\b", text or "", re.I)
    if not match:
        return None, ""
    unit = match.group(2).lower()
    if unit == "litres":
        unit = "L"
    elif unit == "l":
        unit = "L"
    elif unit in {"tonne", "tonnes"}:
        unit = "t"
    return float(match.group(1)), unit


def infer_document_actions(text: str, document: dict[str, Any], details: dict[str, Any]) -> list[dict[str, Any]]:
    sample = text or ""
    lowered = sample.lower()
    farm_id = document["farm_id"]
    document_id = document["id"]
    title = details.get("title") or document.get("title") or title_from_filename(document.get("filename") or "")
    category = details.get("category") or document.get("category") or "general"
    counterparty = likely_counterparty(sample, title)
    invoice_ref = invoice_reference(sample)
    due_date = first_date_near(sample, ["due date", "payment due", "pay by", "due"]) or details.get("expiry_date")
    invoice_date = first_date_near(sample, ["invoice date", "date"]) or first_date(sample)
    amounts = money_values(sample)
    total_amount = max(amounts) if amounts else None
    suggestions: list[dict[str, Any]] = []

    def add(action_type: str, action_title: str, summary: str, payload: dict[str, Any], confidence: float):
        suggestions.append(
            {
                "farm_id": farm_id,
                "document_id": document_id,
                "action_type": action_type,
                "title": action_title[:160],
                "summary": summary[:500],
                "confidence": confidence,
                "payload": {
                    **payload,
                    "documentId": document_id,
                    "documentTitle": title,
                    "sourceKey": payload.get("sourceKey") or f"document:{document_id}:{action_type}",
                },
                "metadata": {
                    "method": "worker-regex-v1",
                    "document_category": category,
                },
            }
        )

    if category in {"invoice", "receipt"} or re.search(r"\binvoice\b|\breceipt\b", lowered):
        if total_amount is not None:
            add(
                "finance_transaction",
                f"Add finance entry for {title}",
                f"Suggested {category} ledger entry for £{total_amount:.2f}"
                + (f" from {counterparty}" if counterparty else "")
                + (f" with invoice ref {invoice_ref}" if invoice_ref else ""),
                {
                    "type": "expense",
                    "date": invoice_date or datetime.now(timezone.utc).date().isoformat(),
                    "amount": total_amount,
                    "vatAmount": 0,
                    "category": "other",
                    "description": title,
                    "counterparty": counterparty,
                    "invoiceRef": invoice_ref,
                    "fieldId": document.get("field_id") or "",
                    "notes": f"Created from Document Vault: {document.get('filename') or title}",
                    "sourceKey": f"document:{document_id}:finance",
                },
                0.78 if invoice_ref else 0.64,
            )
        if due_date:
            add(
                "calendar_reminder",
                f"Remind payment due for {title}",
                f"Suggested payment reminder for {due_date}" + (f" for invoice {invoice_ref}" if invoice_ref else ""),
                {
                    "title": f"Pay invoice: {counterparty or title}",
                    "dueDate": due_date,
                    "reminderDays": 3,
                    "category": "finance",
                    "priority": "high",
                    "notes": f"Invoice payment reminder from Document Vault. {invoice_ref}".strip(),
                    "source": "document-vault",
                    "sourceId": document_id,
                    "sourceKey": f"document:{document_id}:payment_due",
                },
                0.82,
            )

    inventory_terms = r"\b(chemical|herbicide|fungicide|insecticide|fertili[sz]er|seed|spray|adjuvant|batch|mapp)\b"
    if re.search(inventory_terms, lowered):
        quantity, unit = quantity_and_unit(sample)
        unit_cost = round(total_amount / quantity, 2) if total_amount and quantity else 0
        product_name = title
        mapp_match = re.search(r"\bMAPP\s*(?:no\.?|number)?\s*[:#-]?\s*(\d{4,6})\b", sample, re.I)
        batch_match = re.search(r"\b(?:batch|lot)\s*[:#-]?\s*([A-Z0-9-]{3,})\b", sample, re.I)
        expiry = first_date_near(sample, ["expiry", "expires", "use by", "best before"])
        add(
            "inventory_item",
            f"Add store item from {title}",
            "Suggested stock entry extracted from a chemical, seed, fertiliser or spray document.",
            {
                "name": product_name,
                "category": "chemical" if re.search(r"chemical|herbicide|fungicide|insecticide|spray|mapp", lowered) else "other",
                "unit": unit or "unit",
                "quantity": quantity or 0,
                "unitCost": unit_cost,
                "batchNumber": batch_match.group(1) if batch_match else "",
                "supplier": counterparty,
                "purchaseDate": invoice_date or "",
                "expiryDate": expiry or "",
                "storageLocation": "",
                "mappNumber": mapp_match.group(1) if mapp_match else "",
                "lowStockThreshold": None,
                "notes": f"Created from Document Vault: {document.get('filename') or title}",
                "sourceKey": f"document:{document_id}:inventory",
            },
            0.66,
        )

    if re.search(r"\b(spray|sprayed|application|applied|herbicide|fungicide|insecticide)\b", lowered):
        action_date = first_date(sample) or datetime.now(timezone.utc).date().isoformat()
        add(
            "spray_record",
            f"Draft spray/input note from {title}",
            "Suggested field record draft. Review the product, rate and field before applying.",
            {
                "date": action_date,
                "fieldId": document.get("field_id") or "",
                "fieldName": "",
                "productName": title,
                "rate": 0,
                "operator": "",
                "notes": f"Drafted from Document Vault. Review before using: {title}",
                "sourceKey": f"document:{document_id}:spray_record",
            },
            0.52,
        )

    return suggestions[:6]


def parse_with_docling(path: Path) -> dict[str, Any]:
    try:
        from docling.document_converter import DocumentConverter

        converter = DocumentConverter()
        result = converter.convert(str(path))
        document = result.document
        markdown = document.export_to_markdown()
        docling_json = document.export_to_dict()
        return {
            "text": markdown,
            "markdown": markdown,
            "docling_json": docling_json,
            "method": "docling",
        }
    except Exception as exc:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            text = ""
        return {
            "text": text,
            "markdown": text,
            "docling_json": {"fallback": True, "error": str(exc)},
            "method": "fallback-text",
        }


def chunk_text(text: str, target_chars: int = 1800, overlap_chars: int = 180) -> list[dict[str, Any]]:
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[dict[str, Any]] = []
    current = ""
    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= target_chars:
            current = candidate
            continue
        if current:
            chunks.append({"chunk_text": current})
            current = current[-overlap_chars:] + "\n\n" + paragraph
        while len(current) > target_chars:
            chunks.append({"chunk_text": current[:target_chars]})
            current = current[target_chars - overlap_chars :]
    if current:
        chunks.append({"chunk_text": current})
    for idx, chunk in enumerate(chunks):
        chunk["chunk_index"] = idx
        chunk["token_count"] = max(1, len(chunk["chunk_text"]) // 4)
    return chunks


ENTITY_PATTERNS = [
    ("MONEY", re.compile(r"\b(?:£|GBP\s?)\d[\d,]*(?:\.\d{2})?\b", re.I)),
    ("DATE", re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b")),
    ("INVOICE_NUMBER", re.compile(r"\b(?:invoice|inv)[\s:#-]*([A-Z0-9-]{4,})\b", re.I)),
    ("EMAIL", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)),
    ("POSTCODE", re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", re.I)),
]


def extract_entities(chunk: dict[str, Any], farm_id: str, document_id: str, chunk_id: str) -> list[dict[str, Any]]:
    entities = []
    text = chunk.get("chunk_text") or ""
    for entity_type, pattern in ENTITY_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(1) if entity_type == "INVOICE_NUMBER" and match.groups() else match.group(0)
            entities.append(
                {
                    "farm_id": farm_id,
                    "document_id": document_id,
                    "chunk_id": chunk_id,
                    "entity_type": entity_type,
                    "entity_value": value,
                    "normalised_value": normalise(value),
                    "confidence": 0.85,
                    "extraction_method": "regex",
                    "metadata": {},
                }
            )
    return entities


class DocumentWorker:
    def __init__(self):
        if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        self.supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        self.graph = GraphLoader()

    def claim_job(self) -> dict[str, Any] | None:
        now = utc_now()
        result = (
            self.supabase.table("document_processing_jobs")
            .select("*")
            .in_("status", ["queued", "failed"])
            .order("created_at")
            .limit(10)
            .execute()
        )
        if not result.data:
            return None
        job = None
        now_dt = datetime.now(timezone.utc)
        for candidate in result.data:
            if int(candidate.get("attempt_count") or 0) >= int(candidate.get("max_attempts") or 3):
                continue
            locked_until = candidate.get("locked_until")
            if locked_until:
                try:
                    locked_dt = datetime.fromisoformat(locked_until.replace("Z", "+00:00"))
                    if locked_dt > now_dt:
                        continue
                except Exception:
                    pass
            job = candidate
            break
        if not job:
            return None
        lease_until = (datetime.now(timezone.utc) + timedelta(minutes=LEASE_MINUTES)).isoformat()
        updated = (
            self.supabase.table("document_processing_jobs")
            .update(
                {
                    "status": "processing",
                    "attempt_count": int(job.get("attempt_count") or 0) + 1,
                    "locked_by": WORKER_ID,
                    "locked_until": lease_until,
                    "started_at": job.get("started_at") or now,
                    "updated_at": now,
                }
            )
            .eq("id", job["id"])
            .execute()
        )
        if not updated.data:
            return None
        return updated.data[0]

    def set_job_status(self, job: dict[str, Any], status: str, **extra: Any):
        payload = {"status": status, "updated_at": utc_now(), **extra}
        self.supabase.table("document_processing_jobs").update(payload).eq("id", job["id"]).execute()

    def set_document_status(self, document_id: str, status: str, **extra: Any):
        payload = {"status": status, "updated_at": utc_now(), **extra}
        self.supabase.table("farm_documents").update(payload).eq("id", document_id).execute()

    def cleanup_document(self, job: dict[str, Any], document: dict[str, Any]):
        farm_id = job["farm_id"]
        document_id = job["document_id"]
        self.supabase.table("document_chunk_embeddings").delete().eq("document_id", document_id).execute()
        self.supabase.table("document_extracted_entities").delete().eq("document_id", document_id).execute()
        self.supabase.table("document_suggested_actions").delete().eq("document_id", document_id).eq("status", "pending").execute()
        self.supabase.table("document_chunks").delete().eq("document_id", document_id).execute()
        self.graph.delete_document(farm_id, document_id)
        prefix = f"{farm_id}/documents/{document_id}"
        try:
            listed = self.supabase.storage.from_(BUCKET).list(prefix)
            paths = [f"{prefix}/{item['name']}" for item in listed if item.get("name")]
            if paths:
                self.supabase.storage.from_(BUCKET).remove(paths)
        except Exception:
            pass
        self.set_job_status(job, "completed", completed_at=utc_now(), locked_until=None)

    def process_job(self, job: dict[str, Any]):
        document_id = job["document_id"]
        doc_result = self.supabase.table("farm_documents").select("*").eq("id", document_id).single().execute()
        document = doc_result.data
        if not document:
            raise RuntimeError(f"document not found: {document_id}")
        if (job.get("metadata") or {}).get("cleanup"):
            self.cleanup_document(job, document)
            return

        farm_id = document["farm_id"]
        self.set_document_status(document_id, "processing", error_message=None)
        raw = self.supabase.storage.from_(document.get("bucket") or BUCKET).download(document["storage_path"])
        content_hash = sha256_bytes(raw)
        suffix = Path(document.get("filename") or "document").suffix or ".bin"
        with tempfile.TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / f"source{suffix}"
            source_path.write_bytes(raw)
            parsed = parse_with_docling(source_path)
        artefact_prefix = f"{farm_id}/documents/{document_id}/processed"
        self.supabase.storage.from_(BUCKET).upload(
            f"{artefact_prefix}/docling.json",
            json.dumps(parsed["docling_json"], ensure_ascii=False).encode("utf-8"),
            {"content-type": "application/json", "upsert": "true"},
        )
        self.supabase.storage.from_(BUCKET).upload(
            f"{artefact_prefix}/markdown.md",
            parsed["markdown"].encode("utf-8"),
            {"content-type": "text/markdown", "upsert": "true"},
        )
        extracted_details = infer_document_details(parsed["text"], document)
        existing_metadata = document.get("metadata") or {}
        should_autofill = existing_metadata.get("auto_populate") is not False and not existing_metadata.get("user_edited_details")
        if should_autofill:
            detail_update: dict[str, Any] = {
                "metadata": {
                    **existing_metadata,
                    "parse_method": parsed["method"],
                    "extracted_details": extracted_details,
                    "auto_populated_at": utc_now(),
                }
            }
            if existing_metadata.get("title_is_placeholder") or not document.get("title"):
                detail_update["title"] = extracted_details["title"]
            if (document.get("category") or "general") == "general":
                detail_update["category"] = extracted_details["category"]
            if not document.get("tags") and extracted_details.get("tags"):
                detail_update["tags"] = extracted_details["tags"]
            if not document.get("notes") and extracted_details.get("notes"):
                detail_update["notes"] = extracted_details["notes"]
            if not document.get("expiry_date") and extracted_details.get("expiry_date"):
                detail_update["expiry_date"] = extracted_details["expiry_date"]
            self.supabase.table("farm_documents").update(detail_update).eq("id", document_id).execute()
            document = {**document, **detail_update}
        suggestions = infer_document_actions(parsed["text"], document, extracted_details)
        self.supabase.table("document_suggested_actions").delete().eq("document_id", document_id).eq("status", "pending").execute()
        if suggestions:
            self.supabase.table("document_suggested_actions").insert(suggestions).execute()
        self.set_job_status(job, "parsed")
        self.set_document_status(
            document_id,
            "parsed",
            content_hash=content_hash,
            processing_version=PROCESSING_VERSION,
            metadata={
                **(document.get("metadata") or {}),
                "parse_method": parsed["method"],
                "extracted_details": extracted_details,
            },
        )

        self.supabase.table("document_chunk_embeddings").delete().eq("document_id", document_id).execute()
        self.supabase.table("document_extracted_entities").delete().eq("document_id", document_id).execute()
        self.supabase.table("document_chunks").delete().eq("document_id", document_id).execute()

        chunks = chunk_text(parsed["text"])
        inserted_chunks = []
        for chunk in chunks:
            row = {
                "farm_id": farm_id,
                "document_id": document_id,
                "chunk_index": chunk["chunk_index"],
                "chunk_text": chunk["chunk_text"],
                "token_count": chunk["token_count"],
                "source_metadata": {"storage_path": document["storage_path"]},
                "docling_metadata": {"parse_method": parsed["method"]},
            }
            result = self.supabase.table("document_chunks").insert(row).execute()
            inserted_chunks.append(result.data[0])
        self.set_job_status(job, "chunked")
        self.set_document_status(document_id, "chunked")

        all_entities = []
        for chunk in inserted_chunks:
            model, dimensions, embedding, provider = embed_text(chunk["chunk_text"])
            self.supabase.table("document_chunk_embeddings").insert(
                {
                    "farm_id": farm_id,
                    "document_id": document_id,
                    "chunk_id": chunk["id"],
                    "embedding_model": model,
                    "embedding_dimensions": dimensions,
                    "embedding": embedding,
                    "metadata": {"provider": provider},
                }
            ).execute()
            all_entities.extend(extract_entities(chunk, farm_id, document_id, chunk["id"]))
        if all_entities:
            self.supabase.table("document_extracted_entities").insert(all_entities).execute()
        self.set_job_status(job, "embedded")
        self.set_document_status(document_id, "embedded")

        graph_loaded = self.graph.load_document(farm_id, document, inserted_chunks, all_entities)
        self.set_job_status(job, "graph_loaded" if graph_loaded else "completed")
        self.set_document_status(document_id, "graph_loaded" if graph_loaded else "completed")
        self.set_job_status(job, "completed", completed_at=utc_now(), locked_until=None, locked_by=None)
        self.set_document_status(document_id, "completed")

    def run_forever(self):
        print(f"Document Vault worker starting as {WORKER_ID}")
        try:
            while True:
                job = self.claim_job()
                if not job:
                    time.sleep(POLL_SECONDS)
                    continue
                try:
                    self.process_job(job)
                except Exception as exc:
                    print(f"Job {job.get('id')} failed: {exc}")
                    self.set_job_status(job, "failed", last_error=str(exc), locked_until=None, locked_by=None)
                    self.set_document_status(job["document_id"], "failed", error_message=str(exc))
        finally:
            self.graph.close()


if __name__ == "__main__":
    DocumentWorker().run_forever()

import base64
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
# Shared secrets with tilth-api; optional `document-worker/.env` overrides for local runs.
load_dotenv(WORKER_DIR.parent / ".env")
load_dotenv(WORKER_DIR / ".env", override=True)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
WORKER_ID = os.getenv("DOCUMENT_VAULT_WORKER_ID", f"doc-worker-{os.getpid()}")
POLL_SECONDS = float(os.getenv("DOCUMENT_VAULT_POLL_SECONDS", "5"))
LEASE_MINUTES = int(os.getenv("DOCUMENT_VAULT_LEASE_MINUTES", "15"))
BUCKET = os.getenv("DOCUMENT_VAULT_BUCKET", "farm-documents")
EMBEDDING_MODEL = os.getenv("DOCUMENT_VAULT_EMBEDDING_MODEL", "text-embedding-3-small")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
PROCESSING_VERSION = os.getenv("DOCUMENT_VAULT_PROCESSING_VERSION", "docling-v1")
EMBEDDING_BATCH_SIZE = max(1, int(os.getenv("DOCUMENT_VAULT_EMBEDDING_BATCH_SIZE", "32")))
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

ALLOWED_ACTION_TYPES = {
    "calendar_reminder",
    "finance_transaction",
    "inventory_item",
    "spray_record",
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
    return embed_texts([text])[0]


def embed_texts(texts: list[str]) -> list[tuple[str, int, list[float], str]]:
    if not OPENAI_API_KEY:
        model = f"local-hash-{EMBEDDING_MODEL}"
        return [(model, 1536, fallback_embedding(text), "local-hash") for text in texts]
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)
    result = client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    ordered = sorted(result.data, key=lambda item: item.index)
    return [(EMBEDDING_MODEL, len(item.embedding), item.embedding, "openai") for item in ordered]


def infer_document_details(
    text: str,
    document: dict[str, Any],
    raw_bytes: bytes | None = None,
    content_type: str = "",
) -> dict[str, Any]:
    sample = (text or "")[:8000]
    fallback_title = title_from_filename(document.get("filename") or document.get("title") or "")
    document_date = first_date_near(sample, ["invoice date", "document date", "date", "issued", "statement date"]) or first_date(sample)
    expiry_date = first_date_near(sample, ["expiry", "expires", "valid until", "renewal", "due date", "payment due"])
    details = {
        "title": fallback_title,
        "category": "general",
        "tags": [],
        "notes": "",
        "document_date": document_date,
        "expiry_date": expiry_date,
        "due_date": first_date_near(sample, ["due date", "payment due", "pay by", "deadline"]),
        "issuer": "",
        "counterparty": "",
        "invoice_number": invoice_reference(sample),
        "total_amount": max(money_values(sample), default=None),
        "vat_amount": None,
        "currency": "GBP" if re.search(r"\b(£|gbp)\b", sample, re.I) else "",
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
    first_lines = [line.strip("# ").strip() for line in sample.splitlines() if len(line.strip()) > 6]
    if first_lines:
        details["title"] = first_lines[0][:120]

    can_use_vision = bool(
        OPENAI_API_KEY
        and raw_bytes
        and str(content_type or "").lower().startswith("image/")
    )
    if not OPENAI_API_KEY or (not sample.strip() and not can_use_vision):
        return details

    try:
        from openai import OpenAI

        client = OpenAI(api_key=OPENAI_API_KEY)
        if sample.strip():
            user_content: str | list[dict[str, Any]] = sample
        else:
            image_data = base64.b64encode(raw_bytes or b"").decode("ascii")
            user_content = [
                {
                    "type": "text",
                    "text": (
                        "Extract metadata from this farm document image or scan. "
                        f"The uploaded filename is {document.get('filename') or document.get('title') or 'document'}."
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{content_type};base64,{image_data}"},
                },
            ]
        response = client.chat.completions.create(
            model=os.getenv("DOCUMENT_VAULT_CHAT_MODEL", "gpt-4o-mini"),
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Extract concise farm document metadata as strict JSON. Use only these categories: "
                        + ", ".join(sorted(ALLOWED_CATEGORIES))
                        + ". Return keys: title, category, tags, notes, document_date, expiry_date, due_date, "
                        "issuer, counterparty, invoice_number, total_amount, vat_amount, currency, confidence. "
                        "All dates must be YYYY-MM-DD or null. Use expiry_date only for validity/renewal/expiry dates. "
                        "Use document_date for invoice/issue/report/letter dates. tags must be an array of short strings. "
                        "notes should be one concise sentence explaining what the document is and any action needed."
                    ),
                },
                {"role": "user", "content": user_content},
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
            "document_date": parse_date_to_iso(str(parsed.get("document_date") or "")) or details["document_date"],
            "expiry_date": parse_date_to_iso(str(parsed.get("expiry_date") or "")) or details["expiry_date"],
            "due_date": parse_date_to_iso(str(parsed.get("due_date") or "")) or details["due_date"],
            "issuer": str(parsed.get("issuer") or details["issuer"])[:160],
            "counterparty": str(parsed.get("counterparty") or details["counterparty"])[:160],
            "invoice_number": str(parsed.get("invoice_number") or details["invoice_number"])[:120],
            "total_amount": parsed.get("total_amount") if isinstance(parsed.get("total_amount"), (int, float)) else details["total_amount"],
            "vat_amount": parsed.get("vat_amount") if isinstance(parsed.get("vat_amount"), (int, float)) else details["vat_amount"],
            "currency": str(parsed.get("currency") or details["currency"])[:20],
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


def is_spray_application_document(text: str, details: dict[str, Any]) -> bool:
    sample = (text or "").lower()
    category = str(details.get("category") or "").lower()
    if category in {"spray_test", "nptc"}:
        return False
    has_application_language = re.search(
        r"\b(spray(?:ed)?|application|applied|herbicide|fungicide|insecticide)\b",
        sample,
    )
    has_record_evidence = re.search(
        r"\b(field|operator|rate|l/ha|litres?/ha|product|mapp|boom|nozzle|water volume|weather|wind)\b",
        sample,
    )
    has_person_document_markers = re.search(
        r"\b(cv|curriculum vitae|resume|employment|education|experience|skills|phd|researcher)\b",
        sample,
    )
    return bool(has_application_language and has_record_evidence and not has_person_document_markers)


def infer_document_actions_with_llm(text: str, document: dict[str, Any], details: dict[str, Any]) -> list[dict[str, Any]] | None:
    if not OPENAI_API_KEY:
        return None
    sample = (text or "")[:6000]
    if not sample.strip():
        return []
    try:
        from openai import OpenAI

        client = OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model=os.getenv("DOCUMENT_VAULT_CHAT_MODEL", "gpt-4o-mini"),
            temperature=0.05,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You create context-aware suggested actions from farm documents. "
                        "Return strict JSON: {\"actions\": [...]}. Return [] when the document is informational, "
                        "a CV/resume, correspondence with no operational obligation, or evidence is insufficient. "
                        "Allowed action_type values: calendar_reminder, finance_transaction, inventory_item, spray_record. "
                        "Only create spray_record when the document is an actual spray/application/work record with evidence "
                        "such as field, product, rate, operator, date, MAPP, water volume or weather. Do not create spray_record "
                        "from CVs, qualifications, certificates, product marketing, general agricultural text, or future recommendations. "
                        "Only create finance_transaction for invoices/receipts with money evidence. "
                        "Only create inventory_item for purchased/stored stock with product and quantity evidence. "
                        "Only create calendar_reminder for explicit due, expiry, renewal, deadline or payment dates."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "filename": document.get("filename"),
                            "title": document.get("title"),
                            "extracted_details": details,
                            "document_text_sample": sample,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
        actions = parsed.get("actions")
        return actions if isinstance(actions, list) else []
    except Exception as exc:
        print(f"LLM document action inference failed for {document.get('id')}: {exc}")
        return None


def infer_document_actions(text: str, document: dict[str, Any], details: dict[str, Any]) -> list[dict[str, Any]]:
    sample = text or ""
    lowered = sample.lower()
    farm_id = document["farm_id"]
    document_id = document["id"]
    title = details.get("title") or document.get("title") or title_from_filename(document.get("filename") or "")
    category = details.get("category") or document.get("category") or "general"
    counterparty = details.get("counterparty") or details.get("issuer") or likely_counterparty(sample, title)
    invoice_ref = details.get("invoice_number") or invoice_reference(sample)
    due_date = details.get("due_date") or first_date_near(sample, ["due date", "payment due", "pay by", "due"]) or details.get("expiry_date")
    invoice_date = details.get("document_date") or first_date_near(sample, ["invoice date", "date"]) or first_date(sample)
    amounts = money_values(sample)
    total_amount = details.get("total_amount") if isinstance(details.get("total_amount"), (int, float)) else (max(amounts) if amounts else None)
    vat_amount = details.get("vat_amount") if isinstance(details.get("vat_amount"), (int, float)) else 0
    suggestions: list[dict[str, Any]] = []

    def add(action_type: str, action_title: str, summary: str, payload: dict[str, Any], confidence: float, method: str = "worker-regex-v1"):
        if action_type not in ALLOWED_ACTION_TYPES:
            return
        if action_type == "spray_record" and not is_spray_application_document(sample, details):
            return
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
                    "method": method,
                    "document_category": category,
                },
            }
        )

    llm_actions = infer_document_actions_with_llm(sample, document, details)
    if llm_actions is not None:
        for action in llm_actions[:6]:
            if not isinstance(action, dict):
                continue
            payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
            add(
                str(action.get("action_type") or ""),
                str(action.get("title") or title),
                str(action.get("summary") or ""),
                payload,
                float(action.get("confidence") or 0.65),
                "openai-context-v1",
            )
        return suggestions[:6]

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
                    "vatAmount": vat_amount,
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

    if is_spray_application_document(sample, details):
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


def walk_values(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_values(child)


def text_from_value(value: Any, max_chars: int = 4000) -> str:
    parts: list[str] = []

    def visit(item: Any):
        if len(" ".join(parts)) >= max_chars:
            return
        if isinstance(item, str):
            clean = re.sub(r"\s+", " ", item).strip()
            if clean:
                parts.append(clean)
        elif isinstance(item, dict):
            for key in ("text", "caption", "label", "name", "content"):
                if isinstance(item.get(key), str):
                    visit(item[key])
            for key in ("cells", "data", "children", "items"):
                if key in item:
                    visit(item[key])
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return " ".join(parts)[:max_chars]


def first_int(value: Any, keys: tuple[str, ...]) -> int | None:
    for node in walk_values(value):
        for key in keys:
            raw = node.get(key)
            if isinstance(raw, int):
                return raw
            if isinstance(raw, str) and raw.isdigit():
                return int(raw)
    return None


def bounding_boxes_from_value(value: Any) -> list[dict[str, Any]]:
    boxes: list[dict[str, Any]] = []
    for node in walk_values(value):
        for key in ("bbox", "bounding_box", "prov"):
            raw = node.get(key)
            if isinstance(raw, dict):
                boxes.append(raw)
            elif isinstance(raw, list):
                boxes.extend([item for item in raw if isinstance(item, dict)])
    return boxes[:8]


def markdown_tables(markdown: str) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    lines = (markdown or "").splitlines()
    idx = 0
    while idx < len(lines):
        if "|" not in lines[idx]:
            idx += 1
            continue
        block = []
        while idx < len(lines) and "|" in lines[idx]:
            block.append(lines[idx].strip())
            idx += 1
        if len(block) >= 2 and re.search(r"\|\s*:?-{2,}:?\s*\|", "\n".join(block)):
            rows = []
            for line in block:
                cells = [cell.strip() for cell in line.strip("|").split("|")]
                if cells and not all(re.fullmatch(r":?-{2,}:?", cell or "") for cell in cells):
                    rows.append(cells)
            tables.append({
                "markdown": "\n".join(block),
                "plain_text": "\n".join(" | ".join(row) for row in rows),
                "rows": rows,
                "source": "markdown",
            })
        idx += 1
    return tables


def docling_collection(docling_json: dict[str, Any], names: tuple[str, ...]) -> list[Any]:
    items: list[Any] = []
    for name in names:
        raw = docling_json.get(name)
        if isinstance(raw, list):
            items.extend(raw)
        elif isinstance(raw, dict):
            items.extend(raw.values())
    return items


def extract_table_evidence(parsed: dict[str, Any], farm_id: str, document_id: str) -> list[dict[str, Any]]:
    docling_json = parsed.get("docling_json") or {}
    evidence: list[dict[str, Any]] = []
    for table in docling_collection(docling_json, ("tables", "table_items")):
        plain_text = text_from_value(table)
        evidence.append({
            "farm_id": farm_id,
            "document_id": document_id,
            "table_index": len(evidence),
            "page_number": first_int(table, ("page_no", "page_number", "page")),
            "label": str(table.get("label") or table.get("name") or f"Table {len(evidence) + 1}")[:160] if isinstance(table, dict) else f"Table {len(evidence) + 1}",
            "caption": str(table.get("caption") or "")[:500] if isinstance(table, dict) else "",
            "markdown": table.get("markdown") if isinstance(table, dict) and isinstance(table.get("markdown"), str) else None,
            "plain_text": plain_text,
            "rows": table.get("data") if isinstance(table, dict) and isinstance(table.get("data"), list) else [],
            "bounding_boxes": bounding_boxes_from_value(table),
            "source_metadata": {"source": "docling"},
        })
    for table in markdown_tables(parsed.get("markdown") or ""):
        evidence.append({
            "farm_id": farm_id,
            "document_id": document_id,
            "table_index": len(evidence),
            "label": f"Markdown table {len(evidence) + 1}",
            "markdown": table["markdown"],
            "plain_text": table["plain_text"],
            "rows": table["rows"],
            "source_metadata": {"source": "markdown"},
        })
    return evidence[:80]


def extract_figure_evidence(parsed: dict[str, Any], document: dict[str, Any]) -> list[dict[str, Any]]:
    docling_json = parsed.get("docling_json") or {}
    farm_id = document["farm_id"]
    document_id = document["id"]
    evidence: list[dict[str, Any]] = []
    for figure in docling_collection(docling_json, ("pictures", "figures", "images")):
        caption = str(figure.get("caption") or text_from_value(figure, 800) or "")[:500] if isinstance(figure, dict) else ""
        evidence.append({
            "farm_id": farm_id,
            "document_id": document_id,
            "figure_index": len(evidence),
            "page_number": first_int(figure, ("page_no", "page_number", "page")),
            "label": str(figure.get("label") or figure.get("name") or f"Figure {len(evidence) + 1}")[:160] if isinstance(figure, dict) else f"Figure {len(evidence) + 1}",
            "caption": caption,
            "alt_text": caption,
            "figure_type": "docling_picture",
            "bounding_boxes": bounding_boxes_from_value(figure),
            "source_metadata": {"source": "docling"},
        })
    if str(document.get("content_type") or "").lower().startswith("image/"):
        details = (document.get("metadata") or {}).get("extracted_details") or {}
        evidence.append({
            "farm_id": farm_id,
            "document_id": document_id,
            "figure_index": len(evidence),
            "label": document.get("title") or document.get("filename") or "Uploaded image",
            "caption": document.get("notes") or details.get("notes") or "",
            "alt_text": details.get("notes") or "",
            "figure_type": "uploaded_image",
            "source_metadata": {"source": "upload", "content_type": document.get("content_type")},
        })
    return evidence[:80]


def chunk_text(text: str, target_chars: int = 1800, overlap_chars: int = 180) -> list[dict[str, Any]]:
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[dict[str, Any]] = []
    current = ""
    current_heading = None
    for paragraph in paragraphs:
        heading_match = re.match(r"^#{1,6}\s+(.+)$", paragraph)
        if heading_match:
            current_heading = heading_match.group(1).strip()[:180]
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= target_chars:
            current = candidate
            continue
        if current:
            chunks.append({"chunk_text": current, "section_heading": current_heading})
            current = current[-overlap_chars:] + "\n\n" + paragraph
        while len(current) > target_chars:
            chunks.append({"chunk_text": current[:target_chars], "section_heading": current_heading})
            current = current[target_chars - overlap_chars :]
    if current:
        chunks.append({"chunk_text": current, "section_heading": current_heading})
    for idx, chunk in enumerate(chunks):
        chunk["chunk_index"] = idx
        chunk["token_count"] = max(1, len(chunk["chunk_text"]) // 4)
        if "|" in chunk["chunk_text"] and re.search(r"\|\s*:?-{2,}:?\s*\|", chunk["chunk_text"]):
            chunk["table_reference"] = "markdown-table"
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
        try:
            self.supabase.table("document_tables").delete().eq("document_id", document_id).execute()
            self.supabase.table("document_figures").delete().eq("document_id", document_id).execute()
        except Exception:
            pass
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
        extracted_details = infer_document_details(
            parsed["text"],
            document,
            raw_bytes=raw,
            content_type=document.get("content_type") or "",
        )
        existing_metadata = document.get("metadata") or {}
        should_autofill = existing_metadata.get("auto_populate") is not False and not existing_metadata.get("user_edited_details")
        if should_autofill:
            detail_update: dict[str, Any] = {
                "metadata": {
                    **existing_metadata,
                    "parse_method": parsed["method"],
                    "extracted_details": extracted_details,
                    "document_date": extracted_details.get("document_date"),
                    "due_date": extracted_details.get("due_date"),
                    "issuer": extracted_details.get("issuer"),
                    "counterparty": extracted_details.get("counterparty"),
                    "invoice_number": extracted_details.get("invoice_number"),
                    "total_amount": extracted_details.get("total_amount"),
                    "vat_amount": extracted_details.get("vat_amount"),
                    "currency": extracted_details.get("currency"),
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
        try:
            self.supabase.table("document_tables").delete().eq("document_id", document_id).execute()
            self.supabase.table("document_figures").delete().eq("document_id", document_id).execute()
        except Exception:
            pass
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
                "section_heading": chunk.get("section_heading"),
                "table_reference": chunk.get("table_reference"),
                "source_metadata": {"storage_path": document["storage_path"]},
                "docling_metadata": {
                    "parse_method": parsed["method"],
                    "has_table": bool(chunk.get("table_reference")),
                },
            }
            result = self.supabase.table("document_chunks").insert(row).execute()
            inserted_chunks.append(result.data[0])

        table_rows = extract_table_evidence(parsed, farm_id, document_id)
        for table in table_rows:
            for chunk in inserted_chunks:
                needle = table.get("markdown") or table.get("plain_text") or ""
                if needle and needle[:80] in (chunk.get("chunk_text") or ""):
                    table["chunk_id"] = chunk["id"]
                    break
        if table_rows:
            try:
                self.supabase.table("document_tables").insert(table_rows).execute()
            except Exception as exc:
                print(f"Table evidence skipped for {document_id}: {exc}")

        figure_rows = extract_figure_evidence(parsed, document)
        if figure_rows:
            try:
                self.supabase.table("document_figures").insert(figure_rows).execute()
            except Exception as exc:
                print(f"Figure evidence skipped for {document_id}: {exc}")

        self.set_job_status(job, "chunked")
        self.set_document_status(
            document_id,
            "chunked",
            metadata={
                **(document.get("metadata") or {}),
                "parse_method": parsed["method"],
                "extracted_details": extracted_details,
                "table_count": len(table_rows),
                "figure_count": len(figure_rows),
                "chunk_count": len(inserted_chunks),
            },
        )

        all_entities = []
        for start in range(0, len(inserted_chunks), EMBEDDING_BATCH_SIZE):
            batch = inserted_chunks[start : start + EMBEDDING_BATCH_SIZE]
            embeddings = embed_texts([chunk["chunk_text"] for chunk in batch])
            embedding_rows = []
            for chunk, (model, dimensions, embedding, provider) in zip(batch, embeddings):
                embedding_rows.append({
                    "farm_id": farm_id,
                    "document_id": document_id,
                    "chunk_id": chunk["id"],
                    "embedding_model": model,
                    "embedding_dimensions": dimensions,
                    "embedding": embedding,
                    "metadata": {"provider": provider},
                })
                all_entities.extend(extract_entities(chunk, farm_id, document_id, chunk["id"]))
            if embedding_rows:
                self.supabase.table("document_chunk_embeddings").insert(embedding_rows).execute()
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

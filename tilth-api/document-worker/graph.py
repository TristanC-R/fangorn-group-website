import os
from typing import Iterable


class GraphLoader:
    def __init__(self):
        self.uri = os.getenv("NEO4J_URI", "").strip()
        self.username = os.getenv("NEO4J_USERNAME", os.getenv("NEO4J_USER", "neo4j")).strip()
        self.password = os.getenv("NEO4J_PASSWORD", "").strip()
        self._driver = None

    @property
    def enabled(self) -> bool:
        return bool(self.uri and self.username and self.password)

    def connect(self):
        if not self.enabled or self._driver:
            return self._driver
        from neo4j import GraphDatabase

        self._driver = GraphDatabase.driver(self.uri, auth=(self.username, self.password))
        self.ensure_constraints()
        return self._driver

    def close(self):
        if self._driver:
            self._driver.close()
            self._driver = None

    def ensure_constraints(self):
        driver = self.connect()
        if not driver:
            return
        statements = [
            "CREATE CONSTRAINT farm_id_unique IF NOT EXISTS FOR (f:Farm) REQUIRE f.farm_id IS UNIQUE",
            "CREATE CONSTRAINT document_farm_id_unique IF NOT EXISTS FOR (d:Document) REQUIRE (d.farm_id, d.document_id) IS UNIQUE",
            "CREATE CONSTRAINT chunk_farm_id_unique IF NOT EXISTS FOR (c:Chunk) REQUIRE (c.farm_id, c.chunk_id) IS UNIQUE",
            "CREATE CONSTRAINT entity_farm_id_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.farm_id, e.type, e.normalised_name) IS UNIQUE",
            "CREATE INDEX topic_farm_name IF NOT EXISTS FOR (t:Topic) ON (t.farm_id, t.normalised_name)",
        ]
        with driver.session() as session:
            for statement in statements:
                session.run(statement)

    def load_document(self, farm_id: str, document: dict, chunks: Iterable[dict], entities: Iterable[dict]):
        driver = self.connect()
        if not driver:
            return False
        chunks = list(chunks)
        entities = list(entities)
        with driver.session() as session:
            session.execute_write(self._load_tx, farm_id, document, chunks, entities)
        return True

    @staticmethod
    def _load_tx(tx, farm_id: str, document: dict, chunks: list[dict], entities: list[dict]):
        tx.run(
            """
            MERGE (f:Farm {farm_id: $farm_id})
            MERGE (d:Document {farm_id: $farm_id, document_id: $document_id})
            SET d.title = $title,
                d.original_filename = $filename,
                d.document_type = $category,
                d.file_type = $content_type,
                d.storage_path = $storage_path,
                d.created_at = $created_at
            MERGE (f)-[:OWNS {farm_id: $farm_id}]->(d)
            """,
            farm_id=farm_id,
            document_id=document["id"],
            title=document.get("title"),
            filename=document.get("filename"),
            category=document.get("category"),
            content_type=document.get("content_type"),
            storage_path=document.get("storage_path"),
            created_at=document.get("created_at"),
        )
        for chunk in chunks:
            tx.run(
                """
                MATCH (d:Document {farm_id: $farm_id, document_id: $document_id})
                MERGE (c:Chunk {farm_id: $farm_id, chunk_id: $chunk_id})
                SET c.document_id = $document_id,
                    c.chunk_index = $chunk_index,
                    c.text_preview = $text_preview,
                    c.page_number = $page_number,
                    c.section_heading = $section_heading
                MERGE (d)-[:HAS_CHUNK {farm_id: $farm_id}]->(c)
                """,
                farm_id=farm_id,
                document_id=document["id"],
                chunk_id=chunk["id"],
                chunk_index=chunk["chunk_index"],
                text_preview=(chunk.get("chunk_text") or "")[:500],
                page_number=chunk.get("page_number"),
                section_heading=chunk.get("section_heading"),
            )
        for entity in entities:
            tx.run(
                """
                MATCH (d:Document {farm_id: $farm_id, document_id: $document_id})
                OPTIONAL MATCH (c:Chunk {farm_id: $farm_id, chunk_id: $chunk_id})
                MERGE (e:Entity {
                  farm_id: $farm_id,
                  type: $entity_type,
                  normalised_name: $normalised_name
                })
                SET e.name = $entity_value
                MERGE (d)-[:MENTIONS {farm_id: $farm_id}]->(e)
                WITH c, e
                WHERE c IS NOT NULL
                MERGE (c)-[:MENTIONS {
                  farm_id: $farm_id,
                  confidence: $confidence,
                  extraction_method: $extraction_method
                }]->(e)
                """,
                farm_id=farm_id,
                document_id=document["id"],
                chunk_id=entity.get("chunk_id"),
                entity_type=entity["entity_type"],
                entity_value=entity["entity_value"],
                normalised_name=entity.get("normalised_value") or entity["entity_value"].lower(),
                confidence=entity.get("confidence"),
                extraction_method=entity.get("extraction_method") or "worker",
            )

    def delete_document(self, farm_id: str, document_id: str):
        driver = self.connect()
        if not driver:
            return False
        with driver.session() as session:
            session.run(
                """
                MATCH (d:Document {farm_id: $farm_id, document_id: $document_id})
                OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk {farm_id: $farm_id})
                DETACH DELETE c, d
                """,
                farm_id=farm_id,
                document_id=document_id,
            )
        return True

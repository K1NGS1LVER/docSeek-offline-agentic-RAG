import json
import os
import sqlite3
from contextlib import contextmanager
from typing import List, Optional, Dict, Any

@contextmanager
def get_db(db_path: str):
    """Context manager for database connections"""
    conn = sqlite3.connect(db_path)
    try:
        yield conn
    finally:
        conn.close()

def init_db(db_path: str):
    """Initialize SQLite database and run idempotent migrations."""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                metadata TEXT,
                source_file TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )
        # Migration: add source_file to pre-existing tables.
        cols = {row[1] for row in cursor.execute("PRAGMA table_info(documents)")}
        if "source_file" not in cols:
            cursor.execute("ALTER TABLE documents ADD COLUMN source_file TEXT")
        # Backfill any NULL source_file from the metadata JSON.
        rows = cursor.execute(
            "SELECT id, metadata FROM documents WHERE source_file IS NULL AND metadata IS NOT NULL"
        ).fetchall()
        for row_id, meta in rows:
            try:
                sf = json.loads(meta).get("source_file")
            except Exception:
                sf = None
            if sf:
                cursor.execute(
                    "UPDATE documents SET source_file = ? WHERE id = ?", (sf, row_id)
                )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_documents_source_file ON documents(source_file)"
        )
        # FTS5 full-text mirror of documents.content for BM25 keyword search.
        cursor.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
            USING fts5(content, content='documents', content_rowid='id')
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
            END
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
            END
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
                INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
            END
            """
        )
        # Backfill FTS for rows that predate the virtual table.
        cursor.execute("SELECT count(*) FROM documents_fts")
        if cursor.fetchone()[0] == 0:
            cursor.execute(
                "INSERT INTO documents_fts(rowid, content) SELECT id, content FROM documents"
            )
        conn.commit()
    print(f"Database initialized at {db_path}")

def insert_document(db_path: str, content: str, metadata: Optional[str] = None) -> int:
    """Insert document and return its ID. Extracts source_file from metadata."""
    source_file = None
    if metadata:
        try:
            source_file = json.loads(metadata).get("source_file")
        except Exception:
            source_file = None
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO documents (content, metadata, source_file) VALUES (?, ?, ?)",
            (content, metadata, source_file),
        )
        doc_id = cursor.lastrowid
        conn.commit()
    return doc_id

def insert_documents_batch(db_path: str, items: List[Dict[str, Any]]) -> List[int]:
    """Insert multiple documents in a single transaction and return their IDs.
    items should be dicts with 'content' and optional 'metadata'.
    """
    doc_ids = []
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        for item in items:
            content = item["content"]
            metadata = item.get("metadata")
            source_file = None
            if metadata:
                try:
                    source_file = json.loads(metadata).get("source_file")
                except Exception:
                    source_file = None
            cursor.execute(
                "INSERT INTO documents (content, metadata, source_file) VALUES (?, ?, ?)",
                (content, metadata, source_file),
            )
            doc_ids.append(cursor.lastrowid)
        conn.commit()
    return doc_ids

def fetch_documents_by_ids(db_path: str, doc_ids: List[int]) -> List[Dict[str, Any]]:
    """Fetch documents by their IDs"""
    if not doc_ids:
        return []

    with get_db(db_path) as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" * len(doc_ids))
        cursor.execute(
            f"SELECT id, content, metadata FROM documents WHERE id IN ({placeholders})",
            doc_ids,
        )
        rows = cursor.fetchall()

    return [{"id": row[0], "content": row[1], "metadata": row[2]} for row in rows]

def get_document_count(db_path: str) -> int:
    """Get total number of documents"""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM documents")
        return cursor.fetchone()[0]

def get_all_metadata(db_path: str) -> List[str]:
    """Get metadata for all documents to identify unique files"""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT metadata FROM documents WHERE metadata IS NOT NULL")
        rows = cursor.fetchall()
    return [row[0] for row in rows]

def fetch_document_by_id(db_path: str, doc_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a single document by its ID"""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, content, metadata FROM documents WHERE id = ?", (doc_id,))
        row = cursor.fetchone()
    if row is None:
        return None
    return {"id": row[0], "content": row[1], "metadata": row[2]}

def get_all_documents(db_path: str) -> List[Dict[str, Any]]:
    """Fetch all documents (for index rebuilding)"""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, content, metadata FROM documents")
        rows = cursor.fetchall()
    return [{"id": row[0], "content": row[1], "metadata": row[2]} for row in rows]

def fetch_chunks_by_source(db_path: str, source_file: str) -> List[Dict[str, Any]]:
    """Fetch all chunks sharing a source_file, via the indexed column."""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, content, metadata FROM documents WHERE source_file = ?",
            (source_file,),
        )
        rows = cursor.fetchall()
    return [{"id": row[0], "content": row[1], "metadata": row[2]} for row in rows]

def get_ids_for_sources(db_path: str, source_files: List[str]) -> List[int]:
    """All chunk ids belonging to the given sources.

    Sources may be addressed by full source_file value, its basename, or the
    metadata filename (they usually coincide; GitHub ingests differ)."""
    allowed = set(source_files)
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, source_file, metadata FROM documents WHERE source_file IS NOT NULL"
        )
        rows = cursor.fetchall()
    ids = []
    for doc_id, source_file, metadata in rows:
        names = {source_file, os.path.basename(source_file)}
        if metadata:
            try:
                filename = json.loads(metadata).get("filename")
                if filename:
                    names.add(filename)
            except Exception:
                pass
        if names & allowed:
            ids.append(doc_id)
    return ids

def list_sources(db_path: str) -> List[Dict[str, Any]]:
    """One row per source_file: chunk count, a representative chunk id, and a
    metadata sample (from the source's first chunk)."""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT source_file, COUNT(*), MIN(id),
                      (SELECT metadata FROM documents d2
                        WHERE d2.source_file = d.source_file AND d2.metadata IS NOT NULL
                        ORDER BY id LIMIT 1)
               FROM documents d
               WHERE source_file IS NOT NULL
               GROUP BY source_file"""
        )
        rows = cursor.fetchall()
    return [
        {"source_file": r[0], "chunks": r[1], "first_chunk_id": r[2], "metadata": r[3]}
        for r in rows
    ]

def delete_documents_by_source(db_path: str, source_file: str) -> List[int]:
    """Delete all chunks for a source_file. Returns the deleted ids."""
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        ids = [
            row[0]
            for row in cursor.execute(
                "SELECT id FROM documents WHERE source_file = ?", (source_file,)
            )
        ]
        if ids:
            cursor.execute(
                "DELETE FROM documents WHERE source_file = ?", (source_file,)
            )
            conn.commit()
    return ids

def keyword_search(db_path: str, query: str, k: int) -> List[int]:
    """BM25 keyword search over content via FTS5. Returns DB ids, best first."""
    if not query.strip():
        return []
    # Quote each token individually (not the whole query as one phrase) so
    # FTS5 ANDs independent terms together instead of requiring an exact
    # adjacent phrase match. Per-token quoting also escapes punctuation that
    # would otherwise break FTS5 query syntax.
    match = " ".join(
        '"' + token.replace('"', '""') + '"' for token in query.split() if token
    )
    with get_db(db_path) as conn:
        cursor = conn.cursor()
        try:
            rows = cursor.execute(
                "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? "
                "ORDER BY bm25(documents_fts) LIMIT ?",
                (match, k),
            ).fetchall()
        except Exception:
            return []
    return [row[0] for row in rows]

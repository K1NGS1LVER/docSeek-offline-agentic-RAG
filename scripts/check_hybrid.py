"""Keyword-only match (rare token) is retrievable via hybrid path."""
import json
from app.core import database
from app.core.engine import VectorEngine
from app.core.fusion import reciprocal_rank_fusion

def main():
    database.init_db()
    eng = VectorEngine()
    meta = json.dumps({"source_file": "hy_test.txt", "filename": "hy_test.txt",
                       "chunk_index": 0, "total_chunks": 1})
    doc_id = database.insert_document(
        "The error code XZ9271Q indicates a coolant pump failure.", meta
    )
    eng.add_to_index(eng.embed("The error code XZ9271Q indicates a coolant pump failure."),
                     doc_ids=[doc_id])

    # A rare token is exactly where dense retrieval is weakest and BM25 shines.
    kw = database.keyword_search("XZ9271Q", 5)
    assert doc_id in kw, f"keyword search missed exact token: {kw}"

    dense_ids = [int(i) for i in eng.search(eng.embed("XZ9271Q"), 5)[0] if i != -1]
    fused = reciprocal_rank_fusion([dense_ids, kw])
    assert doc_id in fused, f"fusion dropped the keyword hit: {fused}"

    database.delete_documents_by_source("hy_test.txt")
    eng.remove_ids([doc_id])
    print("OK: hybrid retrieves exact-token match dense search would miss")

if __name__ == "__main__":
    main()

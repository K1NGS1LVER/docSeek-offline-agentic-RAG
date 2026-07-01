"""Insert, index, delete, confirm gone from both DB and FAISS."""
import json
from app.core import database
from app.core.engine import VectorEngine

def main():
    database.init_db()
    eng = VectorEngine()
    before = eng.get_total_vectors()

    meta = json.dumps({"source_file": "del_test.txt", "filename": "del_test.txt",
                       "chunk_index": 0, "total_chunks": 1})
    doc_id = database.insert_document("delete me", meta)
    vec = eng.embed("delete me")
    eng.add_to_index(vec, doc_ids=[doc_id])
    assert eng.get_total_vectors() == before + 1

    ids = database.delete_documents_by_source("del_test.txt")
    removed = eng.remove_ids(ids)
    assert removed == 1, f"expected 1 removed, got {removed}"
    assert eng.get_total_vectors() == before, "vector count did not return to baseline"
    assert database.fetch_chunks_by_source("del_test.txt") == [], "DB rows remain"
    print("OK: delete removes rows from DB and vectors from index")

if __name__ == "__main__":
    main()

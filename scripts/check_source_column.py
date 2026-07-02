"""Verify migration backfills source_file and grouped fetch works."""
import json
from app.core import database

def main():
    database.init_db()
    meta = json.dumps({"source_file": "sc_test.txt", "filename": "sc_test.txt",
                       "chunk_index": 0, "total_chunks": 2})
    a = database.insert_document("chunk A", meta)
    meta2 = json.dumps({"source_file": "sc_test.txt", "filename": "sc_test.txt",
                        "chunk_index": 1, "total_chunks": 2})
    b = database.insert_document("chunk B", meta2)

    got = database.fetch_chunks_by_source("sc_test.txt")
    ids = {r["id"] for r in got}
    assert {a, b} <= ids, f"grouped fetch missing rows: {ids}"

    # Confirm the column (not a LIKE scan) is populated.
    with database.get_db() as conn:
        row = conn.execute(
            "SELECT source_file FROM documents WHERE id = ?", (a,)
        ).fetchone()
    assert row[0] == "sc_test.txt", f"source_file not populated: {row}"
    print("OK: source_file column populated and queryable")

    database.delete_documents_by_source("sc_test.txt")

if __name__ == "__main__":
    main()

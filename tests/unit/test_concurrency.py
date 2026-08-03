import threading
from app.core import notebooks
from app.server import get_runtime, ingest_document, IngestRequest

def test_concurrent_ingestion_across_notebooks():
    nb1 = notebooks.create_notebook("Notebook 1", "📓")
    nb2 = notebooks.create_notebook("Notebook 2", "📘")

    errors = []

    def ingest_nb1():
        try:
            for i in range(10):
                ingest_document(IngestRequest(text=f"Doc NB1 #{i}", notebook_id=nb1["id"]))
        except Exception as e:
            errors.append(e)

    def ingest_nb2():
        try:
            for i in range(10):
                ingest_document(IngestRequest(text=f"Doc NB2 #{i}", notebook_id=nb2["id"]))
        except Exception as e:
            errors.append(e)

    t1 = threading.Thread(target=ingest_nb1)
    t2 = threading.Thread(target=ingest_nb2)

    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert len(errors) == 0

    rt1 = get_runtime(nb1["id"])
    rt2 = get_runtime(nb2["id"])

    assert rt1.engine.get_total_vectors() == 10
    assert rt2.engine.get_total_vectors() == 10

    # Cleanup
    notebooks.delete_notebook(nb1["id"])
    notebooks.delete_notebook(nb2["id"])

"""Hammer the engine from many threads; must not crash or corrupt count."""
import threading
import numpy as np
from app.core.engine import VectorEngine

def main():
    eng = VectorEngine()
    start = eng.get_total_vectors()
    dim = eng.dimension
    errors = []

    def writer(base):
        try:
            for i in range(20):
                vec = np.random.rand(1, dim).astype("float32")
                eng.add_to_index(vec, doc_ids=[10_000_000 + base * 100 + i])
        except Exception as e:  # noqa
            errors.append(e)

    def reader():
        try:
            for _ in range(50):
                q = np.random.rand(1, dim).astype("float32")
                eng.search(q, 5)
        except Exception as e:  # noqa
            errors.append(e)

    threads = [threading.Thread(target=writer, args=(b,)) for b in range(4)]
    threads += [threading.Thread(target=reader) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"Concurrent access raised: {errors}"
    added = eng.get_total_vectors() - start
    assert added == 80, f"Expected 80 new vectors, got {added}"
    # Clean up the junk ids we added
    eng.remove_ids([10_000_000 + b * 100 + i for b in range(4) for i in range(20)])
    print("OK: engine lock holds under concurrent read/write")

if __name__ == "__main__":
    main()

import numpy as np
import pytest
from app.core.cache import InMemoryLRU, CacheClient, cache
from app.core.engine import VectorEngine
from app.core import database


def test_in_memory_lru_basic():
    lru = InMemoryLRU(maxsize=3)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.set("c", 3)

    assert lru.get("a") == 1
    assert lru.get("b") == 2
    assert lru.get("c") == 3
    assert lru.get("d") is None

    # Adding "d" should evict least recently used ("a" was accessed, then "b", then "c", so "a" was accessed earliest before b and c)
    # Access order: a accessed, b accessed, c accessed. Evict "a" if we touch b and c.
    lru.get("b")
    lru.get("c")
    lru.set("d", 4)
    assert lru.get("a") is None
    assert lru.get("b") == 2
    assert lru.get("d") == 4


def test_cache_client_embedding_single():
    client = CacheClient()
    client.clear()
    text = "Machine learning models require data."
    model = "test-model"
    dim = 768

    # Generate dummy vector
    vec = np.random.randn(1, dim).astype(np.float32)

    # Initially miss
    assert client.get_embedding(text, model, dim=dim) is None

    # Set embedding
    client.set_embedding(text, model, vec)

    # Now hit
    cached = client.get_embedding(text, model, dim=dim)
    assert cached is not None
    assert cached.shape == (1, dim)
    assert np.allclose(vec, cached, atol=1e-6)


def test_cache_client_embedding_batch():
    client = CacheClient()
    client.clear()
    model = "test-model"
    dim = 768

    texts = ["apple", "banana", "cherry"]
    vecs = [np.random.randn(1, dim).astype(np.float32) for _ in texts]

    # Pre-seed one item in cache
    client.set_embedding(texts[1], model, vecs[1])

    # Lookup batch
    hits, misses = client.get_embeddings_batch(texts, model, dim=dim)
    assert 1 in hits
    assert np.allclose(hits[1], vecs[1], atol=1e-6)
    assert set(misses) == {0, 2}

    # Store misses
    client.set_embeddings_batch([(texts[0], vecs[0]), (texts[2], vecs[2])], model)

    # Now all should hit
    all_hits, all_misses = client.get_embeddings_batch(texts, model, dim=dim)
    assert len(all_misses) == 0
    assert len(all_hits) == 3


def test_cache_client_json():
    client = CacheClient()
    key = "unit-test-key"
    data = {"questions": ["q1", "q2"]}

    client.set_json(key, data, ttl=60)
    retrieved = client.get_json(key)
    assert retrieved == data


def test_sqlite_wal_pragmas(tmp_path):
    db_file = str(tmp_path / "test_wal.db")
    database.init_db(db_file)

    with database.get_db(db_file) as conn:
        cursor = conn.cursor()
        mode = cursor.execute("PRAGMA journal_mode;").fetchone()[0]
        sync = cursor.execute("PRAGMA synchronous;").fetchone()[0]
        mmap = cursor.execute("PRAGMA mmap_size;").fetchone()[0]
        timeout = cursor.execute("PRAGMA busy_timeout;").fetchone()[0]

        assert mode.lower() == "wal"
        # NORMAL synchronous is represented by integer 1
        assert sync in (1, "NORMAL", "normal")
        assert mmap >= 268435456
        assert timeout >= 10000

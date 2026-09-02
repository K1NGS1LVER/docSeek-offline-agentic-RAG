"""
High-performance caching layer for docSeek.

Provides:
1. Valkey (Redis-compatible) cache client with sub-millisecond retrieval.
2. Graceful, automatic fallback to an in-memory thread-safe LRU cache if Valkey is unavailable.
3. Fast binary serialization for float32 NumPy embedding vectors.
4. Response and suggestion caching.
"""

import collections
import hashlib
import json
import logging
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import redis
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False

logger = logging.getLogger(__name__)

VALKEY_URL = os.environ.get("DOCSEEK_VALKEY_URL", "redis://localhost:6379/0")
EMBEDDING_CACHE_TTL = int(os.environ.get("DOCSEEK_EMBED_CACHE_TTL", str(7 * 24 * 3600)))  # 7 days
MAX_IN_MEMORY_ITEMS = int(os.environ.get("DOCSEEK_LRU_MAX_ITEMS", "2000"))


class InMemoryLRU:
    """Thread-safe in-memory LRU cache with item count eviction."""

    def __init__(self, maxsize: int = MAX_IN_MEMORY_ITEMS):
        self.maxsize = maxsize
        self._cache: collections.OrderedDict = collections.OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def set(self, key: str, value: Any):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.maxsize:
                self._cache.popitem(last=False)

    def delete(self, key: str):
        with self._lock:
            self._cache.pop(key, None)

    def clear(self):
        with self._lock:
            self._cache.clear()


class CacheClient:
    """Unified cache interface with Valkey backend and in-memory LRU fallback."""

    def __init__(self, url: str = VALKEY_URL):
        self.url = url
        self.valkey_client: Optional[Any] = None
        self.lru = InMemoryLRU(MAX_IN_MEMORY_ITEMS)
        self._is_valkey_available = False
        self._last_probe = 0.0
        self._probe_interval = 30.0  # seconds between reconnection attempts if offline

        self._init_valkey()

    def _init_valkey(self):
        if not HAS_REDIS:
            self._is_valkey_available = False
            return

        try:
            client = redis.from_url(
                self.url,
                socket_timeout=0.4,
                socket_connect_timeout=0.4,
                decode_responses=False,
            )
            client.ping()
            self.valkey_client = client
            self._is_valkey_available = True
            logger.info("Valkey cache connected successfully.")
        except Exception as e:
            self._is_valkey_available = False
            self.valkey_client = None
            logger.debug(f"Valkey not available ({e}). Using in-memory LRU fallback.")

    @property
    def is_valkey_active(self) -> bool:
        return self._is_valkey_available

    def _hash_key(self, prefix: str, model_name: str, text: str) -> str:
        h = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return f"ds:{prefix}:{model_name}:{h}"

    def get_embedding(self, text: str, model_name: str, dim: int = 768) -> Optional[np.ndarray]:
        """Fetch cached normalized embedding vector. Returns shape (1, dim)."""
        key = self._hash_key("embed", model_name, text)

        # 1. Try Valkey if available
        if self._is_valkey_available and self.valkey_client:
            try:
                raw = self.valkey_client.get(key)
                if raw is not None:
                    vec = np.frombuffer(raw, dtype=np.float32).reshape(1, -1)
                    if vec.shape[1] == dim:
                        return vec
            except Exception:
                self._is_valkey_available = False

        # 2. Fallback to in-memory LRU
        vec = self.lru.get(key)
        if vec is not None and isinstance(vec, np.ndarray) and vec.shape[1] == dim:
            return vec

        return None

    def set_embedding(self, text: str, model_name: str, vector: np.ndarray, ttl: int = EMBEDDING_CACHE_TTL):
        """Store normalized embedding vector in cache."""
        key = self._hash_key("embed", model_name, text)
        vec_32 = vector.astype(np.float32)

        # 1. Store in in-memory LRU
        self.lru.set(key, vec_32)

        # 2. Store in Valkey if available
        if self._is_valkey_available and self.valkey_client:
            try:
                self.valkey_client.set(key, vec_32.tobytes(), ex=ttl)
            except Exception:
                self._is_valkey_available = False

    def get_embeddings_batch(
        self, texts: List[str], model_name: str, dim: int = 768
    ) -> Tuple[Dict[int, np.ndarray], List[int]]:
        """Batch lookup for embeddings.
        Returns:
            hits: dict mapping index in `texts` -> np.ndarray (1, dim)
            miss_indices: list of indices that were NOT in cache
        """
        hits: Dict[int, np.ndarray] = {}
        miss_indices: List[int] = []

        if not texts:
            return hits, miss_indices

        keys = [self._hash_key("embed", model_name, t) for t in texts]

        # 1. Try Valkey pipeline if available
        if self._is_valkey_available and self.valkey_client:
            try:
                pipe = self.valkey_client.pipeline(transaction=False)
                for k in keys:
                    pipe.get(k)
                results = pipe.execute()

                for idx, raw in enumerate(results):
                    if raw is not None:
                        vec = np.frombuffer(raw, dtype=np.float32).reshape(1, -1)
                        if vec.shape[1] == dim:
                            hits[idx] = vec
            except Exception:
                self._is_valkey_available = False

        # 2. For remaining misses, check in-memory LRU
        for idx in range(len(texts)):
            if idx not in hits:
                vec = self.lru.get(keys[idx])
                if vec is not None and isinstance(vec, np.ndarray) and vec.shape[1] == dim:
                    hits[idx] = vec
                else:
                    miss_indices.append(idx)

        return hits, miss_indices

    def set_embeddings_batch(
        self,
        indexed_vectors: List[Tuple[str, np.ndarray]],
        model_name: str,
        ttl: int = EMBEDDING_CACHE_TTL,
    ):
        """Batch save computed embeddings into both LRU and Valkey."""
        if not indexed_vectors:
            return

        pipeline_items = []
        for text, vector in indexed_vectors:
            key = self._hash_key("embed", model_name, text)
            vec_32 = vector.astype(np.float32)
            self.lru.set(key, vec_32)
            pipeline_items.append((key, vec_32.tobytes()))

        if self._is_valkey_available and self.valkey_client:
            try:
                pipe = self.valkey_client.pipeline(transaction=False)
                for key, raw_bytes in pipeline_items:
                    pipe.set(key, raw_bytes, ex=ttl)
                pipe.execute()
            except Exception:
                self._is_valkey_available = False

    def get_json(self, key: str) -> Optional[Any]:
        """Fetch cached JSON structure."""
        full_key = f"ds:json:{key}"
        if self._is_valkey_available and self.valkey_client:
            try:
                raw = self.valkey_client.get(full_key)
                if raw is not None:
                    return json.loads(raw.decode("utf-8"))
            except Exception:
                self._is_valkey_available = False

        cached = self.lru.get(full_key)
        if cached is not None:
            return cached
        return None

    def set_json(self, key: str, value: Any, ttl: int = 600):
        """Store JSON structure in cache."""
        full_key = f"ds:json:{key}"
        self.lru.set(full_key, value)
        if self._is_valkey_available and self.valkey_client:
            try:
                self.valkey_client.set(full_key, json.dumps(value).encode("utf-8"), ex=ttl)
            except Exception:
                self._is_valkey_available = False

    def clear(self) -> Dict[str, Any]:
        """Flush cache entries from both Valkey and in-memory LRU."""
        cleared_valkey = 0
        self.lru.clear()

        if self._is_valkey_available and self.valkey_client:
            try:
                cursor = 0
                keys = []
                while True:
                    cursor, match_keys = self.valkey_client.scan(cursor, match="ds:*", count=500)
                    keys.extend(match_keys)
                    if cursor == 0:
                        break
                if keys:
                    cleared_valkey = self.valkey_client.delete(*keys)
            except Exception as e:
                logger.warning(f"Failed to flush Valkey keys: {e}")

        return {
            "status": "ok",
            "valkey_cleared": cleared_valkey,
            "lru_cleared": True,
        }


# Global singleton instance
cache = CacheClient()

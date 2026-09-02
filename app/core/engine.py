import os
import gc
import logging
import threading
from typing import Dict, List
import faiss
import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from .config import MODEL_NAME, EMBEDDING_DIM, MAX_EMBED_BATCH_SIZE
from .cache import cache

logger = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()


def get_shared_model() -> SentenceTransformer:
    """The embedding model is identical across notebooks; load it once."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                logger.info(f"Loading model: {MODEL_NAME}...")
                # ponytail: pass trust_remote_code=True for Nomic architecture support in sentence-transformers
                try:
                    _model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
                except Exception:
                    _model = SentenceTransformer(MODEL_NAME)
    return _model


class VectorEngine:
    """Manages one notebook's FAISS index (embeddings via the shared model)."""

    def __init__(self, index_path: str):
        self.model = get_shared_model()
        self.dimension = EMBEDDING_DIM
        self.index_path = index_path

        # Load existing index or create new one
        if os.path.exists(self.index_path):
            logger.info(f"Loading existing FAISS index from {self.index_path}")
            try:
                loaded_index = faiss.read_index(self.index_path)

                # Ensure the loaded index supports add_with_ids.
                # Only IndexIDMap and IndexIDMap2 actually support it — the base
                # class has the method signature but raises at runtime.
                if isinstance(loaded_index, (faiss.IndexIDMap, faiss.IndexIDMap2)) and loaded_index.d == self.dimension:
                    self.index = loaded_index
                    logger.info(f"Index loaded OK ({self.index.ntotal} vectors, type: {type(loaded_index).__name__})")
                else:
                    logger.warning(
                        f"Loaded index dimension mismatch or type incompatibility ({getattr(loaded_index, 'd', 'unknown')} vs {self.dimension}). "
                        f"Creating a fresh IndexIDMap. Run POST /rebuild to re-index."
                    )
                    base_index = faiss.IndexFlatIP(self.dimension)
                    self.index = faiss.IndexIDMap(base_index)
            except Exception as e:
                logger.error(f"Failed to load FAISS index: {e}. Creating fresh index.")
                base_index = faiss.IndexFlatIP(self.dimension)
                self.index = faiss.IndexIDMap(base_index)
        else:
            logger.info("Creating new FAISS index (IndexIDMap + IndexFlatIP for cosine similarity)")
            base_index = faiss.IndexFlatIP(self.dimension)
            self.index = faiss.IndexIDMap(base_index)

        # Guards all index mutate/search/save. Reentrant so save() can be
        # called from inside a locked add. FAISS index objects are not
        # thread-safe and the GitHub ingest worker runs in a daemon thread.
        self._lock = threading.RLock()

    def embed(self, text: str) -> np.ndarray:
        """Generate normalized embedding for text under torch.inference_mode with caching."""
        cached = cache.get_embedding(text, MODEL_NAME, self.dimension)
        if cached is not None:
            return cached

        try:
            # ponytail: add search_document: prefix if using Nomic v1.5 models for optimal vector retrieval accuracy
            prepended = f"search_document: {text}" if "nomic" in MODEL_NAME.lower() else text
            with torch.inference_mode(), _model_lock:
                embedding = self.model.encode(prepended, convert_to_numpy=True)
            embedding = embedding.reshape(1, -1).astype("float32")
            faiss.normalize_L2(embedding)
            cache.set_embedding(text, MODEL_NAME, embedding)
            return embedding
        except Exception as e:
            logger.error(f"Embedding failed for text ({len(text)} chars): {e}")
            raise

    def embed_batch(self, texts: list) -> np.ndarray:
        """Generate normalized embeddings for multiple texts under torch.inference_mode with batch caching."""
        if not texts:
            return np.array([])

        hits, miss_indices = cache.get_embeddings_batch(texts, MODEL_NAME, self.dimension)
        if not miss_indices:
            # All items were cached!
            return np.vstack([hits[i] for i in range(len(texts))])

        try:
            missing_texts = [texts[i] for i in miss_indices]
            # ponytail: add search_document: prefix batch-wide for Nomic v1.5 embedding models
            prepended = [f"search_document: {t}" if "nomic" in MODEL_NAME.lower() else t for t in missing_texts]

            with torch.inference_mode(), _model_lock:
                if len(prepended) <= MAX_EMBED_BATCH_SIZE:
                    computed = self.model.encode(prepended, convert_to_numpy=True, show_progress_bar=False)
                    computed = computed.astype("float32")
                else:
                    batches = []
                    for i in range(0, len(prepended), MAX_EMBED_BATCH_SIZE):
                        batch = prepended[i:i + MAX_EMBED_BATCH_SIZE]
                        b_emb = self.model.encode(batch, convert_to_numpy=True, show_progress_bar=False)
                        batches.append(b_emb.astype("float32"))
                    computed = np.vstack(batches)

            faiss.normalize_L2(computed)

            # Store new embeddings in cache
            new_cache_items = []
            for idx_in_missing, original_idx in enumerate(miss_indices):
                vec = computed[idx_in_missing].reshape(1, -1)
                hits[original_idx] = vec
                new_cache_items.append((texts[original_idx], vec))

            cache.set_embeddings_batch(new_cache_items, MODEL_NAME)

            # Assemble full result in original order
            return np.vstack([hits[i] for i in range(len(texts))])
        except Exception as e:
            logger.error(f"Batch embedding failed for {len(texts)} texts: {e}")
            raise

    def add_to_index(self, vectors: np.ndarray, doc_ids: list = None):
        """Add vectors to FAISS index with explicit document IDs"""
        try:
            if vectors.ndim == 1:
                vectors = vectors.reshape(1, -1)

            vectors = vectors.astype("float32")

            with self._lock:
                if doc_ids is not None:
                    ids = np.array(doc_ids, dtype=np.int64)
                else:
                    start_id = self.index.ntotal + 1
                    ids = np.arange(start_id, start_id + vectors.shape[0], dtype=np.int64)

                self.index.add_with_ids(vectors, ids)
        except Exception as e:
            logger.error(f"Failed to add {vectors.shape[0]} vectors to index: {e}")
            raise

    def search(self, query_vector: np.ndarray, k: int = 5, allowed_ids=None):
        """Search for top-k nearest neighbors. Returns (doc_ids, scores).

        allowed_ids optionally restricts the search to those DB ids via a
        FAISS IDSelector (applied to the mapped ids of the IndexIDMap), so
        scoped retrieval never loses candidates to post-filtering."""
        try:
            query_vector = query_vector.astype("float32")
            with self._lock:
                actual_k = min(k, self.index.ntotal) if self.index.ntotal > 0 else 0
                if actual_k == 0:
                    return np.array([]), np.array([])
                if allowed_ids is not None:
                    sel = faiss.IDSelectorBatch(
                        np.asarray(sorted(allowed_ids), dtype=np.int64)
                    )
                    params = faiss.SearchParameters(sel=sel)
                    distances, indices = self.index.search(
                        query_vector, actual_k, params=params
                    )
                else:
                    distances, indices = self.index.search(query_vector, actual_k)
            return indices[0], distances[0]
        except Exception as e:
            logger.error(f"Search failed (k={k}): {e}")
            return np.array([]), np.array([])

    def save(self):
        """Persist index to disk"""
        try:
            with self._lock:
                faiss.write_index(self.index, self.index_path)
            logger.info(f"Index saved to {self.index_path}")
        except Exception as e:
            logger.error(f"Failed to save index: {e}")

    def get_total_vectors(self) -> int:
        """Get count of vectors in index"""
        with self._lock:
            return self.index.ntotal

    def remove_ids(self, doc_ids: list) -> int:
        """Remove vectors by their DB ids. Returns count removed."""
        if not doc_ids:
            return 0
        ids = np.array(doc_ids, dtype=np.int64)
        with self._lock:
            removed = self.index.remove_ids(ids)
        return int(removed)

    def get_embeddings_map(self) -> Dict[int, List[float]]:
        """Reconstruct vector embeddings map for all chunk IDs stored in FAISS."""
        result = {}
        with self._lock:
            if self.index.ntotal == 0:
                return result
            try:
                if hasattr(self.index, "id_map"):
                    ids = faiss.vector_to_array(self.index.id_map)
                    base_index = getattr(self.index, "index", self.index)
                    for i, doc_id in enumerate(ids):
                        doc_id_int = int(doc_id)
                        try:
                            vec = base_index.reconstruct(i)
                            result[doc_id_int] = vec.tolist()
                        except Exception:
                            try:
                                vec = self.index.reconstruct(doc_id_int)
                                result[doc_id_int] = vec.tolist()
                            except Exception:
                                pass
                else:
                    for i in range(self.index.ntotal):
                        try:
                            vec = self.index.reconstruct(i)
                            result[i] = vec.tolist()
                        except Exception:
                            pass
            except Exception as e:
                logger.warning(f"Could not reconstruct vectors from FAISS: {e}")
        return result


def clear_model_memory():
    """Reclaim PyTorch allocator caches and run Python garbage collection."""
    gc.collect()
    try:
        if hasattr(torch, "mps") and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif hasattr(torch, "cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass



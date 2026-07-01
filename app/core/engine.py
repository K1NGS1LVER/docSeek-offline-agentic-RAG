import os
import logging
import threading
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer
from .config import MODEL_NAME, EMBEDDING_DIM, INDEX_PATH

logger = logging.getLogger(__name__)


class VectorEngine:
    """Manages embeddings and FAISS index with explicit ID mapping"""

    def __init__(self):
        logger.info(f"Loading model: {MODEL_NAME}...")
        try:
            self.model = SentenceTransformer(MODEL_NAME)
        except Exception as e:
            logger.error(f"Failed to load embedding model '{MODEL_NAME}': {e}")
            raise

        self.dimension = EMBEDDING_DIM
        self.index_path = INDEX_PATH

        # Load existing index or create new one
        if os.path.exists(self.index_path):
            logger.info(f"Loading existing FAISS index from {self.index_path}")
            try:
                loaded_index = faiss.read_index(self.index_path)

                # Ensure the loaded index supports add_with_ids.
                # Only IndexIDMap and IndexIDMap2 actually support it — the base
                # class has the method signature but raises at runtime.
                if isinstance(loaded_index, (faiss.IndexIDMap, faiss.IndexIDMap2)):
                    self.index = loaded_index
                    logger.info(f"Index loaded OK ({self.index.ntotal} vectors, type: {type(loaded_index).__name__})")
                else:
                    logger.warning(
                        f"Loaded index is {type(loaded_index).__name__} "
                        f"which doesn't support add_with_ids. "
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
        """Generate normalized embedding for text"""
        try:
            embedding = self.model.encode(text, convert_to_numpy=True)
            embedding = embedding.reshape(1, -1).astype("float32")
            faiss.normalize_L2(embedding)
            return embedding
        except Exception as e:
            logger.error(f"Embedding failed for text ({len(text)} chars): {e}")
            raise
    
    def embed_batch(self, texts: list) -> np.ndarray:
        """Generate normalized embeddings for multiple texts at once (MUCH faster)"""
        if not texts:
            return np.array([])
        
        try:
            embeddings = self.model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
            embeddings = embeddings.astype("float32")
            faiss.normalize_L2(embeddings)
            return embeddings
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

    def search(self, query_vector: np.ndarray, k: int = 5):
        """Search for top-k nearest neighbors. Returns (doc_ids, scores)."""
        try:
            query_vector = query_vector.astype("float32")
            with self._lock:
                actual_k = min(k, self.index.ntotal) if self.index.ntotal > 0 else 0
                if actual_k == 0:
                    return np.array([]), np.array([])
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

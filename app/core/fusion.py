"""Reciprocal Rank Fusion for combining ranked result lists."""
from typing import List


def reciprocal_rank_fusion(rankings: List[List[int]], k: int = 60) -> List[int]:
    """Fuse multiple ranked id lists into one, best-first.

    RRF score for an id = sum over lists of 1 / (k + rank), rank starting at 1.
    k dampens the influence of low-ranked items; 60 is the standard default.
    """
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores, key=lambda d: scores[d], reverse=True)


if __name__ == "__main__":
    # Self-check: an id ranked high in both lists must win.
    dense = [1, 2, 3]
    keyword = [3, 4, 1]
    fused = reciprocal_rank_fusion([dense, keyword])
    assert fused[0] in (1, 3), fused
    assert set(fused) == {1, 2, 3, 4}, fused
    assert reciprocal_rank_fusion([]) == []
    print("OK: RRF fuses and ranks correctly")

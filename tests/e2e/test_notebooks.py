"""
End-to-end tests for notebook lifecycle, retrieval isolation between
notebooks, and migration of a legacy (pre-notebooks) flat data layout into a
default notebook on first boot.
"""

import requests

TIMEOUT = (10, 60)


def test_notebook_crud(server):
    created = requests.post(
        f"{server}/notebooks", json={"name": "CRUD", "emoji": "📗"}, timeout=TIMEOUT
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert set(body) >= {"id", "name", "emoji", "created_at"}
    assert body["name"] == "CRUD"
    assert body["emoji"] == "📗"
    nb_id = body["id"]

    listed = requests.get(f"{server}/notebooks", timeout=TIMEOUT).json()
    assert any(n["id"] == nb_id for n in listed)

    renamed = requests.patch(
        f"{server}/notebooks/{nb_id}",
        json={"name": "Renamed", "emoji": "📘"},
        timeout=TIMEOUT,
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["emoji"] == "📘"

    after_rename = requests.get(f"{server}/notebooks", timeout=TIMEOUT).json()
    match = next(n for n in after_rename if n["id"] == nb_id)
    assert match["name"] == "Renamed"
    assert match["emoji"] == "📘"

    deleted = requests.delete(f"{server}/notebooks/{nb_id}", timeout=TIMEOUT)
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}

    after_delete = requests.get(f"{server}/notebooks", timeout=TIMEOUT).json()
    assert not any(n["id"] == nb_id for n in after_delete)

    # Unknown id: PATCH and DELETE both 404.
    assert requests.patch(
        f"{server}/notebooks/nb_nope", json={"name": "x", "emoji": "x"}, timeout=TIMEOUT
    ).status_code == 404
    assert requests.delete(f"{server}/notebooks/nb_nope", timeout=TIMEOUT).status_code == 404


def test_notebook_isolation(server):
    a = requests.post(f"{server}/notebooks", json={"name": "A"}, timeout=TIMEOUT).json()["id"]
    b = requests.post(f"{server}/notebooks", json={"name": "B"}, timeout=TIMEOUT).json()["id"]

    ingested = requests.post(
        f"{server}/ingest",
        json={"text": "alpha secret zebra", "notebook_id": a},
        timeout=TIMEOUT,
    )
    assert ingested.status_code == 200, ingested.text

    ra = requests.post(
        f"{server}/search", json={"query": "zebra", "k": 5, "notebook_id": a}, timeout=TIMEOUT
    )
    rb = requests.post(
        f"{server}/search", json={"query": "zebra", "k": 5, "notebook_id": b}, timeout=TIMEOUT
    )
    assert ra.status_code == 200 and rb.status_code == 200
    assert len(ra.json()) >= 1
    assert len(rb.json()) == 0

    unknown = requests.post(
        f"{server}/search",
        json={"query": "x", "k": 5, "notebook_id": "nb_nope"},
        timeout=TIMEOUT,
    )
    assert unknown.status_code == 404


def test_migration_creates_default_notebook(legacy_server):
    notebooks = requests.get(f"{legacy_server}/notebooks", timeout=TIMEOUT).json()
    assert len(notebooks) == 1
    assert notebooks[0]["name"] == "My Notebook"
    nb_id = notebooks[0]["id"]

    hits = requests.post(
        f"{legacy_server}/search",
        json={"query": "zebra", "k": 5, "notebook_id": nb_id},
        timeout=TIMEOUT,
    )
    assert hits.status_code == 200, hits.text
    results = hits.json()
    assert len(results) >= 1
    assert any(
        "zebra" in r["content"].lower() or "legacy" in r["content"].lower() for r in results
    )

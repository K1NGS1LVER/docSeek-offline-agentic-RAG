import requests


def test_web_research_health(server):
    resp = requests.get(f"{server}/web-research/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "available" in data
    assert "searxng_url" in data


def test_web_research_extract(server):
    resp = requests.post(f"{server}/web-research/extract?url=https://example.com")
    assert resp.status_code == 200
    data = resp.json()
    assert "url" in data
    assert "content" in data
    assert "method" in data


def test_web_research_save_report_and_retrieval(server, notebook):
    nb_id = notebook

    report_markdown = (
        "# Research Report: Quantum Computing Advances\n\n"
        "Quantum superposition allows qubits to hold multiple states simultaneously. "
        "Topological quantum computers promise fault-tolerant computation via anyons."
    )

    resp = requests.post(
        f"{server}/web-research/save-report",
        json={
            "notebook_id": nb_id,
            "query": "Quantum Computing Advances",
            "report_markdown": report_markdown,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "saved"
    assert data["chunks"] > 0
    assert "Research: Quantum Computing Advances" in data["source_name"]

    # Verify that the report appears in /sources
    sources_resp = requests.get(f"{server}/sources?notebook_id={nb_id}")
    assert sources_resp.status_code == 200
    sources = sources_resp.json()
    source_names = [s["filename"] for s in sources]
    assert any("Quantum Computing Advances" in name for name in source_names)

    # Verify search retrieves information from the saved report
    search_resp = requests.post(
        f"{server}/search",
        json={
            "notebook_id": nb_id,
            "query": "topological anyons fault-tolerant",
            "k": 3,
        },
    )
    assert search_resp.status_code == 200
    results = search_resp.json()
    assert isinstance(results, list)
    assert len(results) > 0
    assert any("topological" in r["content"].lower() or "quantum" in r["content"].lower() for r in results)

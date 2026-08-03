import pytest
from fastapi.testclient import TestClient
from app.server import app
from app.core import notebooks

client = TestClient(app)


def test_get_graph_data_endpoint():
    response = client.get("/graph/data?min_similarity=0.3")
    assert response.status_code == 200
    data = response.json()
    assert "nodes" in data
    assert "edges" in data
    assert "stats" in data
    assert isinstance(data["nodes"], list)
    assert isinstance(data["edges"], list)
    assert "total_documents" in data["stats"]
    assert "total_edges" in data["stats"]


def test_get_graph_data_with_notebook():
    nb = notebooks.create_notebook("Graph Test Notebook", "📊")
    nb_id = nb["id"]

    response = client.get(f"/graph/data?notebook_id={nb_id}&min_similarity=0.5")
    assert response.status_code == 200
    data = response.json()
    assert "nodes" in data
    assert "edges" in data
    assert "stats" in data


def test_get_graph_data_invalid_notebook():
    response = client.get("/graph/data?notebook_id=non_existent_notebook_id")
    assert response.status_code == 404


def test_get_graph_data_similarity_validation():
    response_invalid_high = client.get("/graph/data?min_similarity=1.5")
    assert response_invalid_high.status_code == 422

    response_invalid_low = client.get("/graph/data?min_similarity=-0.5")
    assert response_invalid_low.status_code == 422

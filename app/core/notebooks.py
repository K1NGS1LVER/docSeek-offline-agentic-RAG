import json
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from .config import NOTEBOOKS_REGISTRY, notebook_dir, db_path
from . import database

_lock = threading.RLock()


def _read() -> List[Dict[str, Any]]:
    if not os.path.exists(NOTEBOOKS_REGISTRY):
        return []
    try:
        with open(NOTEBOOKS_REGISTRY, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write(rows: List[Dict[str, Any]]) -> None:
    tmp = str(NOTEBOOKS_REGISTRY) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    os.replace(tmp, NOTEBOOKS_REGISTRY)


def _new_id() -> str:
    return "nb_" + uuid.uuid4().hex[:8]


def list_notebooks() -> List[Dict[str, Any]]:
    with _lock:
        rows = _read()
    return sorted(rows, key=lambda r: r.get("created_at", ""), reverse=True)


def get_notebook(nb_id: str) -> Optional[Dict[str, Any]]:
    with _lock:
        for r in _read():
            if r["id"] == nb_id:
                return r
    return None


def create_notebook(name: str, emoji: str = "📓", nb_id: Optional[str] = None) -> Dict[str, Any]:
    with _lock:
        rows = _read()
        ids = {r["id"] for r in rows}
        the_id = nb_id or _new_id()
        while the_id in ids:
            the_id = _new_id()
        record = {
            "id": the_id,
            "name": (name or "Untitled notebook").strip(),
            "emoji": emoji or "📓",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        # Materialize the notebook's directory + empty DB (idempotent).
        notebook_dir(the_id)
        database.init_db(db_path(the_id))
        rows.append(record)
        _write(rows)
    return record


def rename_notebook(nb_id: str, name: str, emoji: str) -> Optional[Dict[str, Any]]:
    with _lock:
        rows = _read()
        for r in rows:
            if r["id"] == nb_id:
                r["name"] = (name or r["name"]).strip()
                r["emoji"] = emoji or r["emoji"]
                _write(rows)
                return r
    return None


def delete_notebook(nb_id: str) -> bool:
    with _lock:
        rows = _read()
        kept = [r for r in rows if r["id"] != nb_id]
        if len(kept) == len(rows):
            return False
        _write(kept)
    shutil.rmtree(notebook_dir(nb_id), ignore_errors=True)
    return True

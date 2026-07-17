import os
import shutil
import logging

from .config import DATA_DIR, NOTEBOOKS_DIR, notebook_dir
from . import notebooks

logger = logging.getLogger(__name__)


def migrate_legacy_layout() -> None:
    """One-time move of the pre-notebooks flat layout into a default notebook.

    Legacy layout: data/docs.db + data/my_index.faiss (+ data/uploads, data/audio).
    Runs only when a legacy docs.db exists and no notebooks have been created yet.
    """
    legacy_db = DATA_DIR / "docs.db"
    already_migrated = NOTEBOOKS_DIR.exists() and any(NOTEBOOKS_DIR.iterdir())
    if already_migrated or not legacy_db.exists():
        return

    logger.info("Migrating legacy flat corpus into a default notebook...")
    record = notebooks.create_notebook("My Notebook", "📓")
    dest = notebook_dir(record["id"])

    def _move(name: str):
        src = DATA_DIR / name
        if src.exists():
            target = dest / name
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    os.remove(target)
            shutil.move(str(src), str(target))

    # create_notebook already made an empty docs.db in dest; replace it.
    empty = dest / "docs.db"
    if empty.exists():
        os.remove(empty)
    _move("docs.db")
    _move("my_index.faiss")
    _move("uploads")
    _move("audio")
    logger.info(f"Legacy corpus migrated into notebook {record['id']}.")

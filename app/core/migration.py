import os
import shutil
import logging

from .config import DATA_DIR, notebook_dir
from . import notebooks

logger = logging.getLogger(__name__)

DEFAULT_NOTEBOOK_NAME = "My Notebook"


def migrate_legacy_layout() -> None:
    """One-time move of the pre-notebooks flat layout into a default notebook.

    Legacy layout: data/docs.db + data/my_index.faiss (+ data/uploads, data/audio).

    The sole guard is the legacy marker (data/docs.db). Its presence means the
    migration has not fully completed; its absence means either migration
    already finished or this is a fresh install with nothing to migrate.
    `docs.db` is moved LAST so it doubles as a commit marker: if the process
    dies partway through, the legacy docs.db is still present and this
    function re-runs (and safely resumes) on next startup.
    """
    legacy_db = DATA_DIR / "docs.db"
    if not legacy_db.exists():
        return

    logger.info("Migrating legacy flat corpus into a default notebook...")

    existing = next(
        (nb for nb in notebooks.list_notebooks() if nb.get("name") == DEFAULT_NOTEBOOK_NAME),
        None,
    )
    record = existing or notebooks.create_notebook(DEFAULT_NOTEBOOK_NAME, "📓")
    dest = notebook_dir(record["id"])

    def _move(name: str):
        src = DATA_DIR / name
        if not src.exists():
            return
        target = dest / name
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                os.remove(target)
        shutil.move(str(src), str(target))

    _move("my_index.faiss")
    _move("uploads")
    _move("audio")

    # create_notebook already made an empty docs.db in dest; replace it, then
    # move the legacy docs.db in last - this is the commit marker.
    empty = dest / "docs.db"
    if empty.exists():
        os.remove(empty)
    _move("docs.db")

    logger.info(f"Legacy corpus migrated into notebook {record['id']}.")

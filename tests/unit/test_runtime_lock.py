import threading
from app.server import Runtime


def test_runtime_tuple_has_lock():
    rt = Runtime(db_path=":memory:", engine=None, lock=threading.Lock())
    assert hasattr(rt, "lock")
    assert isinstance(rt.lock, type(threading.Lock()))


def test_per_notebook_lock_independence():
    rt1 = Runtime(db_path=":memory:", engine=None, lock=threading.Lock())
    rt2 = Runtime(db_path=":memory:", engine=None, lock=threading.Lock())

    assert rt1.lock.acquire(blocking=False)
    assert rt2.lock.acquire(blocking=False)

    rt2.lock.release()
    rt1.lock.release()


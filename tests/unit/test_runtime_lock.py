import threading
from app.server import Runtime


def test_runtime_tuple_has_lock():
    rt = Runtime(db_path=":memory:", engine=None, lock=threading.Lock())
    assert hasattr(rt, "lock")
    assert isinstance(rt.lock, type(threading.Lock()))

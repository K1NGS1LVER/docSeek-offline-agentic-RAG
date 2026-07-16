"""
E2E fixtures: boot the real docSeek server as a subprocess against an
isolated temp data directory, exactly as an end user would run it.

The suite never touches the developer's real data/ directory: the server
subprocess gets DOCSEEK_DATA_DIR pointing at a throwaway tmp dir and a free
port via DOCSEEK_PORT.
"""

import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time

import pytest
import requests

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
PYTHON = PROJECT_ROOT / ".venv" / "bin" / "python"

# First boot loads the embedding model; allow plenty of time.
SERVER_READY_TIMEOUT = 180


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def server():
    """Boot a real server subprocess; yields its base URL."""
    data_dir = tempfile.mkdtemp(prefix="docseek_e2e_")
    port = _free_port()
    env = {
        **os.environ,
        "DOCSEEK_DATA_DIR": data_dir,
        "DOCSEEK_PORT": str(port),
    }
    # Server logs go to a file, never a PIPE: an undrained pipe fills up and
    # blocks the server on a log write, freezing it mid-suite.
    log_path = pathlib.Path(data_dir) / "server.log"
    log_file = open(log_path, "wb")
    proc = subprocess.Popen(
        [str(PYTHON), "-m", "app.server"],
        cwd=PROJECT_ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + SERVER_READY_TIMEOUT
        while True:
            if proc.poll() is not None:
                raise RuntimeError(
                    "Server exited during startup:\n"
                    + log_path.read_text(errors="replace")
                )
            try:
                if requests.get(f"{base}/stats", timeout=2).ok:
                    break
            except requests.exceptions.RequestException:
                pass
            if time.time() > deadline:
                raise RuntimeError("Server did not become ready in time")
            time.sleep(1)
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log_file.close()
        shutil.rmtree(data_dir, ignore_errors=True)


@pytest.fixture(scope="session")
def ollama_up() -> bool:
    """Whether the LLM endpoint the server under test uses is reachable.

    Probes the same base URL the server subprocess inherits (including the
    DOCSEEK_LLM_BASE_URL override), not a hardcoded localhost:11434.
    """
    base_url = os.environ.get("DOCSEEK_LLM_BASE_URL", "http://localhost:11434/v1")
    try:
        return requests.get(f"{base_url}/models", timeout=2).ok
    except requests.exceptions.RequestException:
        return False

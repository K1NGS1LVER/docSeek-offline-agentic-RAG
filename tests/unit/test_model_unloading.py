import os
import time
from unittest.mock import MagicMock
from app.core import config
from app.core import stt


def test_audio_idle_timeout_config_default():
    assert hasattr(config, "DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS")
    assert config.DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS == 300.0


def test_stt_unload_and_idle_check():
    # Setup mock model
    mock_model = MagicMock()
    stt._model = mock_model
    stt._load_failed = False
    stt._last_used_time = time.time() - 400.0  # 400s ago

    # check_idle_unload should trigger unload when timeout=300
    unloaded = stt.check_idle_unload(300.0)
    assert unloaded is True
    assert stt._model is None

    # Calling check_idle_unload again when model is None returns False
    assert stt.check_idle_unload(300.0) is False


def test_stt_idle_check_below_timeout():
    mock_model = MagicMock()
    stt._model = mock_model
    stt._load_failed = False
    stt._last_used_time = time.time() - 100.0  # 100s ago (< 300s)

    assert stt.check_idle_unload(300.0) is False
    assert stt._model is mock_model


def test_stt_idle_check_zero_or_negative_timeout():
    mock_model = MagicMock()
    stt._model = mock_model
    stt._last_used_time = time.time() - 400.0

    assert stt.check_idle_unload(0.0) is False
    assert stt.check_idle_unload(-10.0) is False
    assert stt._model is mock_model


def test_stt_unload_direct():
    mock_model = MagicMock()
    stt._model = mock_model
    stt._last_used_time = time.time()

    assert stt.unload() is True
    assert stt._model is None
    assert stt._last_used_time == 0.0
    assert stt.unload() is False



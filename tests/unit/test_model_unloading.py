import os
import time
from unittest.mock import MagicMock
from app.core import config
from app.core import stt
from app.core import tts


def test_audio_idle_timeout_config_default():
    assert hasattr(config, "DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS")
    assert config.DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS == 60.0


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
    stt._load_failed = False
    stt._last_used_time = time.time()

    assert stt.unload() is True
    assert stt._model is None
    assert stt._last_used_time == 0.0
    assert stt._load_failed is False
    assert stt.unload() is False


def test_stt_unload_resets_load_failed():
    stt._model = None
    stt._load_failed = True
    stt.unload()
    assert stt._load_failed is False

    mock_model = MagicMock()
    stt._model = mock_model
    stt._load_failed = True
    assert stt.unload() is True
    assert stt._load_failed is False


def test_tts_unload_and_idle_check():
    mock_pipeline = MagicMock()
    tts._pipeline = mock_pipeline
    tts._load_failed = False
    tts._last_used_time = time.time() - 400.0  # 400s ago

    unloaded = tts.check_idle_unload(300.0)
    assert unloaded is True
    assert tts._pipeline is None

    assert tts.check_idle_unload(300.0) is False


def test_tts_idle_check_below_timeout():
    mock_pipeline = MagicMock()
    tts._pipeline = mock_pipeline
    tts._load_failed = False
    tts._last_used_time = time.time() - 100.0  # 100s ago (< 300s)

    assert tts.check_idle_unload(300.0) is False
    assert tts._pipeline is mock_pipeline


def test_tts_idle_check_zero_or_negative_timeout():
    mock_pipeline = MagicMock()
    tts._pipeline = mock_pipeline
    tts._last_used_time = time.time() - 400.0

    assert tts.check_idle_unload(0.0) is False
    assert tts.check_idle_unload(-10.0) is False
    assert tts._pipeline is mock_pipeline


def test_tts_unload_direct():
    mock_pipeline = MagicMock()
    tts._pipeline = mock_pipeline
    tts._load_failed = False
    tts._last_used_time = time.time()

    assert tts.unload() is True
    assert tts._pipeline is None
    assert tts._last_used_time == 0.0
    assert tts._load_failed is False
    assert tts.unload() is False


def test_tts_unload_resets_load_failed():
    tts._pipeline = None
    tts._load_failed = True
    tts.unload()
    assert tts._load_failed is False

    mock_pipeline = MagicMock()
    tts._pipeline = mock_pipeline
    tts._load_failed = True
    assert tts.unload() is True
    assert tts._load_failed is False


def test_check_audio_models_idle_invokes_both(monkeypatch):
    stt_mock = MagicMock(return_value=False)
    tts_mock = MagicMock(return_value=False)
    monkeypatch.setattr("app.core.stt.check_idle_unload", stt_mock)
    monkeypatch.setattr("app.core.tts.check_idle_unload", tts_mock)

    from app.server import _check_audio_models_idle

    _check_audio_models_idle()
    stt_mock.assert_called_once()
    tts_mock.assert_called_once()

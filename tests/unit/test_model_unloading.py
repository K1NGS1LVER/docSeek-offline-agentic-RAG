import os
from app.core import config


def test_audio_idle_timeout_config_default():
    assert hasattr(config, "DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS")
    assert config.DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS == 300.0

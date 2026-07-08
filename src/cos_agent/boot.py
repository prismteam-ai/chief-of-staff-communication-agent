"""Connector registration. Fixture connectors by default (mock-first dev loop);
real provider connectors replace their channel when credentials are present."""
from .connectors import x_api
from .connectors.base import register
from .connectors.fixture import FixtureConnector

CHANNELS = ["gmail", "email", "sms", "whatsapp", "x", "linkedin"]

for _ch in CHANNELS:
    register(FixtureConnector(_ch))

# credential-gated real connectors override their fixture
if x_api.available():
    register(x_api.XConnector())

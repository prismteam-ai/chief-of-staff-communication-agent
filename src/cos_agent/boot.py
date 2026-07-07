"""Connector registration. Fixture connectors by default (mock-first dev loop);
real provider connectors replace channels here as credentials land."""
from .connectors.base import register
from .connectors.fixture import FixtureConnector

CHANNELS = ["gmail", "email", "sms", "whatsapp", "x", "linkedin"]

for _ch in CHANNELS:
    register(FixtureConnector(_ch))

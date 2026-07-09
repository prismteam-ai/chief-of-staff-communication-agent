"""Connector registration. Fixture connectors by default (mock-first dev loop);
real provider connectors replace their channel when credentials are present."""
import os
from .connectors import x_api
from .connectors.base import register
from .connectors.fixture import FixtureConnector

CHANNELS = ["gmail", "email", "sms", "whatsapp", "x", "linkedin"]

for _ch in CHANNELS:
    register(FixtureConnector(_ch))

# credential-gated real connectors override their fixture / add new channels
if x_api.available():
    register(x_api.XConnector())

if os.environ.get("GOOGLE_CLIENT_ID"):
    from .connectors import gmail_api

    for _acct in gmail_api.stored_accounts():
        register(gmail_api.GmailConnector(_acct["account_handle"], _acct["refresh_token"]))

from .connectors import telegram  # noqa: E402

if telegram.available():
    register(telegram.TelegramConnector())

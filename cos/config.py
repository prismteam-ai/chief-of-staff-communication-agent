"""Runtime configuration.

One flag, ``MODE``, switches every connector between the local mock servers and the
real provider APIs. Connector code never changes between the two — only the base URL
and credentials read from here do.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mode: str = "mock"  # "mock" | "real"

    mock_host: str = "127.0.0.1"
    mock_port: int = 8900

    # Host roots. Each real SDK appends its own native path (Gmail /gmail/v1, X /2,
    # WhatsApp /<version>/<phone_id>). Asana carries its /api/1.0 base path.
    gmail_base_url: str = "http://127.0.0.1:8900"
    x_base_url: str = "http://127.0.0.1:8900"
    whatsapp_base_url: str = "http://127.0.0.1:8900"
    asana_base_url: str = "http://127.0.0.1:8900/api/1.0"

    gmail_user_id: str = "me"
    x_bearer_token: str = "mock-x-bearer"
    x_user_id: str = "1000000000000000001"
    whatsapp_api_version: str = "v19.0"
    whatsapp_phone_id: str = "100000000000001"
    whatsapp_token: str = "mock-whatsapp-token"
    asana_token: str = "mock-asana-token"
    asana_workspace_gid: str = "1200000000000001"

    # --- Real-mode credentials (unused in MODE=mock; empty by default) ---------
    # Gmail: a Google OAuth "installed app" client + a user refresh token. The
    # access token is derived from the refresh token at request time, so only the
    # refresh token needs to persist.
    google_client_id: str = ""
    google_client_secret: str = ""
    google_refresh_token: str = ""
    google_token_uri: str = "https://oauth2.googleapis.com/token"
    google_scopes: str = ("https://www.googleapis.com/auth/gmail.readonly "
                          "https://www.googleapis.com/auth/gmail.send")

    # X: OAuth1 user context is required for DMs and posting; the bearer token
    # (app-only) covers public reads such as mentions.
    x_consumer_key: str = ""
    x_consumer_secret: str = ""
    x_access_token: str = ""
    x_access_token_secret: str = ""

    # WhatsApp inbound arrives via webhook; these secure the receiver.
    whatsapp_verify_token: str = "mock-verify-token"
    whatsapp_app_secret: str = ""

    # --- App API / auth --------------------------------------------------------
    # Shared HS256 secret: the Next.js login mints the session JWT, this API verifies
    # it and enforces the role boundary. Override in every real deployment.
    auth_jwt_secret: str = "dev-insecure-change-me-in-production-0123456789"
    # Comma-separated CORS origins for the Next.js frontend (dev + deploy).
    api_cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    owner_name: str = "Dmitrii Konyrev"
    owner_email: str = "konyrevdmitriy@gmail.com"
    owner_x_handle: str = "dmitrii_cos"
    owner_whatsapp: str = "+15550000001"

    @property
    def is_mock(self) -> bool:
        return self.mode.lower() == "mock"

    @property
    def google_scope_list(self) -> list[str]:
        return self.google_scopes.split()

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

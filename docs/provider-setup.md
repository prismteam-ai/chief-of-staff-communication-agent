# Provider App Registration Checklist

Redirect URI base: `{APP_BASE_URL}` — `http://localhost:3000` in dev, your
Azure URL in prod. Put the resulting client IDs/secrets in `.env` (see
`.env.example`).

## App sign-in

### Google sign-in
1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create OAuth client ID (Web application)
2. Authorized redirect URI: `{APP_BASE_URL}/api/auth/callback/google`
3. → `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`

### Microsoft sign-in
1. [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations → New registration
2. Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*
3. Redirect URI (Web): `{APP_BASE_URL}/api/auth/callback/microsoft-entra-id`
4. Certificates & secrets → New client secret
5. → `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`

## Channels

### Gmail
1. Same Google Cloud project → enable the **Gmail API**
2. OAuth consent screen: add scopes `gmail.readonly`, `gmail.send`; add yourself as test user while in Testing mode
3. Create a **separate** OAuth client (or reuse) with redirect URI: `{APP_BASE_URL}/api/connections/gmail/callback`
4. → `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`

### Outlook
1. Azure App registration (can reuse the sign-in registration or create a new one)
2. Add redirect URI: `{APP_BASE_URL}/api/connections/outlook/callback`
3. API permissions → Microsoft Graph → Delegated: `Mail.Read`, `Mail.Send`, `offline_access`
4. → `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`

### LinkedIn
1. [LinkedIn Developers](https://developer.linkedin.com) → Create app (requires a company page)
2. Products: request **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**
3. Auth tab → redirect URL: `{APP_BASE_URL}/api/connections/linkedin/callback`
4. → `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`

### X (Twitter)
1. [X Developer Portal](https://developer.x.com) → Project + App (Free tier works for connect; posting limits depend on tier)
2. User authentication settings: OAuth 2.0, type **Web App** (confidential client)
3. Callback URI: `{APP_BASE_URL}/api/connections/x/callback`
4. → `X_CLIENT_ID`, `X_CLIENT_SECRET`

### WhatsApp (Meta Business Cloud API) — per-user credential form
No app-level env vars. Each user needs, from
[Meta for Developers](https://developers.facebook.com) (WhatsApp product):
- Permanent **System User Access Token** (Business Settings → System users)
- **Phone Number ID** and **WhatsApp Business Account ID** (WhatsApp → API Setup)

### SMS (Twilio) — per-user credential form
No app-level env vars. Each user enters from the
[Twilio Console](https://console.twilio.com):
- **Account SID**, **Auth Token**, and their Twilio **phone number**

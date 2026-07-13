# Chief of Communications

Web app + (upcoming) AI agent layer that manages your communications across
Gmail, Outlook, WhatsApp, X, LinkedIn, and SMS.

**Milestone 1** — Channel connections: sign in with Google/Microsoft and
connect your channels, granting the system access via OAuth or API credentials.
Tokens are AES-256-GCM encrypted at rest.

## Stack
- Next.js (App Router, TypeScript, Tailwind)
- Auth.js v5 (Google + Microsoft Entra ID sign-in)
- Prisma + PostgreSQL (Azure Database for PostgreSQL in prod)
- Azure App Service + Key Vault + Managed Identity

## Getting started

```bash
npm install
cp .env.example .env        # fill in values (see docs/provider-setup.md)
npx prisma migrate dev
npm run dev
```

Open http://localhost:3000, sign in, and connect channels at `/connections`.

## Docs
- [Provider app registration checklist](docs/provider-setup.md) — how to get every client ID/secret
- [Azure deployment guide](docs/azure-setup.md)

## Channel connection model
| Channel  | Mechanism |
|----------|-----------|
| Gmail    | Google OAuth 2.0 (gmail.readonly, gmail.send) |
| Outlook  | Microsoft Graph OAuth 2.0 (Mail.Read, Mail.Send) |
| LinkedIn | LinkedIn OAuth 2.0 (OpenID Connect + w_member_social) |
| X        | OAuth 2.0 + PKCE |
| WhatsApp | Meta Business Cloud API credentials (per-user form) |
| SMS      | Twilio credentials (per-user form) |

The `ChannelConnection` model + `getFreshAccessToken()` in
`src/lib/connections.ts` are the interface the AI agent layer will use to act
on channels.

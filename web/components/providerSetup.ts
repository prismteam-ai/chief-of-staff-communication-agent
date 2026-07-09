// Setup metadata for the connect wizard. Field keys must match the backend's
// _CRED_ENV mapping in cos/api/connections.py.

export interface SetupField {
  key: string;
  label: string;
  instruction: string; // how to obtain this value
  placeholder?: string;
  optional?: boolean;
  secret?: boolean; // render as a masked input
}

export interface ProviderSetup {
  provider: "gmail" | "whatsapp" | "x" | "asana";
  title: string;
  blurb: string;
  docsUrl: string;
  docsLabel: string;
  fields: SetupField[];
}

export const PROVIDER_SETUP: Record<string, ProviderSetup> = {
  gmail: {
    provider: "gmail",
    title: "Connect Gmail",
    blurb:
      "Gmail uses a Google OAuth “Desktop app” client plus a one-time refresh token. The app reads your inbox and sends approved replies.",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    docsLabel: "Google Cloud Console → Credentials",
    fields: [
      {
        key: "client_id",
        label: "OAuth Client ID",
        instruction:
          "In Google Cloud Console → APIs & Services → Credentials, create an OAuth 2.0 Client ID of type “Desktop app”, then copy the Client ID (ends in .apps.googleusercontent.com).",
        placeholder: "1234567890-abc.apps.googleusercontent.com",
      },
      {
        key: "client_secret",
        label: "OAuth Client secret",
        instruction:
          "From the same OAuth client you just created, copy the Client secret shown next to the Client ID.",
        placeholder: "GOCSPX-…",
        secret: true,
      },
      {
        key: "refresh_token",
        label: "Refresh token",
        instruction:
          "Run the one-time consent flow (see RUNNING.md) with the gmail.readonly + gmail.send scopes; it prints a refresh_token. Paste it here — the app derives access tokens from it automatically.",
        placeholder: "1//0g…",
        secret: true,
      },
    ],
  },

  whatsapp: {
    provider: "whatsapp",
    title: "Connect WhatsApp",
    blurb:
      "WhatsApp uses the Meta Cloud API. Inbound messages arrive via webhook; approved replies are sent through your business phone number.",
    docsUrl: "https://developers.facebook.com/apps",
    docsLabel: "Meta for Developers → your app",
    fields: [
      {
        key: "token",
        label: "Access token",
        instruction:
          "In Meta for Developers → your app → WhatsApp → API Setup, copy the access token (use a permanent System User token for production, not the 24-hour temporary one).",
        placeholder: "EAAG…",
        secret: true,
      },
      {
        key: "phone_id",
        label: "Phone number ID",
        instruction:
          "On the same WhatsApp → API Setup page, copy the “Phone number ID” (a long number, not the phone number itself).",
        placeholder: "100000000000001",
      },
      {
        key: "app_secret",
        label: "App secret",
        instruction:
          "App → Settings → Basic → App secret. The webhook receiver uses it to verify the X-Hub-Signature-256 on every inbound message.",
        placeholder: "3a1b…",
        secret: true,
      },
      {
        key: "verify_token",
        label: "Webhook verify token",
        instruction:
          "A string you invent. Enter the same value here and in the WhatsApp webhook configuration; Meta echoes it back once to verify the endpoint.",
        placeholder: "my-verify-token",
        optional: true,
      },
    ],
  },

  x: {
    provider: "x",
    title: "Connect X (Twitter)",
    blurb:
      "X uses OAuth 1.0a user context so the app can read mentions/DMs and post approved replies on your behalf.",
    docsUrl: "https://developer.x.com/en/portal/dashboard",
    docsLabel: "X Developer Portal",
    fields: [
      {
        key: "consumer_key",
        label: "API key (consumer key)",
        instruction:
          "In the X Developer Portal → your Project/App → “Keys and tokens”, copy the API Key.",
        placeholder: "xvz1evФ…",
        secret: true,
      },
      {
        key: "consumer_secret",
        label: "API key secret",
        instruction:
          "On the same “Keys and tokens” page, copy the API Key Secret (shown once when you generate the keys).",
        placeholder: "…",
        secret: true,
      },
      {
        key: "access_token",
        label: "Access token",
        instruction:
          "Under “Keys and tokens” → Access Token and Secret, click Generate. Set app permissions to Read and Write first so replies can post. Copy the Access Token.",
        placeholder: "1000000000000000001-…",
        secret: true,
      },
      {
        key: "access_token_secret",
        label: "Access token secret",
        instruction:
          "The Access Token Secret shown right below the Access Token in the same Generate step.",
        placeholder: "…",
        secret: true,
      },
    ],
  },

  asana: {
    provider: "asana",
    title: "Connect Asana",
    blurb:
      "Asana uses a Personal Access Token — no OAuth dance. The app links messages to tasks/milestones and creates or updates them.",
    docsUrl: "https://app.asana.com/0/my-apps",
    docsLabel: "Asana → My apps",
    fields: [
      {
        key: "token",
        label: "Personal access token",
        instruction:
          "Asana → Settings → Apps → Developer apps → “Personal access tokens” → Create new token. Copy it now — it is shown only once.",
        placeholder: "2/1201…",
        secret: true,
      },
      {
        key: "workspace_gid",
        label: "Workspace GID",
        instruction:
          "While logged into Asana, open https://app.asana.com/api/1.0/workspaces in your browser and copy the gid of the workspace you want to use.",
        placeholder: "1200000000000001",
      },
    ],
  },
};

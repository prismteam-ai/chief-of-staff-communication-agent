export type ProviderId =
  | "gmail"
  | "outlook"
  | "linkedin"
  | "x"
  | "whatsapp"
  | "sms"
  | "asana";

export interface TestResult {
  ok: boolean;
  /** Human-readable account label, e.g. email address or handle */
  label?: string;
  error?: string;
}

interface BaseProviderConfig {
  id: ProviderId;
  name: string;
  description: string;
}

/** Channel connected via a standard OAuth 2.0 authorization-code flow. */
export interface OAuthProviderConfig extends BaseProviderConfig {
  kind: "oauth";
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** env var names holding the client credentials */
  clientIdEnv: string;
  clientSecretEnv: string;
  usePKCE?: boolean;
  /** how to send client credentials to the token endpoint */
  clientAuth: "body" | "basic";
  extraAuthParams?: Record<string, string>;
  /** Validate token + return an account label (email/handle). */
  testConnection: (accessToken: string) => Promise<TestResult>;
  revoke?: (accessToken: string) => Promise<void>;
}

export interface CredentialField {
  name: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

/** Channel connected via API credentials (no user OAuth): WhatsApp Business, Twilio. */
export interface CredentialProviderConfig extends BaseProviderConfig {
  kind: "credentials";
  fields: CredentialField[];
  helpUrl?: string;
  /** Validate the credentials against the provider API. */
  testConnection: (credentials: Record<string, string>) => Promise<TestResult>;
}

export type ChannelProviderConfig = OAuthProviderConfig | CredentialProviderConfig;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
}

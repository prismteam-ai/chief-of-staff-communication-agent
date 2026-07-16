import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { DashboardCredential } from './services/dashboard-login-service.js';

/**
 * Loads the operator-provisioned demo dashboard credential list from Secrets Manager (Task 8.5).
 * Same secret-caching shape as `packages/connectors/src/whatsapp/twilio-client.ts`'s
 * `loadTwilioWhatsAppCredentials` — one Secrets Manager entry, JSON-parsed, memoized for the warm
 * Lambda container's lifetime (there is no reason to re-fetch it on every `login` call). The
 * secret value is a JSON array of `DashboardCredential` — `passwordHash` only, never a plaintext
 * password (design.md §10: "no secret in code, logs, or the client bundle").
 */

let cachedSecretsClient: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  cachedSecretsClient ??= new SecretsManagerClient({});
  return cachedSecretsClient;
}

const SECRET_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
let cachedCredentials: { value: DashboardCredential[]; fetchedAt: number } | undefined;

/** Returns `[]` (not a thrown error) when the secret id is empty or the secret isn't provisioned
 * for this deploy — `DashboardLoginService.login` then fails every attempt closed with
 * `DashboardLoginInvalidError`, the same "degrade to a clear, closed failure" posture every other
 * optional dependency in this codebase uses. */
export async function loadDashboardCredentials(secretId: string): Promise<DashboardCredential[]> {
  if (!secretId) return [];
  if (cachedCredentials && Date.now() - cachedCredentials.fetchedAt < SECRET_CACHE_MAX_AGE_MS) {
    return cachedCredentials.value;
  }
  try {
    const result = await secretsClient().send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) return [];
    const value = JSON.parse(result.SecretString) as DashboardCredential[];
    cachedCredentials = { value, fetchedAt: Date.now() };
    return value;
  } catch {
    // Unprovisioned secret (ResourceNotFoundException) or a transient Secrets Manager error both
    // degrade to "no credentials loaded" rather than crashing the Lambda at cold start — `login`
    // still runs, it just rejects every attempt (fail closed, never fail open).
    return [];
  }
}

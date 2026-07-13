import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * AES-256-GCM encryption for channel tokens/credentials at rest.
 * Key source:
 *  - Local dev: TOKEN_ENCRYPTION_KEY env var (base64, 32 bytes)
 *  - Azure prod: fetched once from Key Vault (AZURE_KEY_VAULT_URL +
 *    TOKEN_ENCRYPTION_KEY_SECRET_NAME) via Managed Identity.
 */

let cachedKey: Buffer | null = null;

async function loadKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
  if (vaultUrl) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const { SecretClient } = await import("@azure/keyvault-secrets");
    const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
    const secretName =
      process.env.TOKEN_ENCRYPTION_KEY_SECRET_NAME ?? "token-encryption-key";
    const secret = await client.getSecret(secretName);
    if (!secret.value) throw new Error(`Key Vault secret ${secretName} is empty`);
    cachedKey = Buffer.from(secret.value, "base64");
  } else {
    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32"
      );
    }
    cachedKey = Buffer.from(raw, "base64");
  }

  if (cachedKey.length !== 32) {
    throw new Error("Token encryption key must be exactly 32 bytes (base64-encoded).");
  }
  return cachedKey;
}

/** Encrypt a UTF-8 string. Output format: base64(iv).base64(tag).base64(ciphertext) */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

/** Decrypt a value produced by encrypt(). */
export async function decrypt(payload: string): Promise<string> {
  const key = await loadKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

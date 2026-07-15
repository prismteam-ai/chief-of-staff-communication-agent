import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "crypto";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.AZURE_KEY_VAULT_URL;
});

describe("crypto", () => {
  it("round-trips a secret", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const secret = "1/1234567890:abcdef-asana-pat";
    const payload = await encrypt(secret);
    expect(payload).not.toContain(secret);
    expect(payload.split(".")).toHaveLength(3);
    expect(await decrypt(payload)).toBe(secret);
  });

  it("produces a different ciphertext per call (random IV)", async () => {
    const { encrypt } = await import("@/lib/crypto");
    expect(await encrypt("same")).not.toBe(await encrypt("same"));
  });

  it("rejects tampered payloads", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const payload = await encrypt("value");
    const [iv, tag, data] = payload.split(".");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    await expect(
      decrypt(`${iv}.${tag}.${flipped.toString("base64")}`)
    ).rejects.toThrow();
  });
});

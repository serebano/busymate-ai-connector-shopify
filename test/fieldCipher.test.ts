import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptField,
  encryptField,
  encryptionActive,
  isEncrypted,
} from "../app/lib/fieldCipher";

/**
 * B8 — column encryption at rest. The PCD questionnaire attests at-rest encryption
 * for access tokens + PII; this proves the helper makes it true: a round-trip, GCM
 * tamper detection, legacy-plaintext passthrough, and the documented no-key dev
 * no-op. An explicit env object is passed so the module key cache (keyed on
 * process.env) is bypassed.
 */
const KEY = crypto.randomBytes(32).toString("base64");
const withKey = { APP_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv;
const noKey = {} as NodeJS.ProcessEnv;

describe("field cipher (AES-256-GCM at rest)", () => {
  it("round-trips a value through encrypt → decrypt", () => {
    // Synthetic opaque plaintext — NOT a credential. The cipher treats it as an
    // arbitrary string, so no credential-shaped literal is needed (avoids secret-scanner noise).
    const token = "example-access-token-value-not-a-secret";
    const enc = encryptField(token, withKey);
    expect(enc).not.toBe(token);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptField(enc, withKey)).toBe(token);
  });

  it("produces a distinct ciphertext each call (random IV) but both decrypt equal", () => {
    const a = encryptField("same-secret", withKey);
    const b = encryptField("same-secret", withKey);
    expect(a).not.toBe(b);
    expect(decryptField(a, withKey)).toBe("same-secret");
    expect(decryptField(b, withKey)).toBe("same-secret");
  });

  it("accepts a 64-char hex key as well as base64", () => {
    const hexEnv = { APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") } as NodeJS.ProcessEnv;
    const enc = encryptField("v", hexEnv);
    expect(decryptField(enc, hexEnv)).toBe("v");
  });

  it("detects tampering (GCM auth failure throws, never a wrong plaintext)", () => {
    const enc = encryptField("sensitive", withKey);
    // Flip a byte in the ciphertext body.
    const body = Buffer.from(enc.slice("enc:v1:".length), "base64");
    body[body.length - 1] ^= 0xff;
    const tampered = "enc:v1:" + body.toString("base64");
    expect(() => decryptField(tampered, withKey)).toThrow();
  });

  it("passes through legacy plaintext on read (migration-safe)", () => {
    expect(decryptField("legacy-plaintext-token", withKey)).toBe("legacy-plaintext-token");
    expect(isEncrypted("legacy-plaintext-token")).toBe(false);
  });

  it("is a documented no-op when no key is configured (dev/CI credential-free path)", () => {
    expect(encryptionActive(noKey)).toBe(false);
    const v = encryptField("dev-token", noKey);
    expect(v).toBe("dev-token"); // unchanged
    expect(decryptField(v, noKey)).toBe("dev-token");
  });

  it("encryptionActive is true only with a usable 32-byte key", () => {
    expect(encryptionActive(withKey)).toBe(true);
    expect(encryptionActive({ APP_ENCRYPTION_KEY: "too-short" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each([undefined, "", "too-short", KEY + "!"])("refuses production writes with a missing or malformed key: case %#", (key) => {
    const env = { NODE_ENV: "production", APP_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv;
    expect(encryptionActive(env)).toBe(false);
    expect(() => encryptField("synthetic-sensitive-value", env)).toThrow("valid APP_ENCRYPTION_KEY");
  });

  it("encrypts production writes with a valid key and preserves legacy reads", () => {
    const env = { ...withKey, NODE_ENV: "production" } as NodeJS.ProcessEnv;
    const encrypted = encryptField("production-fixture", env);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptField(encrypted, env)).toBe("production-fixture");
    expect(decryptField("legacy-row", { NODE_ENV: "production" })).toBe("legacy-row");
  });

  it("encrypting an already-encrypted value is idempotent (no double-wrap)", () => {
    const once = encryptField("x", withKey);
    const twice = encryptField(once, withKey);
    expect(twice).toBe(once);
    expect(decryptField(twice, withKey)).toBe("x");
  });
});

import crypto from "node:crypto";

/**
 * App-level column encryption at rest (AES-256-GCM).
 *
 * The PCD (Protected Customer Data) questionnaire attests encryption at rest for
 * access tokens + PII. This helper makes that attestation TRUE: sensitive columns
 * (Shopify `Session.accessToken` + `Session.refreshToken` + staff `email`, and the bmai
 * `BmaiCredential.refreshToken`) are
 * encrypted with `encryptField` on write and `decryptField` on read.
 *
 * KEY: `APP_ENCRYPTION_KEY` — a 32-byte key as base64 (44 chars) or hex (64 chars).
 * VALUE-BLIND: the key is only ever fed to the cipher, never logged or returned.
 *
 * FORMAT: `enc:v1:<base64(iv[12] | tag[16] | ciphertext)>`. `decryptField`
 * transparently passes through any value NOT bearing that prefix — so legacy
 * plaintext rows (written before encryption was enabled) still read correctly, and
 * a re-write upgrades them in place. A missing key in dev/CI is a documented no-op
 * passthrough (the credential-free test/build path); production writes refuse a missing
 * or invalid key. Importing the module for a build does not require a key.
 */
const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null | undefined;

/** Parse `APP_ENCRYPTION_KEY` into a 32-byte Buffer, or null when unset/invalid. */
export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  if (cachedKey !== undefined && env === process.env) return cachedKey;
  const raw = (env.APP_ENCRYPTION_KEY || "").trim();
  let key: Buffer | null = null;
  if (raw) {
    try {
      if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
      else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
        const b = Buffer.from(raw, "base64");
        if (b.length === 32 && b.toString("base64") === raw) key = b;
      }
    } catch {
      key = null;
    }
  }
  if (env === process.env) cachedKey = key;
  return key;
}

/** True iff a usable 32-byte key is configured (encryption is actually active). */
export function encryptionActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return encryptionKey(env) !== null;
}

/** For tests: drop the memoized key so a changed env is re-read. */
export function resetFieldCipherCache(): void {
  cachedKey = undefined;
}

/** Encrypt a field; production refuses missing/invalid keys before a plaintext write. */
export function encryptField(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = encryptionKey(env);
  if (!key && env.NODE_ENV === "production") {
    throw new Error("A valid APP_ENCRYPTION_KEY is required to write sensitive fields in production");
  }
  if (!key || plaintext == null || plaintext === "") return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted (idempotent)
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** True iff a stored value is in the encrypted envelope form. */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Decrypt a stored field. A value WITHOUT the envelope prefix is returned as-is
 * (legacy plaintext). A tampered/invalid ciphertext throws (GCM auth failure) — a
 * silent wrong value is never returned.
 */
export function decryptField(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isEncrypted(stored)) return stored; // legacy plaintext passthrough
  const key = encryptionKey(env);
  if (!key) throw new Error("APP_ENCRYPTION_KEY is required to read an encrypted field");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

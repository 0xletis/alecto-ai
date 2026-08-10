import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedSecretJsonEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecretEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretEncryptionError";
  }
}

export function getSecretEncryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const raw = env.ALECTO_SECRET_ENCRYPTION_KEY?.trim();

  if (!raw) {
    return undefined;
  }

  const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);

  if (decoded.length === 32) {
    return decoded;
  }

  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecretJson(value: unknown, key = getSecretEncryptionKeyFromEnv()): EncryptedSecretJsonEnvelope {
  if (!key) {
    throw new SecretEncryptionError("Secret encryption key is missing.");
  }

  if (key.length !== 32) {
    throw new SecretEncryptionError("Secret encryption key must be 32 bytes.");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptSecretJson<T = unknown>(value: unknown, key = getSecretEncryptionKeyFromEnv()): T {
  if (!isEncryptedSecretJsonEnvelope(value)) {
    throw new SecretEncryptionError("Encrypted secret payload is invalid.");
  }

  if (!key) {
    throw new SecretEncryptionError("Secret encryption key is missing.");
  }

  if (key.length !== 32) {
    throw new SecretEncryptionError("Secret encryption key must be 32 bytes.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");

    return JSON.parse(plaintext) as T;
  } catch {
    throw new SecretEncryptionError("Encrypted secret payload could not be decrypted.");
  }
}

export function isEncryptedSecretJsonEnvelope(value: unknown): value is EncryptedSecretJsonEnvelope {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).v === 1 &&
    (value as Record<string, unknown>).alg === "aes-256-gcm" &&
    typeof (value as Record<string, unknown>).iv === "string" &&
    typeof (value as Record<string, unknown>).tag === "string" &&
    typeof (value as Record<string, unknown>).ciphertext === "string"
  );
}

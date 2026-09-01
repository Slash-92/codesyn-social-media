import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const ALGORITHM = "aes-256-gcm";
const FORMAT = "codesyn-state-v1";

function encryptionKey(rawKey = process.env.STATE_ENCRYPTION_KEY) {
  if (!rawKey) throw new Error("STATE_ENCRYPTION_KEY non configurata");
  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) throw new Error("STATE_ENCRYPTION_KEY deve contenere 32 byte in Base64");
  return key;
}

export function encryptState(state, rawKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return {
    format: FORMAT,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptState(envelope, rawKey) {
  if (envelope?.format !== FORMAT || envelope?.algorithm !== ALGORITHM) {
    throw new Error("Formato dello stato cifrato non riconosciuto");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(rawKey),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export async function readEncryptedState(filePath, fallback, rawKey) {
  try {
    const envelope = JSON.parse(await readFile(filePath, "utf8"));
    return decryptState(envelope, rawKey);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export async function writeEncryptedState(filePath, state, rawKey) {
  const envelope = encryptState(state, rawKey);
  await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
  });
}

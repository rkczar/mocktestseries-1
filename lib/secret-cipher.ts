import "server-only";
import crypto from "node:crypto";

/**
 * AES-256-GCM secret storage for third-party provider credentials saved from
 * the Admin API Manager. Secrets are encrypted at rest (key derived from
 * AUTH_SECRET) so raw API keys / client secrets never sit in the database in
 * plaintext, and are never returned to the browser.
 *
 * Format of a stored value: `v1:<iv hex>:<auth tag hex>:<ciphertext hex>`.
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret) throw new Error("AUTH_SECRET is required to encrypt stored credentials.");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Returns the plaintext, or null if the value is not a valid v1 cipher blob. */
export function decryptSecret(stored: string | undefined | null): string | null {
  if (!stored) return null;
  try {
    const [v, ivHex, tagHex, dataHex] = stored.split(":");
    if (v !== "v1" || !ivHex || !tagHex || !dataHex) return null;
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function isEncryptedSecret(stored: string | undefined | null): boolean {
  return Boolean(stored && stored.startsWith("v1:"));
}

/** Never show a raw secret — only a fixed-width mask plus the final 4 chars. */
export function maskSecret(value: string): string {
  const tail = value.length > 4 ? value.slice(-4) : value;
  return "••••••••••••••••" + tail;
}
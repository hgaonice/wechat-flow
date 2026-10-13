/**
 * Credential encryption (AES-256-GCM) + master-key loading.
 *
 * Uses `node:crypto` rather than WebCrypto: it is fully typed by @types/node,
 * works unchanged under Bun, and keeps the zero-runtime-dependency rule (AC-10).
 *
 * Never falls back to plaintext: if no key can be loaded the caller must abort
 * (fail-fast, see spec/console/security.md).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MASTER_KEY_BYTES = 32;
export const KEY_VERSION = 1;

export function defaultKeyPath(): string {
  return process.env.CONSOLE_MASTER_KEY_FILE ?? path.join(os.homedir(), ".wechat-console", "master.key");
}

function decodeKey(label: string, raw: string): Buffer {
  const buf = Buffer.from(raw.trim(), "base64");
  if (buf.length !== MASTER_KEY_BYTES) {
    throw new Error(`${label} must be base64 of ${MASTER_KEY_BYTES} bytes (got ${buf.length})`);
  }
  return buf;
}

/** Load the master key: `CONSOLE_MASTER_KEY` env → `~/.wechat-console/master.key`. */
export function loadMasterKey(): Buffer {
  const env = process.env.CONSOLE_MASTER_KEY;
  if (env && env.trim().length > 0) return decodeKey("CONSOLE_MASTER_KEY", env);

  const p = defaultKeyPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `master key not found: set CONSOLE_MASTER_KEY (base64 of 32 bytes) or run \`bun src/console/main.ts --init-key\` to create ${p}`,
    );
  }
  if (process.platform !== "win32") {
    const mode = fs.statSync(p).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(`master key ${p} is group/world accessible (mode ${mode.toString(8)}); chmod 600 it`);
    }
  }
  return decodeKey(p, fs.readFileSync(p, "utf8"));
}

/** `--init-key`: create `~/.wechat-console/master.key` (0600) when missing. */
export function initMasterKey(force = false): { path: string; created: boolean } {
  const p = defaultKeyPath();
  if (fs.existsSync(p) && !force) return { path: p, created: false };
  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, key.toString("base64") + "\n", { mode: 0o600 });
  return { path: p, created: true };
}

export interface Encrypted {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export function encryptSecret(plaintext: string, key: Buffer, keyVersion = KEY_VERSION): Encrypted {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce, keyVersion };
}

export function decryptSecret(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time compare; both sides are hashed so length is not leaked. */
export function safeEqual(a: string, b: string): boolean {
  const ab = crypto.createHash("sha256").update(a).digest();
  const bb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ab, bb);
}

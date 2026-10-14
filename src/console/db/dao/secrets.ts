/**
 * `secrets` DAO — encrypted credential storage (I25: ciphertext only).
 *
 * Rows are addressed by `(account_id, kind)`. `account_id IS NULL` means a
 * *global* credential (e.g. the reserved global SMTP secret). SQLite does not
 * dedupe NULLs in a UNIQUE index, so global writes must look the row up with
 * `account_id IS NULL` before deciding UPDATE vs INSERT — that branch is the
 * whole reason `putSecret` exists instead of a naked `ON CONFLICT` upsert.
 *
 * This module never returns plaintext; callers decrypt with
 * `crypto/secrets.ts` and the master key.
 */
import type { Database } from "bun:sqlite";
import type { Encrypted } from "../../crypto/secrets.ts";

/**
 * Reserved credential kinds. `smtp` (D-C5-3) is stored write-only by the API
 * but not yet consumed at runtime — the actual SMTP settings come from the
 * global `notify.email` config. `cf_token` is reserved for a future *named*
 * tunnel; the C5 quick tunnel needs no token.
 */
export const SECRET_KINDS = ["wechat_login", "cf_token", "smtp"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export function isSecretKind(value: unknown): value is SecretKind {
  return typeof value === "string" && (SECRET_KINDS as readonly string[]).includes(value);
}

export interface SecretMeta {
  kind: string;
  key_version: number;
  updated_at: string;
}

export interface SecretCipher {
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
}

/** Metadata only (no ciphertext) — safe for API responses. */
export function listSecretMetas(db: Database, accountId: number | null): SecretMeta[] {
  if (accountId === null) {
    return db
      .query<SecretMeta>(
        "SELECT kind, key_version, updated_at FROM secrets WHERE account_id IS NULL ORDER BY kind",
      )
      .all();
  }
  return db
    .query<SecretMeta>(
      "SELECT kind, key_version, updated_at FROM secrets WHERE account_id = ? ORDER BY kind",
    )
    .all(accountId);
}

export function getSecretCipher(
  db: Database,
  accountId: number | null,
  kind: string,
): SecretCipher | null {
  const row =
    accountId === null
      ? db
          .query<SecretCipher>(
            "SELECT ciphertext, nonce, key_version FROM secrets WHERE account_id IS NULL AND kind = ?",
          )
          .get(kind)
      : db
          .query<SecretCipher>(
            "SELECT ciphertext, nonce, key_version FROM secrets WHERE account_id = ? AND kind = ?",
          )
          .get(accountId, kind);
  return row ?? null;
}

function rowIdFor(db: Database, accountId: number | null, kind: string): number | null {
  const row =
    accountId === null
      ? db
          .query<{ id: number }>("SELECT id FROM secrets WHERE account_id IS NULL AND kind = ?")
          .get(kind)
      : db
          .query<{ id: number }>("SELECT id FROM secrets WHERE account_id = ? AND kind = ?")
          .get(accountId, kind);
  return row?.id ?? null;
}

/** Insert-or-replace the ciphertext for `(accountId, kind)` (ciphertext only). */
export function putSecret(
  db: Database,
  accountId: number | null,
  kind: string,
  enc: Encrypted,
): void {
  const id = rowIdFor(db, accountId, kind);
  if (id !== null) {
    db.run(
      `UPDATE secrets
          SET ciphertext = ?, nonce = ?, key_version = ?, updated_at = datetime('now')
        WHERE id = ?`,
      enc.ciphertext,
      enc.nonce,
      enc.keyVersion,
      id,
    );
    return;
  }
  db.run(
    `INSERT INTO secrets(account_id, kind, ciphertext, nonce, key_version)
     VALUES (?, ?, ?, ?, ?)`,
    accountId,
    kind,
    enc.ciphertext,
    enc.nonce,
    enc.keyVersion,
  );
}

/** @returns number of deleted rows (0 when absent, so DELETE is idempotent). */
export function deleteSecret(db: Database, accountId: number | null, kind: string): number {
  if (accountId === null) {
    return db.run("DELETE FROM secrets WHERE account_id IS NULL AND kind = ?", kind).changes;
  }
  return db.run("DELETE FROM secrets WHERE account_id = ? AND kind = ?", accountId, kind).changes;
}

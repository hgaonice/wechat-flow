/**
 * Articles + drafts DAO (C3).
 *
 * Version chain contract (spec/console/data-model.md I15–I18):
 *   - `articles.version` is monotonic per (account_id, date); v1 has
 *     `parent_id = NULL`, every regenerate points at its predecessor.
 *   - `file_path` names the *snapshot* of that version (`<base>.v<N>.md`); the
 *     engine's base file (`<date>-<slug>.md`) always holds the latest content.
 *   - `drafts.verified` mirrors the engine's `verifyDraftBody()` verdict — the
 *     DAO never decides success itself (H1).
 *
 * Version numbering: when `version` is omitted, `insertArticle` allocates it
 * inside a single write transaction. `generateArticle` allocates it outside and
 * passes it explicitly, so cross-writer uniqueness there rests on **I4** (one
 * `running` job per account). The `(account_id, date, version)` triple has only a
 * non-unique index — it is not a DB-enforced constraint (ISSUE-1, accepted).
 */
import type { Database } from "bun:sqlite";

export interface ArticleRow {
  id: number;
  account_id: number;
  plan_id: number | null;
  date: string;
  title: string | null;
  slug: string | null;
  file_path: string | null;
  status: string;
  version: number;
  parent_id: number | null;
  feedback: string | null;
  created_at: string;
}

export interface DraftRow {
  id: number;
  account_id: number;
  article_id: number;
  wechat_title: string | null;
  push_at: string | null;
  verified: number;
  verify_detail: string | null;
  created_at: string;
}

const ARTICLE_COLUMNS = `id, account_id, plan_id, date, title, slug, file_path, status,
  version, parent_id, feedback, created_at`;
const DRAFT_COLUMNS = `id, account_id, article_id, wechat_title, push_at, verified, verify_detail, created_at`;

/** Next free version for one account+date (max+1; v1 when none exist). */
export function nextVersion(db: Database, accountId: number, date: string): number {
  const row = db
    .query<{ v: number | null }>(`SELECT MAX(version) AS v FROM articles WHERE account_id = ? AND date = ?`)
    .get(accountId, date);
  return (row?.v ?? 0) + 1;
}

export interface ArticleInput {
  accountId: number;
  date: string;
  planId?: number | null;
  title?: string | null;
  slug?: string | null;
  filePath?: string | null;
  status?: string;
  parentId?: number | null;
  feedback?: string | null;
  /** Explicit version (tests / imports). Omit to auto-allocate atomically. */
  version?: number;
}

export interface DraftInput {
  accountId: number;
  articleId: number;
  wechatTitle?: string | null;
  pushAt?: string | null;
  verified: boolean;
  verifyDetail?: string | null;
}

/** Insert one article version. Auto-numbers inside a transaction unless given. */
export function insertArticle(db: Database, input: ArticleInput): ArticleRow {
  const run = db.transaction((): number => {
    const version = input.version ?? nextVersion(db, input.accountId, input.date);
    const info = db.run(
      `INSERT INTO articles(account_id, plan_id, date, title, slug, file_path, status, version, parent_id, feedback)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.accountId,
      input.planId ?? null,
      input.date,
      input.title ?? null,
      input.slug ?? null,
      input.filePath ?? null,
      input.status ?? "draft",
      version,
      input.parentId ?? null,
      input.feedback ?? null,
    );
    return Number(info.lastInsertRowid);
  });
  const id = run();
  return getArticle(db, id)!;
}

export function getArticle(db: Database, id: number): ArticleRow | undefined {
  return db.query<ArticleRow>(`SELECT ${ARTICLE_COLUMNS} FROM articles WHERE id = ?`).get(id) ?? undefined;
}

export interface ListArticlesOptions {
  date?: string;
  limit?: number;
}

/** Newest first (date DESC, version DESC) so the UI's version chain is stable. */
export function listArticles(db: Database, accountId: number, opts: ListArticlesOptions = {}): ArticleRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  if (opts.date) {
    return db
      .query<ArticleRow>(
        `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE account_id = ? AND date = ?
          ORDER BY date DESC, version DESC LIMIT ?`,
      )
      .all(accountId, opts.date, limit);
  }
  return db
    .query<ArticleRow>(
      `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE account_id = ? ORDER BY date DESC, version DESC LIMIT ?`,
    )
    .all(accountId, limit);
}

/** All versions of one article lineage, oldest → newest (for diff/UI). */
export function listVersions(db: Database, article: ArticleRow): ArticleRow[] {
  return db
    .query<ArticleRow>(
      `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE account_id = ? AND date = ?
        ORDER BY version ASC`,
    )
    .all(article.account_id, article.date);
}

export function setArticleStatus(db: Database, id: number, status: string): void {
  db.run(`UPDATE articles SET status = ? WHERE id = ?`, status, id);
}

/** Insert a push attempt; `verified` mirrors the engine's verifyDraftBody verdict. */
export function insertDraft(db: Database, input: DraftInput): DraftRow {
  const info = db.run(
    `INSERT INTO drafts(account_id, article_id, wechat_title, push_at, verified, verify_detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.accountId,
    input.articleId,
    input.wechatTitle ?? null,
    input.pushAt ?? new Date().toISOString(),
    input.verified ? 1 : 0,
    input.verifyDetail ?? null,
  );
  return getDraft(db, Number(info.lastInsertRowid))!;
}

export function getDraft(db: Database, id: number): DraftRow | undefined {
  return db.query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) ?? undefined;
}

/** Drafts for one article, newest first. */
export function listDrafts(db: Database, articleId: number): DraftRow[] {
  return db
    .query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE article_id = ? ORDER BY id DESC`)
    .all(articleId);
}

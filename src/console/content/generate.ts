/**
 * Article generation orchestration (C3).
 *
 * Ties the engine's standalone article generation (`runArticleGeneration`) to
 * the version chain:
 *   1. the engine writes/overwrites the *base* file `<date>-<slug>.md`
 *      (always the latest content — the publish path keeps reading it, I17);
 *   2. we snapshot it to `<base>.v<N>.md` so old versions are never lost;
 *   3. we insert an `articles` row for that version (v1 with `parent_id=NULL`,
 *      a regenerate pointing at its predecessor).
 *
 * The engine's failure is surfaced unchanged: no DB row is written when the
 * article was not produced (AC-11 / H5).
 */
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../../config.ts";
import { runArticleGeneration, type ArticleGenResult } from "../../publisher.ts";
import { insertArticle, insertDraft, listArticles, nextVersion, setArticleStatus, type ArticleRow } from "../db/dao/articles.ts";

/** Engine generator shape; injectable so the orchestration is unit-testable. */
export type ArticleRunner = (
  cfg: AppConfig,
  opts: { date?: string; feedback?: string; reuse?: boolean },
) => Promise<ArticleGenResult>;

export interface SnapshotResult {
  /** Path of the immutable `.v<N>.md` snapshot. */
  snapshotPath: string;
  /** Version number parsed from `n`. */
  version: number;
}

/** Derive the snapshot path `<base>.v<N>.md` from the engine's base file. */
export function versionedPath(basePath: string, version: number): string {
  const suffix = `.v${version}.md`;
  return basePath.endsWith(".md") ? `${basePath.slice(0, -3)}${suffix}` : `${basePath}${suffix}`;
}

/** Copy the base file to `<base>.v<N>.md` (overwrite — the version is unique). */
export function snapshotVersion(basePath: string, version: number): SnapshotResult {
  const snapshotPath = versionedPath(basePath, version);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.copyFileSync(basePath, snapshotPath);
  return { snapshotPath, version };
}

/** `2026-10-20-some-slug.md` → `some-slug` (best-effort; DB only needs a label). */
function slugFromBase(basePath: string): string {
  const name = path.basename(basePath).replace(/^\d{4}-\d{2}-\d{2}-/, "");
  return name.replace(/\.md$/, "");
}

export interface DraftRecordInput {
  accountId: number;
  date: string;
  ok: boolean;
  title?: string | null;
  error?: string | null;
  /** Engine base file (latest content) — adopted as v1 if no row exists yet. */
  articlePath?: string | null;
  /** Idempotent no-op (already published) — nothing was pushed, record nothing. */
  skipped?: boolean;
}

export interface DraftRecordResult {
  articleId?: number;
  draftId?: number;
  createdArticle?: boolean;
}

/**
 * Persist the outcome of a push: `drafts.verified` mirrors the engine's
 * `verifyDraftBody()` verdict (I18) and a verified push flips the article to
 * `pushed`. If the engine generated the article itself (no prior `articles`
 * row), the base file is snapshotted as v1 so the draft is linkable.
 */
export function recordDraftResult(db: Database, input: DraftRecordInput): DraftRecordResult {
  if (input.skipped) return {};

  const latest = listArticles(db, input.accountId, { date: input.date, limit: 1 })[0];
  let article = latest;
  let createdArticle = false;

  if (!article && input.articlePath && fs.existsSync(input.articlePath)) {
    const version = nextVersion(db, input.accountId, input.date);
    const snap = snapshotVersion(input.articlePath, version);
    article = insertArticle(db, {
      accountId: input.accountId,
      date: input.date,
      title: input.title ?? null,
      slug: slugFromBase(input.articlePath),
      filePath: snap.snapshotPath,
      status: "draft",
      version,
      parentId: null,
      feedback: null,
    });
    createdArticle = true;
  }

  if (!article) return {};

  const draft = insertDraft(db, {
    accountId: input.accountId,
    articleId: article.id,
    wechatTitle: input.title ?? article.title ?? null,
    pushAt: new Date().toISOString(),
    verified: input.ok,
    verifyDetail: input.error ?? "ok",
  });
  if (input.ok) setArticleStatus(db, article.id, "pushed");
  return { articleId: article.id, draftId: draft.id, createdArticle };
}

export interface GenerateArticleOptions {
  /** Regeneration feedback appended to the article prompt. */
  feedback?: string;
  /** Predecessor article id (regenerate); NULL/undefined for a fresh v1. */
  parentId?: number | null;
  /** Test seam: fake engine generator. Defaults to the real engine call. */
  runner?: ArticleRunner;
}

export interface GenerateArticleResult {
  ok: boolean;
  date: string;
  articleId?: number;
  version?: number;
  /** Engine base file = the latest content (publish target). */
  articlePath?: string;
  /** Immutable per-version snapshot (`.v<N>.md`). */
  snapshotPath?: string;
  title?: string;
  error?: string;
}

/**
 * Generate one article version for `accountId`/`date` and persist the version
 * chain. `parentId` links a regenerate to the version it replaces.
 */
export async function generateArticle(
  db: Database,
  cfg: AppConfig,
  accountId: number,
  date: string,
  opts: GenerateArticleOptions = {},
): Promise<GenerateArticleResult> {
  const runner = opts.runner ?? runArticleGeneration;
  const res = await runner(cfg, { date, feedback: opts.feedback });
  if (!res.ok) {
    return { ok: false, date, error: res.error ?? "article generation failed" };
  }

  // Allocate the version, snapshot the freshly written base, then commit the row.
  // Single writer per account (I4) + `insertArticle`'s explicit-version floor (I15)
  // keep version numbering monotonic.
  const version = nextVersion(db, accountId, date);
  let snap: SnapshotResult;
  try {
    snap = snapshotVersion(res.articlePath, version);
  } catch (err) {
    return {
      ok: false,
      date,
      error: `snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const row: ArticleRow = insertArticle(db, {
    accountId,
    date,
    title: res.title ?? null,
    slug: slugFromBase(res.articlePath),
    filePath: snap.snapshotPath,
    status: "draft",
    version,
    parentId: opts.parentId ?? null,
    feedback: opts.feedback ?? null,
  });

  return {
    ok: true,
    date,
    articleId: row.id,
    version: row.version,
    articlePath: res.articlePath,
    snapshotPath: snap.snapshotPath,
    title: res.title,
  };
}

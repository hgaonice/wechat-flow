import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmailConfig } from "./mailer.ts";
import { defaultBrowserConfig, type BrowserConfig } from "./browser.ts";

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SRC_DIR, "..");
export const CONFIG_PATH = path.join(APP_DIR, "config.json");

export interface ModelCfg {
  model?: string;
  thinking?: string;
  /** Models tried in order when the primary fails (outage / quota / 5xx). */
  fallbacks?: string[];
}

/** Per-account overrides. Anything omitted falls back to the top-level value. */
export interface AccountCfg {
  alias: string;
  displayName?: string;
  author?: string;
  theme?: string;
  color?: string;
  /** Chrome DevTools port. MUST be unique per account (see browser.ts). */
  cdpPort?: number;
  publishMethod?: "api" | "browser";
  draftOnly?: boolean;
  enabled?: boolean;
  /** Content/prompt overrides when the account has a different subject matter. */
  contentDir?: string;
  promptsDir?: string;
  /** Data root (plans/articles/imgs/state/logs/sessions). Defaults to ./data/<alias>. */
  dataDir?: string;
  /** Per-account LaTeX / manim overrides. */
  math?: { enabled?: boolean; height?: string; scale?: number; color?: string; python?: string };
  manim?: { enabled?: boolean; width?: number; fps?: number; maxMb?: number };
  /** Per-account cover overrides (template/agent + 是否自动上传到草稿). */
  cover?: { mode?: "template" | "ffmpeg" | "agent"; font?: string; uploadToDraft?: boolean };
  /** Notification overrides. */
  subjectPrefix?: string;
  emailTo?: string[];
  model?: { plan?: ModelCfg; article?: ModelCfg };
}

export interface AppConfig {
  /** Alias used on the CLI and passed to the skill (`--account`). */
  account: string;
  accountAlias: string;
  /** Human readable 公众号 name, used in prompts / covers / emails. */
  accountName: string;
  defaultAccount: string;
  /** All aliases declared in config.json (for `--all`). */
  accounts: string[];
  author: string;
  theme: string;
  color?: string;
  publishMethod: "api" | "browser";
  browser: BrowserConfig;
  draftOnly: boolean;

  piBin: string;
  bunBin: string;
  skillDir: string;
  noSession: boolean;
  sessionDir: string;

  timeoutSec: { plan: number; article: number };

  model: { plan: ModelCfg; article: ModelCfg };

  cover: { mode: "template" | "ffmpeg" | "agent"; font?: string; uploadToDraft?: boolean };

  /** LaTeX 公式（$...$ / $$...$$）在发布前转内联 SVG。 */
  math: {
    enabled: boolean;
    height: string;
    scale: number;
    color?: string;
    python: string;
    script: string;
    manimScript: string;
  };

  /** 可选的 manim 场景：data/<alias>/imgs/<date>/scene.py -> scene.gif */
  manim: {
    enabled: boolean;
    width: number;
    fps: number;
    maxMb: number;
  };

  notify: {
    enabled: boolean;
    telegram?: { botToken?: string; chatId?: string };
    email?: EmailConfig;
  };

  proxy?: { httpProxy?: string; httpsProxy?: string; noProxy?: string };

  paths: {
    data: string;
    content: string;
    prompts: string;
    plans: string;
    articles: string;
    imgs: string;
    state: string;
    logs: string;
    formula: string;
  };
}

function envOr(v: string | undefined, fallback: string): string {
  return v && v.length > 0 ? v : fallback;
}

function readRawConfig(): any {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[config] ${CONFIG_PATH} not found, using built-in defaults`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`[config] ${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Normalise the `accounts` block. Legacy single-account configs (top-level
 * `account` / `accountName`) are auto-upgraded to a one-entry map.
 */
function normalizeAccounts(raw: any): Record<string, AccountCfg> {
  const out: Record<string, AccountCfg> = {};
  const src = raw.accounts;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [alias, v] of Object.entries<any>(src ?? {})) {
      if (!alias) continue;
      out[alias] = { ...(v ?? {}), alias };
    }
  } else if (Array.isArray(src)) {
    // Also accept a list form: [{ alias, ... }]
    for (const v of src as any[]) {
      if (!v?.alias) continue;
      out[v.alias] = { ...v };
    }
  }
  if (Object.keys(out).length === 0) {
    const alias = envOr(raw.account, "second");
    out[alias] = {
      alias,
      displayName: raw.accountName,
      author: raw.author,
      theme: raw.theme,
      color: raw.color,
    };
  }
  return out;
}

export function defaultAlias(raw: any = readRawConfig()): string {
  const accounts = normalizeAccounts(raw);
  const explicit = envOr(raw.defaultAccount, envOr(raw.account, ""));
  if (explicit && accounts[explicit]) return explicit;
  for (const [alias, a] of Object.entries(accounts)) if (a.enabled === true) return alias;
  const def = Object.entries(accounts).find(([, a]) => (a as any).default === true);
  if (def) return def[0];
  return Object.keys(accounts)[0]!;
}

export interface AccountInfo {
  alias: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  dataDir: string;
}

const resolveFrom = (p: string) => (path.isAbsolute(p) ? p : path.resolve(APP_DIR, p));

/** All declared accounts (for `--all`, `status`, `accounts` listing). */
export function listAccounts(): AccountInfo[] {
  const raw = readRawConfig();
  const accounts = normalizeAccounts(raw);
  const def = defaultAlias(raw);
  return Object.entries(accounts).map(([alias, a]) => ({
    alias,
    displayName: a.displayName ?? a.author ?? alias,
    // disabled by default only when explicitly false; the default account is always on
    enabled: alias === def ? a.enabled !== false : a.enabled === true,
    isDefault: alias === def,
    dataDir: resolveFrom(a.dataDir ?? `./data/${alias}`),
  }));
}

/**
 * Resolve the effective config for one account from an in-memory raw config.
 *
 * Precedence: explicit argument > MW_ACCOUNT env > config.defaultAccount > first account.
 * Every path is rooted at the account's own data dir so two accounts never share
 * plans / articles / state / logs.
 *
 * This is the pure core of `loadConfig()`. The console rebuilds `raw` from its DB
 * (src/console/config/resolve.ts) and calls this same function, so DB-derived and
 * file-derived configs are field-for-field identical (AC-3).
 */
export function resolveConfig(raw: any, accountAlias?: string): AppConfig {
  const accounts = normalizeAccounts(raw);
  const def = defaultAlias(raw);
  const requested = accountAlias ?? process.env.MW_ACCOUNT ?? def;

  const acct = accounts[requested];
  if (!acct) {
    const known = Object.keys(accounts).join(", ");
    throw new Error(`unknown account "${requested}" (available: ${known}; default: ${def})`);
  }

  const notifyRaw = raw.notify ?? {};
  const emailRaw = notifyRaw.email;
  const hasChannel = Boolean(
    notifyRaw.telegram?.chatId || emailRaw?.enabled === true || emailRaw?.to?.length,
  );

  const data = resolveFrom(acct.dataDir ?? `./data/${acct.alias}`);
  const pickModel = (kind: "plan" | "article"): ModelCfg =>
    acct.model?.[kind] ?? raw.model?.[kind] ?? (kind === "plan" ? { thinking: "high" } : { thinking: "medium" });

  const cfg: AppConfig = {
    account: acct.alias,
    accountAlias: acct.alias,
    accountName: envOr(acct.displayName ?? raw.accountName, acct.alias),
    defaultAccount: def,
    accounts: Object.keys(accounts),
    author: envOr(acct.author ?? raw.author, envOr(acct.displayName ?? raw.accountName, acct.alias)),
    theme: envOr(acct.theme ?? raw.theme, "default"),
    color: acct.color ?? raw.color,
    publishMethod: (acct.publishMethod ?? raw.publishMethod) === "browser" ? "browser" : "api",
    browser: {
      ...defaultBrowserConfig(),
      ...(raw.browser ?? {}),
      // Per-account port is what keeps two logged-in accounts from cross-talking.
      cdpPort: acct.cdpPort ?? raw.browser?.cdpPort ?? defaultBrowserConfig().cdpPort,
    },
    draftOnly: (acct.draftOnly ?? raw.draftOnly) !== false,

    piBin: envOr(raw.piBin, "pi"),
    bunBin: envOr(raw.bunBin, "bun"),
    skillDir: envOr(raw.skillDir, "/root/.agents/skills/baoyu-post-to-wechat"),
    noSession: raw.noSession !== false,
    sessionDir: path.join(data, "sessions"),

    timeoutSec: {
      plan: raw.timeoutSec?.plan ?? 1200,
      article: raw.timeoutSec?.article ?? 1800,
    },

    model: { plan: pickModel("plan"), article: pickModel("article") },

    cover: {
      // mode: "template"=ImageMagick（默认）； "ffmpeg"=lavfi+drawtext（无 ImageMagick 的机器）；
      // "agent"=由写作 agent 自行产出封面。账号级 cover.mode 可覆盖全局。
      mode: (acct.cover?.mode ?? raw.cover?.mode) ?? "template",
      font: acct.cover?.font ?? raw.cover?.font,
      // 浏览器方式发布后，用 CDP 把 imgs/<date>/cover.png 设成草稿封面（O-B）。
      // 默认关闭：需先在 250 上跑 `cover --probe` 定准选择器，再置 true。失败不影响发布。
      // 按叶子回退：账号级 cover 只写了 mode 时，uploadToDraft 仍应继承全局值
      // （否则给账号加 cover.mode 会静默关掉封面自动上传）。
      uploadToDraft: (acct.cover?.uploadToDraft ?? raw.cover?.uploadToDraft) === true,
    },

    math: {
      enabled: (acct.math ?? raw.math)?.enabled === true,
      height: (acct.math ?? raw.math)?.height ?? "1.5em",
      scale: (acct.math ?? raw.math)?.scale ?? 1,
      color: (acct.math ?? raw.math)?.color,
      python: envOr((acct.math ?? raw.math)?.python, "python3"),
      script: path.join(APP_DIR, "bin", "tex2svg.py"),
      manimScript: path.join(APP_DIR, "bin", "manim-gif.sh"),
    },

    manim: {
      enabled: (acct.manim ?? raw.manim)?.enabled === true,
      width: (acct.manim ?? raw.manim)?.width ?? 720,
      fps: (acct.manim ?? raw.manim)?.fps ?? 12,
      maxMb: (acct.manim ?? raw.manim)?.maxMb ?? 2,
    },

    notify: {
      enabled: notifyRaw.enabled === undefined ? hasChannel : notifyRaw.enabled === true,
      telegram: {
        botToken: notifyRaw.telegram?.botToken ?? process.env.TELEGRAM_BOT_TOKEN,
        chatId: notifyRaw.telegram?.chatId,
      },
      email: emailRaw
        ? {
            enabled: emailRaw.enabled !== false,
            on: emailRaw.on ?? "publish",
            to: acct.emailTo ?? emailRaw.to ?? [],
            subjectPrefix: acct.subjectPrefix ?? emailRaw.subjectPrefix ?? "",
            attachArticle: emailRaw.attachArticle !== false,
            // 主机本地凭据备注（0600，不进 git），发布后邮件自动附带账号信息块。
            credentialsNotePath: emailRaw.credentialsNotePath,
            skill: {
              dir: emailRaw.skill?.dir ?? "/root/.claude/skills/email-sender",
              python: emailRaw.skill?.python ?? "python3",
            },
          }
        : undefined,
    },

    proxy: raw.proxy,

    paths: {
      data,
      content: resolveFrom(acct.contentDir ?? "./content"),
      prompts: resolveFrom(acct.promptsDir ?? "./prompts"),
      plans: path.join(data, "plans"),
      articles: path.join(data, "articles"),
      imgs: path.join(data, "imgs"),
      state: path.join(data, "state"),
      logs: path.join(data, "logs"),
      formula: path.join(data, "imgs", "formula"),
    },
  };

  return cfg;
}

/** Load `config.json` and resolve the effective config for one account. */
export function loadConfig(accountAlias?: string): AppConfig {
  return resolveConfig(readRawConfig(), accountAlias);
}

export function ensureDirs(cfg: AppConfig): void {
  const dirs = [
    cfg.paths.data,
    cfg.paths.content,
    cfg.paths.plans,
    cfg.paths.articles,
    cfg.paths.imgs,
    cfg.paths.state,
    cfg.paths.logs,
    cfg.paths.formula,
    cfg.sessionDir,
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

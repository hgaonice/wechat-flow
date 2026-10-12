import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";
import { ensureBrowser, type BrowserConfig } from "./browser.ts";

/** Deterministic publisher: drives the baoyu-post-to-wechat skill script via bun. */

export interface PublishOptions {
  file: string;
  cwd: string;
  bunBin?: string;
  skillDir: string;
  account?: string;
  theme?: string;
  color?: string;
  cover?: string;
  title?: string;
  author?: string;
  summary?: string;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
}

export interface PublishResult {
  ok: boolean;
  mediaId?: string;
  title?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export async function publishArticle(opts: PublishOptions): Promise<PublishResult> {
  const script = path.join(opts.skillDir, "scripts", "wechat-api.ts");
  const args: string[] = [script, opts.file];
  if (opts.theme) args.push("--theme", opts.theme);
  if (opts.color) args.push("--color", opts.color);
  if (opts.account) args.push("--account", opts.account);
  if (opts.cover) args.push("--cover", opts.cover);
  if (opts.title) args.push("--title", opts.title);
  if (opts.author) args.push("--author", opts.author);
  if (opts.summary) args.push("--summary", opts.summary);
  if (opts.dryRun) args.push("--dry-run");

  const bin = opts.bunBin ?? "bun";
  log.info(`publish: ${bin} ${args.join(" ")}`);

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (stdout += c));
  child.stderr.on("data", (c: string) => (stderr += c));

  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}\n`;
      resolve({ code: null });
    });
    child.on("close", (c) => resolve({ code: c }));
  });

  let mediaId: string | undefined;
  let title: string | undefined;
  if (stdout.trim()) {
    // The script prints a single JSON object on stdout on success.
    const match = stdout.match(/\{[\s\S]*\}\s*$/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        mediaId = parsed.media_id;
        title = parsed.title;
      } catch {
        /* ignore */
      }
    }
  }

  const ok = code === 0 && (opts.dryRun ? true : Boolean(mediaId));
  if (!ok) log.error(`publish failed (exit ${code})`, stderr.slice(-800));
  return { ok, mediaId, title, stdout, stderr, exitCode: code, error: ok ? undefined : stderr.slice(-500) };
}

/* ------------------------------------------------------------------ *
 * Browser (Chrome CDP) publishing — used when the API is IP-blocked.
 * ------------------------------------------------------------------ */

export interface BrowserPublishOptions {
  file: string;
  cwd: string;
  skillDir: string;
  browser: BrowserConfig;
  bunBin?: string;
  account?: string;
  theme?: string;
  color?: string;
  title?: string;
  author?: string;
  summary?: string;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
}

export async function publishArticleBrowser(opts: BrowserPublishOptions): Promise<PublishResult> {
  const bin = opts.bunBin ?? "bun";
  const scriptsDir = path.join(opts.skillDir, "scripts");

  // dry-run = validate markdown→wechat conversion only (no Chrome, no publish).
  if (opts.dryRun) {
    const conv = path.join(scriptsDir, "md-to-wechat.ts");
    const args = [conv, opts.file];
    if (opts.theme) args.push("--theme", opts.theme);
    if (opts.color) args.push("--color", opts.color);
    log.info(`browser dry-run: ${bin} ${args.join(" ")}`);
    const r = await runChild(bin, args, opts.cwd, opts.env);
    const ok = r.code === 0;
    if (!ok) log.error(`browser dry-run conversion failed (exit ${r.code})`, r.stderr.slice(-500));
    return { ok, stdout: r.stdout, stderr: r.stderr, exitCode: r.code, error: ok ? undefined : r.stderr.slice(-500) };
  }

  await ensureBrowser(opts.browser, opts.account ?? "default");

  const script = path.join(scriptsDir, "wechat-article.ts");
  const args: string[] = [script, "--markdown", opts.file];
  if (opts.theme) args.push("--theme", opts.theme);
  if (opts.color) args.push("--color", opts.color);
  if (opts.account) args.push("--account", opts.account);
  if (opts.title) args.push("--title", opts.title);
  if (opts.author) args.push("--author", opts.author);
  if (opts.summary) args.push("--summary", opts.summary);
  args.push("--cdp-port", String(opts.browser.cdpPort));

  log.info(`browser publish: DISPLAY=${opts.browser.display} ${bin} ${args.join(" ")}`);
  const r = await runChild(bin, args, opts.cwd, {
    ...opts.env,
    DISPLAY: opts.browser.display,
    WECHAT_BROWSER_DEBUG_PORT: String(opts.browser.cdpPort),
  });

  const saved = /Draft saved successfully/i.test(r.stdout);
  const waiting = /Waiting for save confirmation/i.test(r.stdout);
  const emptyBody = /Body content verification failed/i.test(r.stdout) || /editor appears empty/i.test(r.stdout);
  // The skill clicks "save as draft"; whether the toast was observed is unreliable,
  // so accept "saved or waiting" here and let verifyDraftPublished() be authoritative.
  const ok = r.code === 0 && !emptyBody && (saved || waiting);
  if (!ok) {
    log.error(`browser publish failed (exit ${r.code}, saved=${saved}, waiting=${waiting}, emptyBody=${emptyBody})`, r.stderr.slice(-800));
  }
  // The browser method does not return a media_id; the draft lands in 草稿箱.
  return {
    ok,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.code,
    error: ok ? undefined : `${emptyBody ? "body verification failed; " : ""}${(r.stderr || r.stdout).slice(-500)}`,
  };
}

function normTitle(s: string): string {
  return s.replace(/[\s\u00a0\u3000]+/g, "").replace(/[，。！？、：；"'（）()【】\[\]·—\-!?.,:;]/g, "");
}

/**
 * Read the account's draft titles straight from the MP backend via CDP
 * (inside the logged-in page, so cookies apply).
 *
 * NOTE: on the "new" editor the drafts live under `type=77`; older accounts use
 * `type=10`. We query both and union the results. Returns null if we could not
 * query at all (so callers can fall back to the skill's own signal).
 */
export interface DraftItem {
  appmsgid: number;
  title: string;
  /** `type=77` on the new editor, `type=10` on older accounts. */
  type: number;
}

interface MpSession {
  cdp: any;
  sess: { sessionId: string };
  token: string;
}

/**
 * Attach to the logged-in mp.weixin.qq.com tab over CDP and read the page
 * token. Callers MUST close `cdp` when done.
 */
async function openMpSession(browser: BrowserConfig, skillDir: string): Promise<MpSession> {
  const cdpMod: any = await import(path.join(skillDir, "scripts", "cdp.ts"));
  const ws = await cdpMod.waitForChromeDebugPort(browser.cdpPort, 15_000);
  const cdp = await cdpMod.CdpConnection.connect(ws, 15_000);
  try {
    const targets = await cdp.send("Target.getTargets");
    const tabs = targets.targetInfos.filter(
      (t: any) => t.type === "page" && t.url.includes("mp.weixin.qq.com/cgi-bin"),
    );
    const tab = tabs.find((t: any) => /token=\d+/.test(t.url)) ?? tabs[0];
    if (!tab) throw new Error("no logged-in mp.weixin.qq.com tab found");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    const sess = { sessionId };
    const tokenRes = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(function(){var m=location.href.match(/token=(\\d+)/);if(m)return m[1];var h=document.documentElement.innerHTML.match(/token=(\\d+)/);return h?h[1]:"";})()`,
        returnByValue: true,
      },
      sess,
    );
    const token = String(tokenRes.result.value || "");
    if (!token) throw new Error("could not read mp token from page");
    return { cdp, sess, token };
  } catch (err) {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Query the MP draft list (union of `type=77` and `type=10`). */
async function fetchDrafts(mp: MpSession, count = 50): Promise<DraftItem[]> {
  const out: DraftItem[] = [];
  for (const type of [77, 10]) {
    const r = await mp.cdp.send(
      "Runtime.evaluate",
      {
        expression: `fetch("/cgi-bin/appmsg?token=${mp.token}&lang=zh_CN&f=json&ajax=1&action=list_ex&begin=0&count=${count}&type=${type}&query=&fakeid=&sub=&search_field=null&sort=").then(r=>r.text())`,
        returnByValue: true,
        awaitPromise: true,
      },
      mp.sess,
    );
    try {
      const d = JSON.parse(String(r.result.value || "{}"));
      for (const x of d.app_msg_list || []) {
        if (x?.title) out.push({ appmsgid: Number(x.appmsgid), title: String(x.title), type });
      }
    } catch {
      /* ignore malformed response */
    }
  }
  return out;
}

/**
 * Read the account's draft titles straight from the MP backend via CDP
 * (inside the logged-in page, so cookies apply). Returns null if the backend
 * could not be queried at all (so callers can fall back to the skill signal).
 */
export async function listDraftTitles(browser: BrowserConfig, skillDir: string): Promise<string[] | null> {
  const drafts = await listDrafts(browser, skillDir);
  return drafts === null ? null : drafts.map((d) => d.title);
}

/** Like listDraftTitles, but keeps the appmsgid (needed to open the editor). */
export async function listDrafts(browser: BrowserConfig, skillDir: string): Promise<DraftItem[] | null> {
  let mp: MpSession;
  try {
    mp = await openMpSession(browser, skillDir);
  } catch (err) {
    log.warn(`listDrafts failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  try {
    return await fetchDrafts(mp);
  } catch (err) {
    log.warn(`listDrafts failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    try {
      mp.cdp.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Authoritatively confirm that a draft whose title matches `title` exists.
 * Returns true / false, or null if the backend could not be queried.
 */
export async function verifyDraftPublished(
  browser: BrowserConfig,
  skillDir: string,
  title: string,
  tries = 4,
): Promise<boolean | null> {
  const want = normTitle(title);
  let titles: string[] | null = null;
  for (let i = 0; i < tries; i++) {
    titles = await listDraftTitles(browser, skillDir);
    if (titles === null) return null;
    if (titles.some((t) => normTitle(t) === want || normTitle(t).startsWith(want.slice(0, 14)))) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * The guard that actually matters.
 *
 * A draft can sit in 草稿箱 with a correct title and an EMPTY body — that is
 * exactly what the upstream `wechat-article.ts` produced: it focused the
 * TITLE's ProseMirror node (the first `.ProseMirror` on the page) and then its
 * own "is the editor non-empty?" check matched the title text. Title-level
 * verification therefore proves nothing at all.
 *
 * This opens the draft editor and measures the real body text. Deliberately
 * paranoid: it strips the "从这里开始写正文" placeholder (present, 10 chars, even
 * when the body is empty) and demands a decent amount of content.
 */
export async function verifyDraftBody(
  browser: BrowserConfig,
  skillDir: string,
  title: string,
  opts: { minChars?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean | null; bodyLen?: number; detail: string }> {
  // minChars 是「内容量」下限，不是纯文字数：公式会被渲染成内联 SVG（0 个文字），
  // 所以用 text + 每个 svg/img 折算 80 的加权值来衡量，否则数学文章会被误判为空正文。
  const minChars = opts.minChars ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let mp: MpSession;
  try {
    mp = await openMpSession(browser, skillDir);
  } catch (err) {
    const detail = `mp session unavailable: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(detail);
    return { ok: null, detail };
  }

  let targetId: string | undefined;
  try {
    const want = normTitle(title);
    const drafts = await fetchDrafts(mp);
    const hit = drafts.find(
      (d) => normTitle(d.title) === want || (want.length > 8 && normTitle(d.title).startsWith(want.slice(0, 14))),
    );
    if (!hit) return { ok: false, bodyLen: 0, detail: "draft not found in 草稿箱" };

    const url =
      `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=${hit.type}` +
      `&appmsgid=${hit.appmsgid}&itemidx=1&token=${mp.token}&lang=zh_CN`;
    const created = await mp.cdp.send("Target.createTarget", { url });
    targetId = created.targetId;
    const at = await mp.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const s2 = { sessionId: at.sessionId };

    let bodyLen = -1;
    let snippet = "";
    let svgCount = 0;
    let imgCount = 0;
    const deadline = Date.now() + timeoutMs;
    const MIN_TEXT = 60; // 至少得有一句话，防止「全是图没正文」
    const weight = () => bodyLen + 80 * svgCount + 80 * imgCount;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await mp.cdp.send("Runtime.evaluate", { expression: BODY_PROBE, returnByValue: true }, s2);
      try {
        const j = JSON.parse(String(r.result.value || "{}"));
        if (typeof j.len === "number" && j.len >= 0) {
          bodyLen = j.len;
          snippet = String(j.head || "");
          svgCount = Number(j.svg || 0);
          imgCount = Number(j.img || 0);
          if (bodyLen >= MIN_TEXT && weight() >= minChars) break;
        }
      } catch {
        /* editor not ready yet */
      }
    }

    const media = svgCount || imgCount ? `, svg=${svgCount}, img=${imgCount}, 折算内容量=${weight()}` : "";
    const detail = `body=${bodyLen} chars${media}${snippet ? ` («${snippet}»)` : ""} (min ${minChars})`;
    const ok = bodyLen >= MIN_TEXT && weight() >= minChars;
    if (ok) log.info(`draft body verified: ${detail}`);
    else log.error(`draft body too short: ${detail}`);
    return { ok, bodyLen, detail };
  } catch (err) {
    const detail = `body verification failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(detail);
    return { ok: null, detail };
  } finally {
    if (targetId) {
      try {
        await mp.cdp.send("Target.closeTarget", { targetId });
      } catch {
        /* ignore */
      }
    }
    try {
      mp.cdp.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Runs inside the draft editor page. Note `#js_editor` also contains the title,
 * so we read the body container only — and strip the "从这里开始写正文"
 * placeholder, which is present even when the body is empty.
 */
const BODY_PROBE = `(function(){
  var e = document.querySelector('.rich_media_content .ProseMirror');
  if (!e) return JSON.stringify({ len: -1 });
  var t = (e.innerText || '').replace(/从这里开始写正文/g, '').trim();
  return JSON.stringify({ len: t.length, html: (e.innerHTML || '').length,
    svg: e.querySelectorAll('svg').length, img: e.querySelectorAll('img').length,
    head: t.replace(/\\s+/g, ' ').slice(0, 60) });
})()`;

/**
 * Close leftover WeChat editor/list tabs so long-running Chrome does not
 * accumulate one tab per published article (the skill intentionally leaves the
 * editor window open). Only tabs under /cgi-bin/appmsg are closed; the home tab
 * that carries the login session is kept.
 */
export async function cleanupAppmsgTabs(browser: BrowserConfig, skillDir: string): Promise<number> {
  const cdpMod: any = await import(path.join(skillDir, "scripts", "cdp.ts"));
  let cdp: any;
  try {
    const ws = await cdpMod.waitForChromeDebugPort(browser.cdpPort, 10_000);
    cdp = await cdpMod.CdpConnection.connect(ws, 10_000);
  } catch {
    return 0;
  }
  try {
    const targets = await cdp.send("Target.getTargets");
    const stale = targets.targetInfos.filter(
      (t: any) => t.type === "page" && t.url.includes("/cgi-bin/appmsg"),
    );
    for (const t of stale) {
      try {
        await cdp.send("Target.closeTarget", { targetId: t.targetId });
      } catch {
        /* ignore */
      }
    }
    return stale.length;
  } catch {
    return 0;
  } finally {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Draft cover (O-B): drive the editor's cover dialog over CDP.
 *
 * The skill's browser publish path saves the BODY only (see research.md:
 * `Default cover fallback (imgs/cover.png)` is ✗ for Article(Browser)). So we
 * set the cover ourselves, on the same logged-in CDP session, AFTER the body
 * has been verified. Everything goes through mp.weixin.qq.com (cookies/token),
 * never api.weixin.qq.com, so the IP whitelist does not apply.
 *
 * The real cover-dialog DOM cannot be observed from a dev machine, so every
 * step tries a list of candidate selectors plus a text fallback, and any
 * failure degrades gracefully — it must NEVER break the body publish.
 * ------------------------------------------------------------------ */

export interface SetCoverOptions {
  browser: BrowserConfig;
  skillDir: string;
  title: string;
  coverPath: string;
  timeoutMs?: number;
  /** `--explore`: click through the cover popover and snapshot each step (diagnostic). */
  explore?: boolean;
}

/** `ok:true` = cover set & verified; `false` = attempted but failed; `null` = could not try. */
export interface CoverResult {
  ok: boolean | null;
  detail: string;
  /** Which step we reached: session|locate|editor|open-cover|file-input|upload|confirm|verify|save|probe. */
  stage?: string;
}

/**
 * Ordered candidate selectors for each step. Tune these after running
 * `bun src/cli.ts cover --date <d> --probe` on the target machine.
 */
const COVER_SELECTORS = {
  entry: [
    "#js_cover_area", ".select-cover__btn.js_cover_btn_area", ".js_cover_btn_area",
    "#js_cover_preview", ".js_cover_preview_new", ".js_cover_preview",
    ".appmsg_cover .js_cover",
  ],
  /** 「从图片库选择」— opens the「选择图片」dialog which owns the upload input. */
  library: [".js_imagedialog", "a.js_imagedialog", ".js_cover_opr .js_imagedialog", ".cover-hover-link-group .js_imagedialog"],
  confirm: [
    ".weui-desktop-dialog__footer .weui-desktop-btn_primary",
    ".weui-desktop-dialog .js_dialog_confirm",
    ".weui-desktop-dialog .weui-desktop-btn_primary",
  ],
  save: ["#js_submit", ".js_submit", "a.js_submit"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Small page-side helpers shared by every injected expression. */
const COVER_HELP = `
  var vis=function(e){if(!e)return false;var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;var s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';};
  var pick=function(sels){for(var i=0;i<sels.length;i++){var ns;try{ns=document.querySelectorAll(sels[i]);}catch(e){continue;}for(var j=0;j<ns.length;j++){if(vis(ns[j]))return {el:ns[j],sel:sels[i]};}}return null;};
  var clickText=function(words){var a=document.querySelectorAll('a,button,div,span,li');for(var i=0;i<a.length;i++){var t=(a[i].innerText||'').trim();if(t&&t.length<=12&&words.indexOf(t)>=0&&vis(a[i])){a[i].click();return t;}}return null;};
`;

const COVER_READY_EXPR = `(function(){var e=document.querySelector('.rich_media_content .ProseMirror')||document.querySelector('#js_editor');return JSON.stringify({ready:!!e});})()`;

const COVER_OPEN_EXPR = `(function(){${COVER_HELP}
  var hit=pick(${JSON.stringify(COVER_SELECTORS.entry)});
  if(hit){try{hit.el.scrollIntoView({block:'center'});}catch(e){}hit.el.click();return JSON.stringify({clicked:true,sel:hit.sel,text:(hit.el.innerText||'').replace(/\\s+/g,' ').slice(0,30)});}
  var t=clickText(['封面','设置封面','封面和摘要','封面图','选择封面','编辑封面']);
  if(t)return JSON.stringify({clicked:true,sel:'text:'+t});
  return JSON.stringify({clicked:false});
})()`;

const COVER_DIALOG_READY_EXPR = `(function(){var ds=document.querySelectorAll('.weui-desktop-dialog');for(var i=0;i<ds.length;i++){var r=ds[i].getBoundingClientRect();if(r.width>0&&r.height>0&&ds[i].querySelector('input[type=file]'))return JSON.stringify({ready:true});}return JSON.stringify({ready:false});})()`;

const COVER_DIALOG_CONFIRM_EXPR = `(function(){${COVER_HELP}
  var words=['下一步','确定','确认','完成','使用'];
  var ds=document.querySelectorAll('.weui-desktop-dialog');
  for(var i=ds.length-1;i>=0;i--){
    var d=ds[i]; if(!vis(d))continue;
    var btn=d.querySelector('.weui-desktop-btn_primary,.js_dialog_confirm');
    if(btn&&vis(btn)){btn.click();return JSON.stringify({clicked:true,sel:'dialog-primary',text:(btn.innerText||'').trim().slice(0,8)});}
    var cand=d.querySelectorAll('button,a,span');
    for(var j=0;j<cand.length;j++){var t=(cand[j].innerText||'').trim();if(t&&words.indexOf(t)>=0&&vis(cand[j])){cand[j].click();return JSON.stringify({clicked:true,sel:'dialog-text',text:t});}}
  }
  return JSON.stringify({clicked:false});
})()`;

/** Ready when the uploaded image is selected AND the「下一步」button is enabled. */
const COVER_PICKER_READY_EXPR = `(function(){${COVER_HELP}
  var sel=document.querySelector('.weui-desktop-img-picker__item.selected,.image_dialog__checkbox.selected');
  var next=null;var bs=document.querySelectorAll('.weui-desktop-dialog button');
  for(var i=0;i<bs.length;i++){if(((bs[i].innerText||'').trim())==='下一步'){next=bs[i];break;}}
  var enabled=!!next&&next.disabled!==true&&!/disabled/.test(''+next.className)&&vis(next);
  return JSON.stringify({selected:!!sel,nextEnabled:!!enabled,ready:!!sel&&!!enabled});
})()`;

/** Click the enabled「下一步」in the 选择图片 dialog. */
const COVER_NEXT_EXPR = `(function(){${COVER_HELP}
  var bs=document.querySelectorAll('.weui-desktop-dialog button,.weui-desktop-dialog a.weui-desktop-btn');
  for(var i=0;i<bs.length;i++){var t=(bs[i].innerText||'').trim();if((t==='下一步'||t==='下页')&&vis(bs[i])&&bs[i].disabled!==true&&!/disabled/.test(''+bs[i].className)){bs[i].click();return JSON.stringify({clicked:true,text:t});}}
  return JSON.stringify({clicked:false});
})()`;

/** Ready when the「编辑封面」(crop/confirm) dialog is visible. */
const COVER_EDIT_READY_EXPR = `(function(){var ds=document.querySelectorAll('.weui-desktop-dialog');for(var i=0;i<ds.length;i++){var hd=ds[i].querySelector('.weui-desktop-dialog__title,.weui-desktop-dialog__hd');var t=hd?(hd.innerText||''):'';if(/编辑封面|封面/.test(t)&&ds[i].getBoundingClientRect().width>0)return JSON.stringify({ready:true,title:t.replace(/\\s+/g,' ').slice(0,20)});}return JSON.stringify({ready:false});})()`;

/** Click the「确认」button inside the「编辑封面」dialog. */
const COVER_EDIT_CONFIRM_EXPR = `(function(){${COVER_HELP}
  var ds=document.querySelectorAll('.weui-desktop-dialog');var info=[];
  for(var i=ds.length-1;i>=0;i--){var d=ds[i];if(!vis(d))continue;
    var hd=d.querySelector('.weui-desktop-dialog__title,.weui-desktop-dialog__hd');var t=hd?(hd.innerText||''):'';
    var bs=d.querySelectorAll('button,a.weui-desktop-btn');
    var texts=[];for(var k=0;k<bs.length;k++){var z=(bs[k].innerText||'').trim();if(z&&z.length<=8&&vis(bs[k]))texts.push(z);}
    info.push({title:t.replace(/\\s+/g,' ').slice(0,16),texts:texts});
    if(!/封面/.test(t))continue;
    for(var j=0;j<bs.length;j++){var x=(bs[j].innerText||'').trim();if((x==='确认'||x==='确定'||x==='完成')&&vis(bs[j])){bs[j].click();return JSON.stringify({clicked:true,text:x});}}
    var prim=d.querySelector('.weui-desktop-btn_primary');if(prim&&vis(prim)){prim.click();return JSON.stringify({clicked:true,text:'primary'});}
  }
  return JSON.stringify({clicked:false,dialogs:info});
})()`;

const COVER_SAVE_EXPR = `(function(){${COVER_HELP}
  var s=document.querySelector('#js_submit');
  var b=s?s.querySelector('button'):null;
  if(b){b.click();return JSON.stringify({clicked:true,sel:'#js_submit button',text:(s.innerText||'').trim().slice(0,10)});}
  var hit=pick(${JSON.stringify(COVER_SELECTORS.save)});
  if(hit){hit.el.click();return JSON.stringify({clicked:true,sel:hit.sel});}
  var t=clickText(['保存为草稿','保存']);
  if(t)return JSON.stringify({clicked:true,sel:'text:'+t});
  return JSON.stringify({clicked:false});
})()`;

/** Save-in-progress probe: `#js_submit` shows `btn_loading` / its button is disabled. */
const COVER_SAVE_STATE_EXPR = `(function(){var s=document.querySelector('#js_submit');var b=s?s.querySelector('button'):null;return JSON.stringify({loading:!!(s&&s.classList.contains('btn_loading'))||!!(b&&b.disabled),text:s?(s.innerText||'').trim().slice(0,10):''});})()`;

/** Reads the current cover widget state (used for before/after comparison). */
const COVER_STATE_EXPR = `(function(){${COVER_HELP}
  var pv=document.querySelector('.js_cover_preview_new,.select-cover__preview,.js_cover_preview_square');
  var bg='';try{bg=pv?getComputedStyle(pv).backgroundImage:'';}catch(e){}
  var img=document.querySelector('.js_cover_preview_new img,.select-cover__preview img,#js_cover_area img');
  var src=img?(img.getAttribute('src')||''):'';
  var url=(bg.match(/url\\(["']?([^"')]+)/)||[])[1]||'';
  var hasBg=!!url&&url.indexOf('data:')!==0;
  return JSON.stringify({hasEntry:!!document.querySelector('#js_cover_area,.js_cover_btn_area')||!!pv,imgSrc:src.slice(0,140),bg:url.slice(0,140),ok:hasBg||(!!src&&src.indexOf('data:')!==0)});
})()`;

/** Snapshot of dialogs / popovers / file inputs — used by `--explore` at each step. */
const COVER_SNAPSHOT_EXPR = `(function(){${COVER_HELP}
  var chain=function(e){var out=[];var p=e;for(var i=0;i<6&&p;i++){var c=(''+p.className).trim().split(/\\s+/).slice(0,3).join('.');out.push(p.tagName+(p.id?'#'+p.id:'')+(c?'.'+c:''));p=p.parentElement;}return out;};
  var inputs=[];var fs=document.querySelectorAll('input[type=file]');
  for(var i=0;i<fs.length;i++){inputs.push({accept:(fs[i].getAttribute('accept')||'').slice(0,40),id:fs[i].id||'',cls:(''+fs[i].className).slice(0,40),vis:vis(fs[i]),chain:chain(fs[i])});}
  var dialogs=[];var dl=document.querySelectorAll('.weui-desktop-dialog');
  for(var j=0;j<dl.length;j++){if(!vis(dl[j]))continue;var tt=dl[j].querySelector('.weui-desktop-dialog__title,.weui-desktop-dialog__hd');dialogs.push({title:(tt?tt.innerText:'').replace(/\\s+/g,' ').slice(0,20),cls:(''+dl[j].className).slice(0,60),inputs:dl[j].querySelectorAll('input[type=file]').length});}
  var btns=[];var bs=document.querySelectorAll('.weui-desktop-dialog a,.weui-desktop-dialog button,.weui-desktop-dialog span');
  for(var k=0;k<bs.length&&btns.length<25;k++){var t=(bs[k].innerText||'').trim();if(t&&t.length<=10&&vis(bs[k]))btns.push({tag:bs[k].tagName,cls:(''+bs[k].className).slice(0,30),txt:t});}
  var pv=document.querySelector('.js_cover_preview_new img,.js_cover_preview_square img');
  var pop=document.querySelector('.js_cover_opr');var popWrap=document.querySelector('.js_chooseCoverWrap');
  return JSON.stringify({coverSrc:pv?(pv.getAttribute('src')||'').slice(0,90):'',popOverVisible:pop?vis(pop):false,popWrapVisible:popWrap?vis(popWrap):false,inputs:inputs,dialogs:dialogs,buttons:btns,bodyLen:(document.body?document.body.innerHTML.length:0),elCount:document.querySelectorAll('*').length});
})()`;

/** Click the cover popover's「从图片库选择」(works even while the popover is hidden). */
const COVER_LIBRARY_EXPR = `(function(){${COVER_HELP}
  var sels=['.js_imagedialog','a.js_imagedialog','.js_cover_opr .js_imagedialog','.cover-hover-link-group .js_imagedialog'];
  for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);if(ns.length){try{ns[0].click();}catch(e){}return JSON.stringify({clicked:true,sel:sels[i]});}}
  var t=clickText(['从图片库选择','图片库']);
  if(t)return JSON.stringify({clicked:true,sel:'text:'+t});
  return JSON.stringify({clicked:false});
})()`;

/** Read-only: dump everything needed to fix the selectors on a real machine. */
const COVER_DUMP_EXPR = `(function(){${COVER_HELP}
  var chain=function(e){var out=[];var p=e;for(var i=0;i<6&&p;i++){var c=(''+p.className).trim().split(/\\s+/).slice(0,3).join('.');out.push(p.tagName+(p.id?'#'+p.id:'')+(c?'.'+c:''));p=p.parentElement;}return out;};
  var files=[];var fs=document.querySelectorAll('input[type=file]');
  for(var i=0;i<fs.length;i++){files.push({accept:fs[i].getAttribute('accept')||'',id:fs[i].id||'',cls:(''+fs[i].className).slice(0,60),vis:vis(fs[i]),chain:chain(fs[i])});}
  var pv=document.querySelector('.js_cover_preview_new img,.js_cover_preview_square img,.select-cover__preview img');
  var coverSrc=pv?(pv.getAttribute('src')||'').slice(0,140):'';
  var area=document.querySelector('#js_cover_area')||document.querySelector('.select-cover__btn.js_cover_btn_area');
  var areaHTML=area?area.outerHTML.replace(/\\s+/g,' ').slice(0,400):'';
  var opts=[];var op=document.querySelectorAll('.js_cover_opr a,.js_cover_opr span,.js_cover_opr button,.js_chooseCoverWrap a,.js_chooseCoverWrap span');
  for(var k=0;k<op.length;k++){var tx=(op[k].innerText||'').replace(/\\s+/g,' ').trim();if(tx)opts.push({tag:op[k].tagName,cls:(''+op[k].className).slice(0,40),txt:tx.slice(0,16)});}
  var els=[];var all=document.querySelectorAll('*');
  for(var k2=0;k2<all.length&&els.length<40;k2++){var e=all[k2];var cid=(''+e.className)+'#'+e.id;if(/cover/i.test(cid)){els.push({tag:e.tagName,cls:(''+e.className).slice(0,50),id:e.id,text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,20)});}}
  var texts=[];var cand=document.querySelectorAll('a,button,div,span,li');
  for(var m=0;m<cand.length&&texts.length<30;m++){var t=(cand[m].innerText||'').trim();if(t&&t.length<=12&&/封面/.test(t)){texts.push({tag:cand[m].tagName,txt:t,cls:(''+cand[m].className).slice(0,40)});}}
  var iframes=[];var ifr=document.querySelectorAll('iframe');
  for(var n=0;n<ifr.length;n++){iframes.push((ifr[n].getAttribute('src')||'').slice(0,80));}
  var entry=pick(${JSON.stringify(COVER_SELECTORS.entry)});
  var visuals=[];var vs=document.querySelectorAll('[class*=cover],[id*=cover]');
  for(var vi=0;vi<vs.length&&visuals.length<30;vi++){var ve=vs[vi];var bg='';try{bg=getComputedStyle(ve).backgroundImage||'';}catch(e){}var ci=ve.querySelector('img');var cs=ci?(ci.getAttribute('src')||''):'';if((bg&&bg.indexOf('url(')>=0)||cs){visuals.push({tag:ve.tagName,cls:(''+ve.className).slice(0,44),id:ve.id,bg:bg.slice(0,110),imgSrc:cs.slice(0,110)});}}
  return JSON.stringify({url:location.href.slice(0,120),readyState:document.readyState,title:(document.title||'').slice(0,40),bodyLen:(document.body?document.body.innerHTML.length:0),elCount:document.querySelectorAll('*').length,fileInputs:files,coverSrc:coverSrc,coverVisuals:visuals,coverAreaHTML:areaHTML,coverOptions:opts,coverClassEls:els,coverTextEls:texts,iframes:iframes,hasSave:!!document.querySelector('#js_submit'),entryMatch:entry?{sel:entry.sel,text:(entry.el.innerText||'').replace(/\\s+/g,' ').slice(0,30)}:null});
})()`;

/** Evaluate an expression and parse its JSON result. */
async function evalJson(mp: MpSession, sess: { sessionId: string }, expr: string): Promise<any> {
  const r = await mp.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sess);
  try {
    return JSON.parse(String(r.result?.value ?? "{}"));
  } catch {
    return null;
  }
}

/**
 * Find the best `<input type=file>` node by walking the (pierced) DOM tree —
 * this also reaches inputs inside iframes and shadow roots, which
 * `DOM.querySelector` would miss.
 */
function collectFileInputs(node: any, out: any[], path: string[] = []): void {
  if (!node || typeof node !== "object") return;
  const attrs: Record<string, string> = {};
  if (Array.isArray(node.attributes)) {
    for (let i = 0; i + 1 < node.attributes.length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
  }
  if (node.nodeName === "INPUT" && (attrs.type || "").toLowerCase() === "file") {
    out.push({
      nodeId: node.nodeId,
      backendNodeId: node.backendNodeId,
      accept: attrs.accept || "",
      cls: attrs.class || "",
      id: attrs.id || "",
      path: path.slice(-6).join(" > "),
    });
  }
  const label =
    node.nodeName +
    (attrs.class ? "." + attrs.class.trim().split(/\s+/).slice(0, 2).join(".") : "") +
    (attrs.id ? "#" + attrs.id : "");
  const next = path.concat([label]);
  for (const c of node.children || []) collectFileInputs(c, out, next);
  if (node.contentDocument) collectFileInputs(node.contentDocument, out, next);
  for (const s of node.shadowRoots || []) collectFileInputs(s, out, next);
}

async function findCoverFileInput(mp: MpSession, sess: { sessionId: string }): Promise<any | null> {
  const doc = await mp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, sess);
  const inputs: any[] = [];
  collectFileInputs(doc.root, inputs);
  if (!inputs.length) return null;
  // The cover upload lives inside the「选择图片」dialog; the body's insert-image
  // menu has a persistent `input[type=file]` we must NOT touch (that would insert
  // the image into the article body instead of setting the cover). So score by
  // ancestor path, then fall back to accept/cover hints.
  const score = (x: any) => {
    const p = String(x.path || "");
    let s = 0;
    if (/weui-desktop-dialog|weui-desktop-upload|global-media|upload-input/i.test(p)) s += 8;
    if (/js_editor_insertimage|js_img_dropdown_menu|js_media_list/i.test(p)) s -= 8;
    if (/cover/i.test(x.cls + x.id)) s += 4;
    if (/image/i.test(x.accept)) s += 2;
    return s;
  };
  inputs.sort((a, b) => score(b) - score(a));
  return inputs[0];
}

/**
 * Attach to the draft editor for `title`. Shared by setDraftCover/probeDraftCover.
 * Returns the open session and target; caller MUST close them.
 */
async function openDraftEditor(
  browser: BrowserConfig,
  skillDir: string,
  title: string,
): Promise<{ mp: MpSession; s2: { sessionId: string }; targetId: string } | { error: string; stage: string }> {
  let mp: MpSession;
  try {
    mp = await openMpSession(browser, skillDir);
  } catch (err) {
    return { error: `mp session unavailable: ${err instanceof Error ? err.message : String(err)}`, stage: "session" };
  }
  try {
    const want = normTitle(title);
    const drafts = await fetchDrafts(mp);
    const hit = drafts.find(
      (d) => normTitle(d.title) === want || (want.length > 8 && normTitle(d.title).startsWith(want.slice(0, 14))),
    );
    if (!hit) {
      mp.cdp.close();
      return { error: "draft not found in 草稿箱", stage: "locate" };
    }
    const url =
      `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=${hit.type}` +
      `&appmsgid=${hit.appmsgid}&itemidx=1&token=${mp.token}&lang=zh_CN`;
    const created = await mp.cdp.send("Target.createTarget", { url });
    const at = await mp.cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    return { mp, s2: { sessionId: at.sessionId }, targetId: created.targetId };
  } catch (err) {
    try {
      mp.cdp.close();
    } catch {
      /* ignore */
    }
    return { error: err instanceof Error ? err.message : String(err), stage: "editor" };
  }
}

async function closeDraftEditor(ctx: { mp: MpSession; targetId: string }): Promise<void> {
  try {
    await ctx.mp.cdp.send("Target.closeTarget", { targetId: ctx.targetId });
  } catch {
    /* ignore */
  }
  try {
    ctx.mp.cdp.close();
  } catch {
    /* ignore */
  }
}

/**
 * Set the draft's cover image from `coverPath` (O-B). Non-fatal by contract:
 * the caller must treat any non-`true` result as "cover still needs manual
 * selection" and let the publish succeed.
 */
export async function setDraftCover(opts: SetCoverOptions): Promise<CoverResult> {
  const { browser, skillDir, title, coverPath } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const opened = await openDraftEditor(browser, skillDir, title);
  if ("error" in opened) return { ok: null, stage: opened.stage, detail: opened.error };
  const { mp, s2, targetId } = opened;

  try {
    // Wait for the editor SPA to render the body editor.
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      await sleep(1500);
      const st = await evalJson(mp, s2, COVER_READY_EXPR);
      if (st?.ready) ready = true;
    }
    if (!ready) return { ok: false, stage: "editor", detail: "editor did not become ready" };

    const before = await evalJson(mp, s2, COVER_STATE_EXPR);
    if (before?.ok) log.info(`cover: draft already has a cover, replacing it`);

    // 1) open the cover entry, then「从图片库选择」(the media dialog owns the uploader)
    const open = await evalJson(mp, s2, COVER_OPEN_EXPR);
    if (!open?.clicked) {
      return { ok: false, stage: "open-cover", detail: `cover entry not found (${JSON.stringify(open)})` };
    }
    log.info(`cover: clicked cover entry (${open.sel}${open.text ? ` «${open.text}»` : ""})`);
    await sleep(1200);
    const lib = await evalJson(mp, s2, COVER_LIBRARY_EXPR);
    if (!lib?.clicked) {
      return { ok: false, stage: "open-cover", detail: `「从图片库选择」not found (${JSON.stringify(lib)})` };
    }
    log.info(`cover: opened 图片库 (${lib.sel})`);

    // 2) wait for the「选择图片」dialog
    let dialogReady = false;
    while (Date.now() < deadline && !dialogReady) {
      await sleep(1000);
      const d = await evalJson(mp, s2, COVER_DIALOG_READY_EXPR);
      if (d?.ready) dialogReady = true;
    }
    if (!dialogReady) return { ok: false, stage: "dialog", detail: "「选择图片」dialog did not open" };
    await sleep(3000); // let the media library finish initialising before uploading

    // 3) upload the cover file into the dialog's input (never the body image input)
    const input = await findCoverFileInput(mp, s2);
    if (!input) {
      return { ok: false, stage: "file-input", detail: "cover file input not found — run `cover --date <d> --probe` and update COVER_SELECTORS" };
    }
    await mp.cdp.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [path.resolve(coverPath)] }, s2);
    log.info(`cover: uploaded ${path.basename(coverPath)} (input accept=${input.accept || "*"})`);

    // 4) wait for the upload to finish and the image to be auto-selected. We do NOT
    //    fall back to clicking an arbitrary thumbnail: that could set the wrong cover
    //    (e.g. a stale library image) if the upload failed. Fail safe instead.
    let pickerReady = false;
    let waits = 0;
    while (Date.now() < deadline && !pickerReady) {
      await sleep(1500);
      waits++;
      const d = await evalJson(mp, s2, COVER_PICKER_READY_EXPR);
      if (d?.ready) {
        pickerReady = true;
        break;
      }
      if (waits % 4 === 0) log.info(`cover: waiting for picker (selected=${d?.selected} nextEnabled=${d?.nextEnabled})`);
    }
    if (!pickerReady) {
      return { ok: false, stage: "upload", detail: "uploaded image never became selectable (「下一步」stayed disabled)" };
    }

    // 5)「选择图片」→ 下一步 →「编辑封面」→ 确认
    const nx = await evalJson(mp, s2, COVER_NEXT_EXPR);
    if (!nx?.clicked) return { ok: false, stage: "confirm", detail: "「下一步」not found/enabled in 选择图片 dialog" };
    log.info(`cover: clicked «${nx.text}»`);
    let editReady = false;
    while (Date.now() < deadline && !editReady) {
      await sleep(1200);
      const d = await evalJson(mp, s2, COVER_EDIT_READY_EXPR);
      if (d?.ready) editReady = true;
    }
    if (!editReady) return { ok: false, stage: "confirm", detail: "「编辑封面」dialog did not open" };
    let cf: any = null;
    for (let i = 0; i < 6 && Date.now() < deadline; i++) {
      cf = await evalJson(mp, s2, COVER_EDIT_CONFIRM_EXPR);
      if (cf?.clicked) break;
      await sleep(1500);
    }
    if (!cf?.clicked) return { ok: false, stage: "confirm", detail: `「确认」not found in 编辑封面 dialog (${JSON.stringify(cf)})` };
    log.info(`cover: clicked «${cf.text}»`);

    // 6) wait for the cover preview to update (the confirm triggers an XHR), then save
    const keyOf = (s: any) => String(s?.bg || s?.imgSrc || "");
    let after: any = null;
    let uploaded = false;
    for (let i = 0; i < 12 && Date.now() < deadline; i++) {
      await sleep(1200);
      after = await evalJson(mp, s2, COVER_STATE_EXPR);
      if (after?.ok && keyOf(after) !== keyOf(before)) {
        uploaded = true;
        break;
      }
    }
    const detail = `before=${keyOf(before).slice(0, 60) || "-"} → after=${keyOf(after).slice(0, 60) || "-"}`;

    if (uploaded) {
      const saved = await evalJson(mp, s2, COVER_SAVE_EXPR);
      if (saved?.clicked) {
        log.info(`cover: clicked 保存 (${saved.sel})`);
        for (let i = 0; i < 20 && Date.now() < deadline; i++) {
          await sleep(1000);
          const ss = await evalJson(mp, s2, COVER_SAVE_STATE_EXPR);
          if (!ss?.loading) break;
        }
        await sleep(2000);
      } else {
        log.warn("cover: save button not found (the editor may autosave)");
      }
      log.info(`draft cover set ✓ (${detail})`);
      return { ok: true, stage: "verify", detail };
    }
    log.warn(`draft cover not confirmed (${detail})`);
    return { ok: false, stage: "verify", detail: `cover not detected (${detail})` };
  } catch (err) {
    return { ok: null, stage: "error", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await closeDraftEditor({ mp, targetId });
  }
}

/**
 * Read-only diagnostic: dump the editor's cover-related DOM so the selectors
 * can be fixed on a real machine. Changes nothing.
 */
const COVER_DIALOG_DUMP_EXPR = `(function(){${COVER_HELP}
  var out=[];
  var ds=document.querySelectorAll('.weui-desktop-dialog');
  for(var i=0;i<ds.length;i++){var d=ds[i]; if(!vis(d))continue;
    var hd=d.querySelector('.weui-desktop-dialog__title,.weui-desktop-dialog__hd');
    var title=hd?(hd.innerText||''):'';
    var btns=[];var bs=d.querySelectorAll('button,a.weui-desktop-btn');
    for(var j=0;j<bs.length;j++){var t=(bs[j].innerText||'').trim();if(t&&t.length<=10)btns.push({t:t,dis:bs[j].disabled===true||/disabled/.test(''+bs[j].className)});}
    var imgs=d.querySelectorAll('img');
    var sel=d.querySelectorAll('[class*=select],[class*=active],[class*=checked]');
    var scls=[];for(var k=0;k<sel.length&&scls.length<6;k++){scls.push((''+sel[k].className).slice(0,40));}
    out.push({title:title.replace(/\\s+/g,' ').slice(0,20),btns:btns,imgCount:imgs.length,selClasses:scls,html:d.innerHTML.length,fileInputs:d.querySelectorAll('input[type=file]').length});
  }
  return JSON.stringify({dialogs:out});
})()`;

export async function probeDraftCover(opts: Omit<SetCoverOptions, "coverPath"> & { coverPath?: string }): Promise<CoverResult> {
  const opened = await openDraftEditor(opts.browser, opts.skillDir, opts.title);
  if ("error" in opened) return { ok: null, stage: opened.stage, detail: opened.error };
  const { mp, s2, targetId } = opened;
  try {
    // The mp editor is an SPA: the URL updates before the widgets render, so
    // poll until the body editor appears (or we run out of time) before dumping.
    const deadline = Date.now() + Number(opts.timeoutMs ?? 30_000);
    let ready = false;
    while (Date.now() < deadline && !ready) {
      await sleep(1500);
      const st = await evalJson(mp, s2, COVER_READY_EXPR);
      if (st?.ready) ready = true;
    }
    await sleep(2000); // let the cover widget settle
    const dump = await evalJson(mp, s2, COVER_DUMP_EXPR);
    const inputs: any[] = [];
    try {
      const doc = await mp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, s2);
      collectFileInputs(doc.root, inputs);
    } catch {
      /* ignore */
    }
    if (opts.explore) {
      // Drive the cover popover step by step and snapshot the DOM each time so
      // the real upload path can be identified without guessing.
      const steps: Record<string, unknown> = { before: await evalJson(mp, s2, COVER_SNAPSHOT_EXPR) };
      steps.entryClick = await evalJson(mp, s2, COVER_OPEN_EXPR);
      await sleep(2500);
      steps.afterEntry = await evalJson(mp, s2, COVER_SNAPSHOT_EXPR);
      steps.libraryClick = await evalJson(mp, s2, COVER_LIBRARY_EXPR);
      await sleep(4000);
      steps.afterLibrary = await evalJson(mp, s2, COVER_SNAPSHOT_EXPR);
      const deep: any[] = [];
      try {
        const doc = await mp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, s2);
        collectFileInputs(doc.root, deep);
      } catch {
        /* ignore */
      }
      steps.deepFileInputs = deep;
      if (opts.coverPath && fs.existsSync(opts.coverPath)) {
        // Full rehearsal: upload the cover, then watch the dialog state over time
        // WITHOUT clicking, so the real confirm sequence is observable.
        const target =
          deep.find((x: any) => /weui-desktop-dialog|upload|global-media/i.test(String(x.path || ""))) || deep[deep.length - 1];
        steps.rehearseInput = target ? { accept: target.accept, path: target.path } : null;
        if (target) {
          await mp.cdp.send("DOM.setFileInputFiles", { nodeId: target.nodeId, files: [path.resolve(opts.coverPath)] }, s2);
          const series: any[] = [];
          for (let k = 0; k < 8; k++) {
            await sleep(2500);
            series.push({
              t: (k + 1) * 2.5,
              dialog: await evalJson(mp, s2, COVER_DIALOG_DUMP_EXPR),
              state: await evalJson(mp, s2, COVER_STATE_EXPR),
            });
          }
          steps.uploadSeries = series;
          steps.nextClick = await evalJson(mp, s2, COVER_DIALOG_CONFIRM_EXPR);
          await sleep(3000);
          steps.afterNext = {
            dialog: await evalJson(mp, s2, COVER_DIALOG_DUMP_EXPR),
            state: await evalJson(mp, s2, COVER_STATE_EXPR),
            snapshot: await evalJson(mp, s2, COVER_SNAPSHOT_EXPR),
          };
        }
      }
      try {
        for (const type of ["keyDown", "keyUp"]) {
          await mp.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, s2);
        }
      } catch {
        /* ignore */
      }
      return { ok: null, stage: "explore", detail: JSON.stringify({ dump, fileInputNodes: inputs, steps }, null, 2) };
    }
    return { ok: null, stage: "probe", detail: JSON.stringify({ dump, fileInputNodes: inputs }, null, 2) };
  } catch (err) {
    return { ok: null, stage: "probe", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await closeDraftEditor({ mp, targetId });
  }
}

function runChild(
  bin: string,
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}\n`;
      resolve({ code: null, stdout, stderr });
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

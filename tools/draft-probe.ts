#!/usr/bin/env bun
/**
 * draft-probe.ts — 直接读公众号后台草稿编辑器 DOM，实测「真正落地的正文」。
 *
 * 为什么需要它：发布脚本自报的 "Body content verified OK" 只证明标题框有字，
 * 不能证明正文/公式/图片真的进去了。这个探针走后台编辑器，量的是实际 DOM。
 *
 * 用法：
 *   bun tools/draft-probe.ts <cdpPort> [mode]
 *     mode=latest（默认）：取草稿箱最新一条，打开编辑器，量它
 *     mode=tab           ：量当前已经打开的编辑器标签页（不新建标签）
 *
 * 输出：一行 JSON，字段见 probe()。
 * 判读：
 *   len       正文字符数（< 200 基本就是空正文事故）
 *   h2/strong/ul/li/blockquote  排版是否保留
 *   svg       MathJax 渲染的公式数量（LaTeX 是否存活）
 *   img       图片数量（GIF 是否存活）
 *   placeholderLeak  是否残留 WECHATIMGPH_N（图片没替换成功）
 */
const skillDir = process.env.WF_SKILL_DIR ?? "/root/.agents/skills/baoyu-post-to-wechat";
const mod: any = await import(`${skillDir}/scripts/cdp.ts`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const port = Number(process.argv[2] ?? 9223);
const mode = process.argv[3] ?? "latest";
const waitMs = Number(process.env.WF_PROBE_WAIT_MS ?? 14000);

/** 在目标页里执行的探针：只读，不改任何东西。 */
const PROBE = `(function(){
  var e = document.querySelector(".rich_media_content .ProseMirror");
  if (!e) return JSON.stringify({ err: "no body editor", url: location.href.slice(0, 120) });
  var h = e.innerHTML || "";
  var c = function (t) { return h.split("<" + t).length - 1; };
  var imgs = [].slice.call(e.querySelectorAll("img")).map(function (i) {
    return { src: (i.getAttribute("src") || "").slice(0, 48), w: i.getAttribute("width"), dw: i.getAttribute("data-w"), type: i.getAttribute("data-type") };
  });
  var svgs = [].slice.call(e.querySelectorAll("svg")).map(function (s) {
    return { w: s.getAttribute("width"), h: s.getAttribute("height"), vb: (s.getAttribute("viewBox") || "").slice(0, 30) };
  });
  var txt = (e.innerText || "").replace(/\\s+/g, " ");
  return JSON.stringify({
    len: txt.length,
    h2: c("h2"), h3: c("h3"), p: c("p"), strong: c("strong"), em: c("em"),
    ul: c("ul"), li: c("li"), blockquote: c("blockquote"),
    svg: c("svg"), img: c("img"), image: c("image"),
    imgInfo: imgs, svgInfo: svgs,
    placeholderLeak: h.indexOf("WECHATIMGPH") >= 0,
    head: txt.slice(0, 400)
  });
})()`;

const ws = await mod.waitForChromeDebugPort(port, 15000);
const cdp = await mod.CdpConnection.connect(ws, 15000);

async function evalOn(targetId: string, expr: string, awaitPromise = false) {
  const at = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return await cdp.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise },
    { sessionId: at.sessionId },
  );
}

try {
  const tg = await cdp.send("Target.getTargets");
  const pages = tg.targetInfos.filter(
    (t: any) => t.type === "page" && t.url.includes("mp.weixin.qq.com") && /token=/.test(t.url),
  );
  if (!pages.length) {
    console.error(`❌ cdp :${port} 上没有已登录的 mp.weixin.qq.com 标签页，先跑 login/drafts`);
    process.exit(1);
  }

  if (mode === "tab") {
    const ed = pages.find((t: any) => /appmsg_edit/.test(t.url)) ?? pages[0];
    console.log("tab:", ed.url.slice(0, 100));
    const r = await evalOn(ed.targetId, PROBE);
    console.log(JSON.stringify(r.result?.value ?? r));
  } else {
    const home = pages.find((t: any) => /home\?/.test(t.url)) ?? pages[0];
    const tok = String(
      (await evalOn(home.targetId, `new URLSearchParams(location.search).get("token")||""`)).result?.value ?? "",
    );
    const raw = String(
      (
        await evalOn(
          home.targetId,
          `fetch("/cgi-bin/appmsg?token=${tok}&lang=zh_CN&f=json&ajax=1&action=list_ex&begin=0&count=20&type=77&query=&fakeid=&sub=&search_field=null&sort=").then(r=>r.text())`,
          true,
        )
      ).result?.value ?? "{}",
    );
    const items = JSON.parse(raw).app_msg_list || [];
    const it = items[0];
    if (!it) {
      console.log("草稿箱为空");
      process.exit(0);
    }
    console.log(`latest draft ${it.appmsgid}  ${String(it.title).slice(0, 40)}`);
    const url = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${it.appmsgid}&itemidx=1&token=${tok}&lang=zh_CN`;
    const ct = await cdp.send("Target.createTarget", { url });
    await sleep(waitMs);
    const r = await evalOn(ct.targetId, PROBE);
    console.log(JSON.stringify(r.result?.value ?? r));
    await cdp.send("Target.closeTarget", { targetId: ct.targetId });
  }
} finally {
  try {
    cdp.close();
  } catch {
    /* ignore */
  }
}

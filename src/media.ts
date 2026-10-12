/**
 * media.ts — 发布前的「媒体预处理」：
 *   1) 把文章里的 LaTeX 公式转成内联 SVG（可选，见 math.ts）
 *   2) 如果当天目录有 manim 场景 scene.py 而还没有 scene.gif，就自动渲染
 *
 * 这一步只做确定性的、可失败的局部工作；内容本身仍由 pi agent 生成。
 * 任何一步失败都不阻断发布（降级为「保留原文」），只在日志和邮件里提示。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { renderFormulasInMarkdown } from "./math.ts";
import { log } from "./log.ts";

export interface MediaResult {
  /** 交给 skill 发布的 markdown 路径（可能等于原文） */
  file: string;
  formulaRendered: number;
  formulaFailed: string[];
  gif?: string;
  warnings: string[];
}

/** 当天文章对应的媒体目录：data/<alias>/imgs/<date>/ */
export function mediaDirFor(cfg: AppConfig, date: string): string {
  return path.join(cfg.paths.imgs, date);
}

/**
 * 若存在 scene.py 且没有 scene.gif，就渲染。返回生成的 GIF 路径。
 */
export function ensureManimGif(cfg: AppConfig, date: string): { gif?: string; warning?: string } {
  if (!cfg.manim.enabled) return {};
  const dir = mediaDirFor(cfg, date);
  const scene = path.join(dir, "scene.py");
  if (!fs.existsSync(scene)) return {};

  const gif = path.join(dir, "scene.gif");
  const sceneStat = fs.statSync(scene);
  if (fs.existsSync(gif) && fs.statSync(gif).mtimeMs >= sceneStat.mtimeMs) return { gif };

  if (!fs.existsSync(cfg.math.manimScript)) {
    return { warning: `manim 脚本缺失：${cfg.math.manimScript}` };
  }
  log.step(`manim: rendering ${scene} -> ${gif}`);
  const r = spawnSync(
    "bash",
    [
      cfg.math.manimScript,
      scene,
      "Scene",
      "-o",
      gif,
      "--width",
      String(cfg.manim.width),
      "--fps",
      String(cfg.manim.fps),
      "--max-mb",
      String(cfg.manim.maxMb),
    ],
    { encoding: "utf8", timeout: 15 * 60_000, cwd: dir },
  );
  if (r.status !== 0 || !fs.existsSync(gif)) {
    const msg = `manim 渲染失败：${(r.stderr || r.stdout || "").slice(-300)}`;
    log.warn(msg);
    return { warning: msg };
  }
  log.info(`manim: ${gif} (${(fs.statSync(gif).size / 1024).toFixed(0)}KB)`);
  return { gif };
}

/**
 * 发布前的预处理。返回要交给 skill 的文件路径。
 * 公式渲染后的内容写到 `<name>.math.md`，原文件保持不变（便于复核/重跑）。
 */
export function prepareArticleForPublish(
  cfg: AppConfig,
  articlePath: string,
  date: string,
): MediaResult {
  const warnings: string[] = [];
  let file = articlePath;
  let formulaRendered = 0;
  let formulaFailed: string[] = [];

  // 1) manim 场景 -> gif
  const manim = ensureManimGif(cfg, date);
  if (manim.warning) warnings.push(manim.warning);

  // 2) LaTeX -> 内联 SVG
  if (cfg.math.enabled) {
    try {
      const md = fs.readFileSync(articlePath, "utf8");
      const res = renderFormulasInMarkdown(md, {
        height: cfg.math.height,
        scale: cfg.math.scale,
        color: cfg.math.color,
        python: cfg.math.python,
        scriptPath: cfg.math.script,
        cacheDir: cfg.paths.formula,
      });
      formulaRendered = res.rendered;
      formulaFailed = res.failed;
      if (res.rendered || res.failed.length) {
        const outPath = articlePath.replace(/\.md$/, ".math.md");
        fs.writeFileSync(outPath, res.markdown, "utf8");
        file = outPath;
        if (res.failed.length) warnings.push(`${res.failed.length} 个公式渲染失败（已保留原文）`);
      }
    } catch (err) {
      warnings.push(`公式预处理异常：${(err as Error).message}`);
      log.warn(warnings[warnings.length - 1]!);
    }
  }

  return { file, formulaRendered, formulaFailed, gif: manim.gif, warnings };
}

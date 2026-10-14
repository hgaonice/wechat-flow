/**
 * Console decision extension for a console-spawned `pi --mode rpc` session
 * (C4, I4-4 / design.md D7).
 *
 * Two-layer minimal permission — there is NO bypass:
 *   1. the console spawns pi with `--tools read,grep,find,ls,console_ask`, so
 *      write/edit/bash are never even declared to the model;
 *   2. this extension is a fail-safe second layer: every `tool_call` is
 *      inspected and anything outside the read-only allowlist is blocked
 *      unless a human answers a dialog *for that call*.
 *
 * Hard rules:
 *   - `wechat*`, `publish*`, `*_publish`, `mail*`, `email*`, `smtp*`, `backup*`
 *     are permanently denied and can never be authorized by a dialog;
 *   - the only human-in-the-loop channel is the `console_ask` tool, which maps
 *     onto `ctx.ui.{confirm,select,input,editor}`;
 *   - no `dangerouslyAllowAll`-style escape hatch exists here on purpose.
 *
 * The exported pure helpers are unit-tested without pi.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "console_ask"] as const;

const FORBIDDEN_PATTERNS: RegExp[] = [
  /^wechat/i,
  /^publish/i,
  /_publish$/i,
  /^mail/i,
  /^email/i,
  /^smtp/i,
  /^backup/i,
];

export function isReadOnly(toolName: string): boolean {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}

/** Tools that must never run in a console session, regardless of user consent. */
export function isForbidden(toolName: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(toolName));
}

/**
 * Whether a tool call requires human approval. Annotations (`readOnlyHint`) are
 * deliberately NOT a bypass — only the explicit allowlist is trusted.
 */
export function needsApproval(toolName: string, _hints?: { readOnlyHint?: boolean }): boolean {
  return !isReadOnly(toolName);
}

export type AskKind = "confirm" | "select" | "input" | "editor";

export interface ConsoleAskParams {
  kind: AskKind;
  title: string;
  message?: string;
  options?: string[];
  prefill?: string;
}

const consoleAskTool = defineTool({
  name: "console_ask",
  label: "询问用户",
  description:
    "Ask the human operator a question and block until they answer. Use this for any decision that needs a human (approving an action, choosing between options, confirming a direction). This is the ONLY channel to reach the user.",
  promptSnippet: "console_ask — ask the human operator (confirm / select / input / editor)",
  promptGuidelines: [
    "Before doing anything risky or ambiguous, call console_ask so the human can decide.",
    "Prefer kind=select when there are discrete options and kind=confirm for yes/no.",
  ],
  parameters: Type.Object({
    kind: Type.Union([Type.Literal("confirm"), Type.Literal("select"), Type.Literal("input"), Type.Literal("editor")]),
    title: Type.String({ description: "Short question shown to the operator" }),
    message: Type.Optional(Type.String({ description: "Longer explanation (confirm)" })),
    options: Type.Optional(Type.Array(Type.String(), { description: "Choices (select)" })),
    prefill: Type.Optional(Type.String({ description: "Prefilled text (input/editor)" })),
  }),

  async execute(
    _toolCallId: string,
    params: ConsoleAskParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
    if (!ctx.hasUI) {
      return {
        content: [{ type: "text", text: "无法询问用户：当前会话没有可用的交互界面。" }],
        details: { kind: params.kind, answered: false, reason: "no-ui" },
      };
    }
    const kind = params.kind;
    if (kind === "confirm") {
      const ok = await ctx.ui.confirm(params.title, params.message ?? "");
      return {
        content: [{ type: "text", text: ok ? "用户选择：是（确认）" : "用户选择：否（拒绝）" }],
        details: { kind, confirmed: ok },
      };
    }
    if (kind === "select") {
      const options = Array.isArray(params.options) ? params.options : [];
      if (options.length === 0) {
        return {
          content: [{ type: "text", text: "select 需要至少一个 options。" }],
          details: { kind, answered: false, reason: "no-options" },
        };
      }
      const choice = await ctx.ui.select(params.title, options);
      return {
        content: [{ type: "text", text: choice === undefined ? "用户取消了选择。" : `用户选择：${choice}` }],
        details: { kind, value: choice ?? null, cancelled: choice === undefined },
      };
    }
    if (kind === "editor") {
      const text = await ctx.ui.editor(params.title, params.prefill ?? "");
      return {
        content: [{ type: "text", text: text === undefined ? "用户取消了编辑。" : `用户提交内容：\n${text}` }],
        details: { kind, value: text ?? null, cancelled: text === undefined },
      };
    }
    const value = await ctx.ui.input(params.title, params.prefill ?? "");
    return {
      content: [{ type: "text", text: value === undefined ? "用户取消了输入。" : `用户输入：${value}` }],
      details: { kind: "input", value: value ?? null, cancelled: value === undefined },
    };
  },
});

function describeInput(input: unknown): string {
  try {
    const text = JSON.stringify(input);
    if (typeof text !== "string") return "(no args)";
    return text.length > 400 ? text.slice(0, 400) + "…" : text;
  } catch {
    return "(unserializable args)";
  }
}

export default function consoleDecisionExtension(pi: ExtensionAPI): void {
  pi.registerTool(consoleAskTool);

  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;

    if (isForbidden(name)) {
      return {
        block: true,
        reason: `工具 ${name} 在控制台会话中被永久禁止（禁止发布/邮件/备份类操作）。`,
      };
    }

    if (!needsApproval(name)) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: `工具 ${name} 需要人工确认，但当前没有交互界面。` };
    }

    const approved = await ctx.ui.confirm(
      `允许调用工具「${name}」？`,
      `${describeInput(event.input)}\n\n（控制台会话默认只读；写/执行类工具必须逐次人工确认）`,
    );
    if (!approved) {
      return { block: true, reason: `用户拒绝了工具 ${name} 的调用。` };
    }
    return undefined;
  });
}

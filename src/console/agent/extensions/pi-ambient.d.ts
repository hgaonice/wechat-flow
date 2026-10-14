/**
 * Local ambient declarations for the pi packages an extension may import.
 *
 * The console repo intentionally has ZERO runtime dependencies, so
 * `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` are not installed
 * here. At runtime pi loads `console-decision.ts` through its own jiti resolver,
 * which aliases these specifiers to pi's bundled copies. These declarations are
 * only so `tsc --noEmit` can typecheck the extension in this repo; they are
 * erased from the emitted JS (`import type` + no emitted code in this file).
 *
 * Keep this surface minimal: only what `console-decision.ts` actually touches.
 */
declare module "@earendil-works/pi-ai" {
  /** TypeBox schema builders (only the members the extension uses). */
  export const Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    String(options?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
    Array(items: unknown, options?: Record<string, unknown>): unknown;
    Union(schemas: unknown[], options?: Record<string, unknown>): unknown;
    Literal(value: string | number | boolean, options?: Record<string, unknown>): unknown;
    Boolean(options?: Record<string, unknown>): unknown;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUIDialogOptions {
    timeout?: number;
  }

  export interface ExtensionUIContext {
    select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
    input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    mode: string;
    ui: ExtensionUIContext;
  }

  export interface ToolCallEvent {
    type: "tool_call";
    toolName: string;
    input: Record<string, unknown>;
    toolCallId: string;
  }

  export interface ToolCallResult {
    block?: boolean;
    reason?: string;
  }

  export interface ToolAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  }

  export interface RegisteredTool {
    name: string;
    annotations?: ToolAnnotations;
  }

  export interface ExtensionAPI {
    registerTool(tool: unknown): void;
    registerCommand(
      name: string,
      definition: { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown> },
    ): void;
    on(
      event: "tool_call",
      handler: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallResult | undefined | Promise<ToolCallResult | undefined>,
    ): () => void;
    getAllTools(): RegisteredTool[];
  }

  export function defineTool<T>(tool: T): T;
}

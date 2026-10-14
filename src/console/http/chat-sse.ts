/**
 * SSE bridge for chat sessions (C4, I4-6 / design.md D5).
 *
 * Same-process, event-driven (unlike C3's poll-based job SSE). The SSE `id:` is
 * the `ChatBus` monotonic `seq`, so a reconnecting client can resume with
 * `Last-Event-ID`. A gap in the ring buffer emits `chat.resync` and the client is
 * expected to re-fetch the authoritative history via `GET /api/chats/:id`.
 *
 * C6 (D33, findings N1/N3): `cleanup` is installed *before* any enqueue so a
 * failure during replay unsubscribes/clears instead of leaking; an already
 * aborted `signal` closes the stream immediately.
 */
import type { ChatBus } from "../agent/events.ts";

export interface ChatSseOptions {
  /** Heartbeat interval. Default 15s. */
  pingMs?: number;
  signal?: AbortSignal;
}

const encoder = new TextEncoder();

function frame(type: string, data: unknown, id?: number): Uint8Array {
  const payload = JSON.stringify(data ?? {});
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return encoder.encode(`${idLine}event: ${type}\ndata: ${payload}\n\n`);
}

export function streamChatEvents(
  bus: ChatBus,
  sessionId: number,
  lastEventId: number,
  options: ChatSseOptions = {},
): ReadableStream<Uint8Array> {
  const pingMs = options.pingMs ?? 15_000;
  let cleanup: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let ping: ReturnType<typeof setInterval> | null = null;

      const onAbort = (): void => cleanup();

      // Installed before any write so replay failures can still clean up (N1).
      cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (ping) {
          clearInterval(ping);
          ping = null;
        }
        options.signal?.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      const send = (type: string, data: unknown, id?: number): boolean => safeEnqueue(frame(type, data, id));

      // N3: the request was already aborted before we started — clean up now and
      // never subscribe/ping.
      if (options.signal?.aborted) {
        cleanup();
        return;
      }

      // Replay what the client missed, then subscribe. Replay happens before the
      // subscription so no event is duplicated (the ring is seq-keyed and
      // `since` is strictly `> lastEventId`). If any enqueue fails we bail out
      // without leaking a subscription or interval (N1).
      const { events, gap } = bus.since(sessionId, lastEventId);
      if (gap && !send("chat.resync", { chatId: sessionId, lastEventId })) return;
      for (const event of events) {
        if (!send(event.type, event.data, event.seq)) return;
      }
      if (!send("chat.open", { chatId: sessionId, lastEventId, replayGap: gap })) return;

      unsubscribe = bus.attach(sessionId, (event) => send(event.type, event.data, event.seq));
      ping = setInterval(() => send("ping", { t: Date.now() }), pingMs);
      ping.unref?.();

      options.signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
}

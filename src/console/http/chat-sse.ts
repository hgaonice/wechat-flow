/**
 * SSE bridge for chat sessions (C4, I4-6 / design.md D5).
 *
 * Same-process, event-driven (unlike C3's poll-based job SSE). The SSE `id:` is
 * the `ChatBus` monotonic `seq`, so a reconnecting client can resume with
 * `Last-Event-ID`. A gap in the ring buffer emits `chat.resync` and the client is
 * expected to re-fetch the authoritative history via `GET /api/chats/:id`.
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
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };
      const send = (type: string, data: unknown, id?: number): void => safeEnqueue(frame(type, data, id));

      // Replay what the client missed, then subscribe. Replay happens before the
      // subscription so no event is duplicated (the ring is seq-keyed and
      // `since` is strictly `> lastEventId`).
      const { events, gap } = bus.since(sessionId, lastEventId);
      if (gap) send("chat.resync", { chatId: sessionId, lastEventId });
      for (const event of events) send(event.type, event.data, event.seq);

      send("chat.open", { chatId: sessionId, lastEventId, replayGap: gap });

      const unsubscribe = bus.attach(sessionId, (event) => send(event.type, event.data, event.seq));
      const ping = setInterval(() => send("ping", { t: Date.now() }), pingMs);
      ping.unref?.();

      const onAbort = (): void => cleanup();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(ping);
        options.signal?.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
    cancel() {
      cleanup();
    },
  });
}

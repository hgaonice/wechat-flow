/**
 * In-process chat event bus (C4, I4-5 / design.md D5).
 *
 * One `pi --mode rpc` subprocess per chat session already lives in this process,
 * so streaming events are handed to SSE subscribers in memory — no DB polling
 * (contrast: C3's `http/sse.ts` polls because jobs run out-of-process in spirit
 * but the C4 stream is same-process and latency sensitive).
 *
 * Each session keeps a bounded ring buffer (`capacity`, default 500) of the most
 * recent events, keyed by a monotonic `seq` that doubles as the SSE `id:`. A
 * client reconnecting with `Last-Event-ID` replays from the buffer; when it has
 * fallen behind the window we return `gap: true` and the client re-fetches the
 * authoritative history (`chat.resync`) instead of pretending continuity.
 */
export interface ChatEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface Replay {
  events: ChatEvent[];
  /** True when `seq` is older than the retained window (subscriber must resync). */
  gap: boolean;
}

export type ChatListener = (event: ChatEvent) => void;

export class ChatBus {
  private readonly buffers = new Map<number, ChatEvent[]>();
  private readonly lastSeq = new Map<number, number>();
  private readonly listeners = new Map<number, Set<ChatListener>>();

  constructor(private readonly capacity = 500) {}

  emit(sessionId: number, type: string, data: unknown): ChatEvent {
    const seq = (this.lastSeq.get(sessionId) ?? 0) + 1;
    this.lastSeq.set(sessionId, seq);
    const event: ChatEvent = { seq, type, data };
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(sessionId, buffer);
    }
    buffer.push(event);
    if (buffer.length > this.capacity) buffer.splice(0, buffer.length - this.capacity);

    const subs = this.listeners.get(sessionId);
    if (subs) {
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch {
          /* a broken subscriber must not break the session */
        }
      }
    }
    return event;
  }

  attach(sessionId: number, listener: ChatListener): () => void {
    let subs = this.listeners.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.listeners.set(sessionId, subs);
    }
    subs.add(listener);
    return () => {
      subs!.delete(listener);
    };
  }

  /** Events with `seq > after`. `gap` means the requested seq already fell out. */
  since(sessionId: number, after: number): Replay {
    const buffer = this.buffers.get(sessionId) ?? [];
    const events = buffer.filter((e) => e.seq > after);
    const oldest = buffer.length > 0 ? buffer[0].seq : 0;
    const gap = after > 0 && buffer.length > 0 && oldest > after + 1;
    return { events, gap };
  }

  last(sessionId: number): number {
    return this.lastSeq.get(sessionId) ?? 0;
  }

  has(sessionId: number): boolean {
    return this.buffers.has(sessionId) || this.listeners.has(sessionId);
  }

  /** Drop all state for a finished session (listeners included). */
  close(sessionId: number): void {
    this.buffers.delete(sessionId);
    this.lastSeq.delete(sessionId);
    this.listeners.delete(sessionId);
  }
}

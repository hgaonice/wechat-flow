/**
 * Strict JSONL frame decoder for the pi RPC transport (C4, I4-1).
 *
 * Invariants (design.md D2):
 *   - the ONLY frame boundary is `\n`; a single trailing `\r` is stripped;
 *   - U+2028 / U+2029 (JSON allows them *inside* strings) are NEVER treated as
 *     line separators — that is why `readline` is banned here;
 *   - `flush()` returns whatever is left when the stream ends.
 */
export interface FrameDecoder {
  push(chunk: string): string[];
  flush(): string[];
}

export function createFrameDecoder(): FrameDecoder {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      if (!chunk) return [];
      buffer += chunk;
      const out: string[] = [];
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        out.push(line);
      }
      return out;
    },
    flush(): string[] {
      const rest = buffer;
      buffer = "";
      if (!rest) return [];
      const line = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
      return line.length === 0 ? [] : [line];
    },
  };
}

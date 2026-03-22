/**
 * Shared utility classes and functions.
 * Ported from openclaw-plugin-wecom/utils.js.
 */

import { AGENT_TEXT_BYTE_LIMIT } from "./constants.js";

// ============================================================================
// TTL Cache
// ============================================================================

export class TTLCache<V = unknown> {
  private cache = new Map<string, { value: V; expiresAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly ttl: number, checkPeriod?: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), checkPeriod ?? ttl);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  set(key: string, value: V, ttl?: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + (ttl ?? this.ttl) });
  }

  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    this.cleanup();
    return this.cache.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
  }
}

// ============================================================================
// Message Deduplication
// ============================================================================

export class MessageDeduplicator {
  private seen = new TTLCache<boolean>(300_000); // 5 minutes

  isDuplicate(msgId: string): boolean {
    if (this.seen.has(msgId)) {
      return true;
    }
    this.seen.set(msgId, true);
    return false;
  }

  markAsSeen(msgId: string): void {
    this.seen.set(msgId, true);
  }
}

// ============================================================================
// Text Chunking
// ============================================================================

/**
 * Split a string into chunks that each fit within a byte limit (UTF-8).
 * Splits at newline boundaries when possible, otherwise at character boundaries.
 */
export function splitTextByByteLimit(
  text: string,
  limit: number = AGENT_TEXT_BYTE_LIMIT,
): string[] {
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, "utf8") <= limit) {
      chunks.push(remaining);
      break;
    }

    // Binary search for the max char index that fits within the byte limit
    let lo = 0;
    let hi = remaining.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (Buffer.byteLength(remaining.slice(0, mid), "utf8") <= limit) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    let splitAt = lo;

    // Prefer splitting at a newline boundary within the last 20% of the chunk
    const searchStart = Math.max(0, Math.floor(splitAt * 0.8));
    const lastNewline = remaining.lastIndexOf("\n", splitAt - 1);
    if (lastNewline >= searchStart) {
      splitAt = lastNewline + 1;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

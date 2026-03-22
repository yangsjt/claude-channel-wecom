/**
 * Stream manager for AI Bot mode.
 *
 * Manages stream state for WeCom AI Bot stream response protocol:
 * - Create stream → return initial "thinking" response
 * - WeCom polls → return current state
 * - Claude replies → update stream with final content
 * - Cleanup expired streams
 *
 * Simplified from pre-v2.0 stream-manager.js.
 */

import { STREAM_MAX_LIFETIME_MS, STREAM_CLEANUP_INTERVAL_MS } from "./constants.js";

export interface StreamEntry {
  id: string;
  content: string;
  thinkingContent: string;
  finished: boolean;
  createdAt: number;
  finishedAt: number;
}

export class StreamManager {
  private streams = new Map<string, StreamEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), STREAM_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Create a new stream. Returns the stream ID.
   */
  create(): string {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.streams.set(id, {
      id,
      content: "",
      thinkingContent: "",
      finished: false,
      createdAt: Date.now(),
      finishedAt: 0,
    });
    return id;
  }

  /**
   * Get a stream by ID.
   */
  get(id: string): StreamEntry | undefined {
    return this.streams.get(id);
  }

  /**
   * Update stream content (partial update during processing).
   */
  update(id: string, content: string, thinkingContent?: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.content = content;
    if (thinkingContent !== undefined) {
      stream.thinkingContent = thinkingContent;
    }
  }

  /**
   * Mark a stream as finished with final content.
   */
  finish(id: string, content: string, thinkingContent?: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.content = content;
    stream.finished = true;
    stream.finishedAt = Date.now();
    if (thinkingContent !== undefined) {
      stream.thinkingContent = thinkingContent;
    }
  }

  /**
   * Check if a stream has expired (past max lifetime).
   */
  isExpired(id: string): boolean {
    const stream = this.streams.get(id);
    if (!stream) return true;
    return Date.now() - stream.createdAt > STREAM_MAX_LIFETIME_MS;
  }

  /**
   * Clean up expired and finished streams.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, stream] of this.streams) {
      // Remove streams that are both finished and older than max lifetime
      // or any stream older than 2x max lifetime (safety net)
      if (
        (stream.finished && now - stream.finishedAt > 60_000) ||
        now - stream.createdAt > STREAM_MAX_LIFETIME_MS * 2
      ) {
        this.streams.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.streams.clear();
  }
}

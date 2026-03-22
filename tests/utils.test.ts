/**
 * Unit tests for lib/utils.ts
 * Run: bun test tests/utils.test.ts
 */

import { describe, test, expect } from "bun:test";
import { TTLCache, MessageDeduplicator, splitTextByByteLimit } from "../lib/utils.js";

describe("TTLCache", () => {
  test("set and get within TTL", () => {
    const cache = new TTLCache<string>(5000);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
    cache.destroy();
  });

  test("get returns undefined for missing key", () => {
    const cache = new TTLCache<string>(5000);
    expect(cache.get("missing")).toBeUndefined();
    cache.destroy();
  });

  test("has returns correct boolean", () => {
    const cache = new TTLCache<string>(5000);
    cache.set("key1", "value1");
    expect(cache.has("key1")).toBe(true);
    expect(cache.has("missing")).toBe(false);
    cache.destroy();
  });

  test("delete removes entry", () => {
    const cache = new TTLCache<string>(5000);
    cache.set("key1", "value1");
    cache.delete("key1");
    expect(cache.get("key1")).toBeUndefined();
    cache.destroy();
  });

  test("expired entries return undefined", async () => {
    const cache = new TTLCache<string>(50); // 50ms TTL
    cache.set("key1", "value1");
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.get("key1")).toBeUndefined();
    cache.destroy();
  });

  test("custom TTL per entry", async () => {
    const cache = new TTLCache<string>(5000);
    cache.set("short", "val", 50); // 50ms TTL
    cache.set("long", "val", 5000); // 5s TTL
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("val");
    cache.destroy();
  });
});

describe("MessageDeduplicator", () => {
  test("first message is not duplicate", () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.isDuplicate("msg1")).toBe(false);
  });

  test("same message ID is duplicate", () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate("msg1");
    expect(dedup.isDuplicate("msg1")).toBe(true);
  });

  test("different message IDs are not duplicates", () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate("msg1");
    expect(dedup.isDuplicate("msg2")).toBe(false);
  });

  test("markAsSeen marks without checking", () => {
    const dedup = new MessageDeduplicator();
    dedup.markAsSeen("msg1");
    expect(dedup.isDuplicate("msg1")).toBe(true);
  });
});

describe("splitTextByByteLimit", () => {
  test("short text returns single chunk", () => {
    const chunks = splitTextByByteLimit("hello", 100);
    expect(chunks).toEqual(["hello"]);
  });

  test("empty text returns single chunk", () => {
    const chunks = splitTextByByteLimit("", 100);
    expect(chunks).toEqual([""]);
  });

  test("splits long ASCII text", () => {
    const text = "a".repeat(200);
    const chunks = splitTextByByteLimit(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks.join("")).toBe(text);
  });

  test("respects byte limit with multibyte chars", () => {
    // Each Chinese char = 3 bytes in UTF-8
    const text = "你好世界".repeat(20); // 80 chars = 240 bytes
    const chunks = splitTextByByteLimit(text, 100);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("prefers splitting at newlines", () => {
    const text = "line1\nline2\nline3\nline4";
    const chunks = splitTextByByteLimit(text, 15);
    // Should split at newline boundaries
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(15);
    }
    expect(chunks.join("")).toBe(text);
  });
});

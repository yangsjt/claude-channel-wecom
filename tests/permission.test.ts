/**
 * Unit tests for lib/permission.ts
 * Run: bun test tests/permission.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  type PendingPermission,
  PERMISSION_REPLY_RE,
  formatPermissionMessage,
  matchPermissionReply,
  findByShortId,
} from "../lib/permission.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makePerm(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestId: "abc12xyz9",
    toolName: "bash",
    description: "Execute a shell command",
    inputPreview: 'npm install --save lodash',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PERMISSION_REPLY_RE
// ---------------------------------------------------------------------------

describe("PERMISSION_REPLY_RE", () => {
  test("matches 'y' + 5-char code", () => {
    expect(PERMISSION_REPLY_RE.test("y abc12")).toBe(true);
  });

  test("matches 'yes' + 5-char code", () => {
    expect(PERMISSION_REPLY_RE.test("yes abc12")).toBe(true);
  });

  test("matches 'n' + 5-char code", () => {
    expect(PERMISSION_REPLY_RE.test("n abc12")).toBe(true);
  });

  test("matches 'no' + 5-char code", () => {
    expect(PERMISSION_REPLY_RE.test("no abc12")).toBe(true);
  });

  test("case insensitive", () => {
    expect(PERMISSION_REPLY_RE.test("Y ABC12")).toBe(true);
    expect(PERMISSION_REPLY_RE.test("NO Abc12")).toBe(true);
  });

  test("rejects non-matching text", () => {
    expect(PERMISSION_REPLY_RE.test("hello")).toBe(false);
  });

  test("rejects code shorter than 5 chars", () => {
    expect(PERMISSION_REPLY_RE.test("y ab12")).toBe(false);
  });

  test("rejects code longer than 5 chars", () => {
    expect(PERMISSION_REPLY_RE.test("y abc123")).toBe(false);
  });

  test("rejects missing code", () => {
    expect(PERMISSION_REPLY_RE.test("yes")).toBe(false);
  });

  test("rejects extra text after code", () => {
    expect(PERMISSION_REPLY_RE.test("y abc12 extra")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchPermissionReply
// ---------------------------------------------------------------------------

describe("matchPermissionReply", () => {
  test("returns approved=true for 'y'", () => {
    const result = matchPermissionReply("y abc12");
    expect(result).toEqual({ approved: true, shortId: "abc12" });
  });

  test("returns approved=true for 'yes'", () => {
    const result = matchPermissionReply("yes abc12");
    expect(result).toEqual({ approved: true, shortId: "abc12" });
  });

  test("returns approved=false for 'n'", () => {
    const result = matchPermissionReply("n abc12");
    expect(result).toEqual({ approved: false, shortId: "abc12" });
  });

  test("returns approved=false for 'no'", () => {
    const result = matchPermissionReply("no abc12");
    expect(result).toEqual({ approved: false, shortId: "abc12" });
  });

  test("normalizes shortId to lowercase", () => {
    const result = matchPermissionReply("Y ABC12");
    expect(result?.shortId).toBe("abc12");
  });

  test("trims whitespace", () => {
    const result = matchPermissionReply("  y abc12  ");
    expect(result).toEqual({ approved: true, shortId: "abc12" });
  });

  test("returns null for non-matching text", () => {
    expect(matchPermissionReply("hello")).toBeNull();
    expect(matchPermissionReply("")).toBeNull();
    expect(matchPermissionReply("y")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatPermissionMessage
// ---------------------------------------------------------------------------

describe("formatPermissionMessage", () => {
  test("includes tool name", () => {
    const msg = formatPermissionMessage(makePerm({ toolName: "bash" }));
    expect(msg).toContain("🔐 权限请求: bash");
  });

  test("includes description", () => {
    const msg = formatPermissionMessage(makePerm({ description: "Run a command" }));
    expect(msg).toContain("Run a command");
  });

  test("includes input preview", () => {
    const msg = formatPermissionMessage(makePerm({ inputPreview: "ls -la" }));
    expect(msg).toContain("预览: ls -la");
  });

  test("includes shortId instructions", () => {
    const msg = formatPermissionMessage(makePerm({ requestId: "abc12xyz9" }));
    expect(msg).toContain('回复 "y abc12" 批准');
    expect(msg).toContain('"n abc12" 拒绝');
  });

  test("shortId is first 5 chars lowercase of requestId", () => {
    const msg = formatPermissionMessage(makePerm({ requestId: "ABCDE99999" }));
    expect(msg).toContain('"y abcde"');
  });
});

// ---------------------------------------------------------------------------
// findByShortId
// ---------------------------------------------------------------------------

describe("findByShortId", () => {
  test("finds permission by 5-char prefix", () => {
    const map = new Map<string, PendingPermission>();
    const perm = makePerm({ requestId: "abc12xyz9" });
    map.set("abc12xyz9", perm);

    const result = findByShortId(map, "abc12");
    expect(result).toBeDefined();
    expect(result!.key).toBe("abc12xyz9");
    expect(result!.perm).toBe(perm);
  });

  test("case insensitive matching", () => {
    const map = new Map<string, PendingPermission>();
    map.set("ABC12xyz", makePerm({ requestId: "ABC12xyz" }));

    const result = findByShortId(map, "abc12");
    expect(result).toBeDefined();
  });

  test("returns undefined when no match", () => {
    const map = new Map<string, PendingPermission>();
    map.set("abc12xyz", makePerm({ requestId: "abc12xyz" }));

    expect(findByShortId(map, "zzzzz")).toBeUndefined();
  });

  test("returns undefined for empty map", () => {
    const map = new Map<string, PendingPermission>();
    expect(findByShortId(map, "abc12")).toBeUndefined();
  });

  test("returns first match when multiple exist", () => {
    const map = new Map<string, PendingPermission>();
    const perm1 = makePerm({ requestId: "abc12first" });
    const perm2 = makePerm({ requestId: "abc12second" });
    map.set("abc12first", perm1);
    map.set("abc12second", perm2);

    const result = findByShortId(map, "abc12");
    expect(result).toBeDefined();
    expect(result!.key).toBe("abc12first");
  });
});

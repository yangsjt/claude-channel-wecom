/**
 * Unit tests for lib/permission.ts
 * Run: bun test tests/permission.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  type PendingPermission,
  PERMISSION_REPLY_RE,
  PERMISSION_BARE_REPLY_RE,
  formatPermissionMessage,
  matchPermissionReply,
  resolvePermissionReply,
  formatAmbiguousMessage,
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
// PERMISSION_BARE_REPLY_RE
// ---------------------------------------------------------------------------

describe("PERMISSION_BARE_REPLY_RE", () => {
  test("matches 'y'", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("y")).toBe(true);
  });

  test("matches 'yes'", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("yes")).toBe(true);
  });

  test("matches 'n'", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("n")).toBe(true);
  });

  test("matches 'no'", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("no")).toBe(true);
  });

  test("case insensitive", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("Y")).toBe(true);
    expect(PERMISSION_BARE_REPLY_RE.test("YES")).toBe(true);
    expect(PERMISSION_BARE_REPLY_RE.test("No")).toBe(true);
  });

  test("rejects 'y' with shortId", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("y abc12")).toBe(false);
  });

  test("rejects non-matching text", () => {
    expect(PERMISSION_BARE_REPLY_RE.test("hello")).toBe(false);
    expect(PERMISSION_BARE_REPLY_RE.test("yeah")).toBe(false);
    expect(PERMISSION_BARE_REPLY_RE.test("nope")).toBe(false);
    expect(PERMISSION_BARE_REPLY_RE.test("ok")).toBe(false);
    expect(PERMISSION_BARE_REPLY_RE.test("")).toBe(false);
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
// resolvePermissionReply
// ---------------------------------------------------------------------------

describe("resolvePermissionReply", () => {
  test("explicit shortId returns resolved", () => {
    const map = new Map<string, PendingPermission>();
    map.set("abc12xyz", makePerm({ requestId: "abc12xyz" }));

    const result = resolvePermissionReply("y abc12", map);
    expect(result).toEqual({ kind: "resolved", approved: true, shortId: "abc12" });
  });

  test("explicit shortId returns resolved even with empty map", () => {
    const map = new Map<string, PendingPermission>();

    const result = resolvePermissionReply("y abc12", map);
    expect(result).toEqual({ kind: "resolved", approved: true, shortId: "abc12" });
  });

  test("bare 'y' with 1 pending returns resolved", () => {
    const map = new Map<string, PendingPermission>();
    map.set("def45xyz", makePerm({ requestId: "def45xyz" }));

    const result = resolvePermissionReply("y", map);
    expect(result).toEqual({ kind: "resolved", approved: true, shortId: "def45" });
  });

  test("bare 'n' with 1 pending returns resolved (denied)", () => {
    const map = new Map<string, PendingPermission>();
    map.set("ghi78xyz", makePerm({ requestId: "ghi78xyz" }));

    const result = resolvePermissionReply("n", map);
    expect(result).toEqual({ kind: "resolved", approved: false, shortId: "ghi78" });
  });

  test("bare 'yes' with 1 pending returns resolved", () => {
    const map = new Map<string, PendingPermission>();
    map.set("jkl90xyz", makePerm({ requestId: "jkl90xyz" }));

    const result = resolvePermissionReply("yes", map);
    expect(result).toEqual({ kind: "resolved", approved: true, shortId: "jkl90" });
  });

  test("bare 'no' with 1 pending returns resolved (denied)", () => {
    const map = new Map<string, PendingPermission>();
    map.set("mno12xyz", makePerm({ requestId: "mno12xyz" }));

    const result = resolvePermissionReply("no", map);
    expect(result).toEqual({ kind: "resolved", approved: false, shortId: "mno12" });
  });

  test("bare 'y' with 0 pending returns none", () => {
    const map = new Map<string, PendingPermission>();

    const result = resolvePermissionReply("y", map);
    expect(result).toEqual({ kind: "none" });
  });

  test("bare 'y' with 2 pending returns ambiguous", () => {
    const perm1 = makePerm({ requestId: "abc12xyz", toolName: "bash" });
    const perm2 = makePerm({ requestId: "def45xyz", toolName: "python" });
    const map = new Map<string, PendingPermission>();
    map.set("abc12xyz", perm1);
    map.set("def45xyz", perm2);

    const result = resolvePermissionReply("y", map);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.pending).toHaveLength(2);
    }
  });

  test("non-matching text returns none", () => {
    const map = new Map<string, PendingPermission>();
    map.set("abc12xyz", makePerm());

    expect(resolvePermissionReply("hello", map)).toEqual({ kind: "none" });
    expect(resolvePermissionReply("", map)).toEqual({ kind: "none" });
    expect(resolvePermissionReply("yeah", map)).toEqual({ kind: "none" });
  });

  test("trims whitespace for bare reply", () => {
    const map = new Map<string, PendingPermission>();
    map.set("abc12xyz", makePerm({ requestId: "abc12xyz" }));

    const result = resolvePermissionReply("  y  ", map);
    expect(result).toEqual({ kind: "resolved", approved: true, shortId: "abc12" });
  });

  test("case insensitive for bare reply", () => {
    const map = new Map<string, PendingPermission>();
    map.set("abc12xyz", makePerm({ requestId: "abc12xyz" }));

    const result = resolvePermissionReply("Y", map);
    expect(result).toEqual({ kind: "resolved", approved: true, shortId: "abc12" });
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

  test("includes bare reply hint", () => {
    const msg = formatPermissionMessage(makePerm());
    expect(msg).toContain('或直接回复 "y"/"n"');
  });
});

// ---------------------------------------------------------------------------
// formatAmbiguousMessage
// ---------------------------------------------------------------------------

describe("formatAmbiguousMessage", () => {
  test("lists all pending permissions with shortIds", () => {
    const pending = [
      makePerm({ requestId: "abc12xyz", toolName: "bash", description: "Run shell" }),
      makePerm({ requestId: "def45xyz", toolName: "python", description: "Run script" }),
    ];
    const msg = formatAmbiguousMessage(pending);
    expect(msg).toContain("2 个待处理");
    expect(msg).toContain("abc12");
    expect(msg).toContain("bash");
    expect(msg).toContain("def45");
    expect(msg).toContain("python");
  });

  test("includes instruction to specify shortId", () => {
    const pending = [
      makePerm({ requestId: "abc12xyz" }),
      makePerm({ requestId: "def45xyz" }),
    ];
    const msg = formatAmbiguousMessage(pending);
    expect(msg).toContain('"y <编号>"');
  });

  test("handles 3 entries", () => {
    const pending = [
      makePerm({ requestId: "aaa11xyz", toolName: "bash" }),
      makePerm({ requestId: "bbb22xyz", toolName: "python" }),
      makePerm({ requestId: "ccc33xyz", toolName: "node" }),
    ];
    const msg = formatAmbiguousMessage(pending);
    expect(msg).toContain("3 个待处理");
    expect(msg).toContain("aaa11");
    expect(msg).toContain("bbb22");
    expect(msg).toContain("ccc33");
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

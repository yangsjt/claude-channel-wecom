/**
 * Permission request forwarding — pure functions for testability.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingPermission {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  timestamp: number;
}

export interface PermissionReplyMatch {
  approved: boolean;
  shortId: string;
}

export type PermissionMatchResult =
  | { kind: "none" }
  | { kind: "resolved"; approved: boolean; shortId: string }
  | { kind: "ambiguous"; pending: PendingPermission[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex to match permission replies with shortId: "y xxxxx" or "no xxxxx" */
export const PERMISSION_REPLY_RE = /^(y|yes|n|no)\s+([a-z0-9]{5})$/i;

/** Regex to match bare permission replies: "y", "yes", "n", "no" */
export const PERMISSION_BARE_REPLY_RE = /^(y|yes|n|no)$/i;

/** TTL for pending permission requests (15 minutes). */
export const PENDING_PERMISSION_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Format a permission request message for WeCom delivery.
 */
export function formatPermissionMessage(perm: PendingPermission): string {
  const shortId = perm.requestId.substring(0, 5).toLowerCase();
  return [
    `🔐 权限请求: ${perm.toolName}`,
    perm.description,
    "",
    `预览: ${perm.inputPreview}`,
    "",
    `回复 "y ${shortId}" 批准，"n ${shortId}" 拒绝`,
    `或直接回复 "y"/"n"（仅一个请求时）`,
  ].join("\n");
}

/**
 * Parse a user reply to determine if it matches the permission reply pattern.
 * Returns null if the text doesn't match.
 */
export function matchPermissionReply(text: string): PermissionReplyMatch | null {
  const match = PERMISSION_REPLY_RE.exec(text.trim());
  if (!match) return null;
  return {
    approved: match[1]!.toLowerCase().startsWith("y"),
    shortId: match[2]!.toLowerCase(),
  };
}

/**
 * Resolve a permission reply against the pending permissions map.
 *
 * - "y abc12" with shortId → resolved (regardless of map contents — caller does lookup)
 * - bare "y"/"n" + exactly 1 pending → resolved (auto-pick the sole entry)
 * - bare "y"/"n" + 0 pending → none (pass through as regular message)
 * - bare "y"/"n" + 2+ pending → ambiguous (user must specify shortId)
 * - anything else → none
 */
export function resolvePermissionReply(
  text: string,
  pendingMap: Map<string, PendingPermission>,
): PermissionMatchResult {
  const trimmed = text.trim();

  // Try shortId pattern first: "y abc12"
  const explicit = matchPermissionReply(trimmed);
  if (explicit) {
    return { kind: "resolved", approved: explicit.approved, shortId: explicit.shortId };
  }

  // Try bare reply: "y", "yes", "n", "no"
  const bareMatch = PERMISSION_BARE_REPLY_RE.exec(trimmed);
  if (!bareMatch) return { kind: "none" };

  const approved = bareMatch[1]!.toLowerCase().startsWith("y");
  const entries = Array.from(pendingMap.values());

  if (entries.length === 0) return { kind: "none" };
  if (entries.length === 1) {
    const shortId = entries[0]!.requestId.substring(0, 5).toLowerCase();
    return { kind: "resolved", approved, shortId };
  }
  return { kind: "ambiguous", pending: entries };
}

/**
 * Format a message listing multiple pending permissions when user sends bare "y"/"n".
 */
export function formatAmbiguousMessage(pending: PendingPermission[]): string {
  const lines = [
    `⚠️ 当前有 ${pending.length} 个待处理的权限请求，请指定：`,
    "",
  ];
  for (const perm of pending) {
    const shortId = perm.requestId.substring(0, 5).toLowerCase();
    lines.push(`  ${shortId} — ${perm.toolName}: ${perm.description}`);
  }
  lines.push("", `回复 "y <编号>" 或 "n <编号>"`);
  return lines.join("\n");
}

/**
 * Find a pending permission by the 5-char shortId prefix of its requestId.
 * Returns the full requestId key and the permission entry, or undefined if not found.
 */
export function findByShortId(
  map: Map<string, PendingPermission>,
  shortId: string,
): { key: string; perm: PendingPermission } | undefined {
  for (const [key, perm] of map) {
    if (perm.requestId.substring(0, 5).toLowerCase() === shortId) {
      return { key, perm };
    }
  }
  return undefined;
}

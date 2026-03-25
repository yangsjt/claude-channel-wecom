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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex to match permission replies: "y xxxxx" or "no xxxxx" */
export const PERMISSION_REPLY_RE = /^(y|yes|n|no)\s+([a-z0-9]{5})$/i;

/** TTL for pending permission requests (5 minutes). */
export const PENDING_PERMISSION_TTL_MS = 5 * 60 * 1000;

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

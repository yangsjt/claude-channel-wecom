/**
 * Access control for WeCom Channel Plugin.
 *
 * Pairing-based access control matching official channel plugin pattern.
 * Manages allowed users in access.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccessConfig {
  /** Pairing mode: "open" allows all, "paired" requires allowlist */
  mode: "open" | "paired";
  /** Allowed user IDs */
  allowedUsers: string[];
  /** Pairing code (set when waiting for pairing) */
  pairingCode: string | null;
  /** User ID that initiated pairing */
  pairingInitiator: string | null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const ACCESS_DIR = join(
  process.env.HOME || "/tmp",
  ".claude",
  "channels",
  "wecom",
);
const ACCESS_FILE = join(ACCESS_DIR, "access.json");

function ensureDir(): void {
  if (!existsSync(ACCESS_DIR)) {
    mkdirSync(ACCESS_DIR, { recursive: true });
  }
}

function loadAccessConfig(): AccessConfig {
  ensureDir();
  if (!existsSync(ACCESS_FILE)) {
    return { mode: "paired", allowedUsers: [], pairingCode: null, pairingInitiator: null };
  }
  try {
    const raw = readFileSync(ACCESS_FILE, "utf8");
    return JSON.parse(raw) as AccessConfig;
  } catch {
    return { mode: "paired", allowedUsers: [], pairingCode: null, pairingInitiator: null };
  }
}

function saveAccessConfig(config: AccessConfig): void {
  ensureDir();
  writeFileSync(ACCESS_FILE, JSON.stringify(config, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Access control singleton
// ---------------------------------------------------------------------------

let accessConfig: AccessConfig | null = null;

function getConfig(): AccessConfig {
  if (!accessConfig) {
    accessConfig = loadAccessConfig();
  }
  return accessConfig;
}

function persist(): void {
  if (accessConfig) {
    saveAccessConfig(accessConfig);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a user is allowed to send messages.
 */
export function isUserAllowed(userId: string): boolean {
  const config = getConfig();
  if (config.mode === "open") return true;
  return config.allowedUsers.includes(userId);
}

/**
 * Generate a pairing code for a new user.
 * Returns the code to show to the developer in Claude Code.
 */
export function generatePairingCode(initiatorUserId: string): string {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const config = getConfig();
  config.pairingCode = code;
  config.pairingInitiator = initiatorUserId;
  persist();
  return code;
}

/**
 * Attempt to pair using a code. Returns true if successful.
 */
export function attemptPairing(userId: string, code: string): boolean {
  const config = getConfig();
  if (!config.pairingCode) return false;
  if (code.toUpperCase() !== config.pairingCode.toUpperCase()) return false;

  // Pairing successful — add user to allowlist
  if (!config.allowedUsers.includes(userId)) {
    config.allowedUsers.push(userId);
  }
  config.pairingCode = null;
  config.pairingInitiator = null;
  persist();
  return true;
}

/**
 * Add a user directly to the allowlist.
 */
export function addUser(userId: string): void {
  const config = getConfig();
  if (!config.allowedUsers.includes(userId)) {
    config.allowedUsers.push(userId);
    persist();
  }
}

/**
 * Remove a user from the allowlist.
 */
export function removeUser(userId: string): void {
  const config = getConfig();
  config.allowedUsers = config.allowedUsers.filter((u) => u !== userId);
  persist();
}

/**
 * List all allowed users.
 */
export function listUsers(): string[] {
  return [...getConfig().allowedUsers];
}

/**
 * Set access mode.
 */
export function setMode(mode: "open" | "paired"): void {
  const config = getConfig();
  config.mode = mode;
  persist();
}

/**
 * Get current access mode.
 */
export function getMode(): "open" | "paired" {
  return getConfig().mode;
}

/**
 * Get current pairing state.
 */
export function getPairingState(): {
  hasPendingPairing: boolean;
  code: string | null;
  initiator: string | null;
} {
  const config = getConfig();
  return {
    hasPendingPairing: config.pairingCode !== null,
    code: config.pairingCode,
    initiator: config.pairingInitiator,
  };
}

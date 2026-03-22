/**
 * Configuration loader for WeCom Channel Plugin.
 * Reads from environment variables.
 */

export type WecomMode = "aibot" | "agent";

export interface WecomConfig {
  mode: WecomMode;
  token: string;
  encodingAesKey: string;
  corpId?: string;
  corpSecret?: string;
  agentId?: string;
  callbackPort: number;
  apiBaseUrl: string;
}

export function loadConfig(): WecomConfig {
  const mode = (process.env.WECOM_MODE || "aibot") as WecomMode;
  if (mode !== "aibot" && mode !== "agent") {
    throw new Error(`Invalid WECOM_MODE: ${mode}. Must be "aibot" or "agent".`);
  }

  const token = process.env.WECOM_TOKEN || "";
  const encodingAesKey = process.env.WECOM_ENCODING_AES_KEY || "";

  if (!token) {
    throw new Error("WECOM_TOKEN is required");
  }
  if (!encodingAesKey) {
    throw new Error("WECOM_ENCODING_AES_KEY is required");
  }

  const callbackPort = parseInt(process.env.WECOM_CALLBACK_PORT || "8788", 10);
  const apiBaseUrl = (process.env.WECOM_API_BASE_URL || "https://qyapi.weixin.qq.com").replace(/\/+$/, "");

  const config: WecomConfig = {
    mode,
    token,
    encodingAesKey,
    callbackPort,
    apiBaseUrl,
  };

  if (mode === "agent") {
    config.corpId = process.env.WECOM_CORP_ID;
    config.corpSecret = process.env.WECOM_CORP_SECRET;
    config.agentId = process.env.WECOM_AGENT_ID;

    if (!config.corpId) throw new Error("WECOM_CORP_ID is required in agent mode");
    if (!config.corpSecret) throw new Error("WECOM_CORP_SECRET is required in agent mode");
    if (!config.agentId) throw new Error("WECOM_AGENT_ID is required in agent mode");
  }

  return config;
}

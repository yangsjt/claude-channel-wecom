---
name: wecom:configure
description: Configure WeCom channel credentials and connection settings.
---

# /wecom:configure — WeCom Channel Configuration

Configure your WeCom Channel Plugin credentials.

## AI Bot Mode (Minimal Config)

Set these environment variables in `.mcp.json`:

```env
WECOM_MODE=aibot
WECOM_TOKEN=<your Token from WeCom AI Bot settings>
WECOM_ENCODING_AES_KEY=<your EncodingAESKey from WeCom AI Bot settings>
WECOM_CALLBACK_PORT=8788
```

**Where to find credentials:**
1. WeCom Admin Console → Applications → AI Bot
2. Under "Receive Messages" → "API Receive"
3. Copy Token and EncodingAESKey

## Agent Mode (Full Config)

```env
WECOM_MODE=agent
WECOM_TOKEN=<Token>
WECOM_ENCODING_AES_KEY=<EncodingAESKey>
WECOM_CORP_ID=<your enterprise corpId>
WECOM_CORP_SECRET=<application corpSecret>
WECOM_AGENT_ID=<application agentId>
WECOM_CALLBACK_PORT=8788
WECOM_API_BASE_URL=http://<PROXY_SERVER_IP>/wecom-api
```

**Where to find credentials:**
1. corpId: WeCom Admin Console → My Enterprise → Enterprise Info
2. corpSecret + agentId: Applications → Self-built Apps → Your App
3. Token + EncodingAESKey: Your App → Receive Messages → API Receive

## Callback URL Setup

Your WeCom app's callback URL should point to:

```
https://<your-domain>/app/cc
```

The plugin listens on `0.0.0.0:<WECOM_CALLBACK_PORT>` (default 8788).
You need a reverse proxy (nginx) to forward HTTPS traffic to this port.

### Example nginx config

```nginx
location /app/cc {
    proxy_pass         http://<your-mac-ip>:8788/callback;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_connect_timeout 10s;
    proxy_read_timeout    60s;
    proxy_buffering       off;
}
```

## Running

```bash
claude --dangerously-load-development-channels plugin:wecom@local
```

## Verify

1. Check health endpoint: `curl http://localhost:8788/health`
2. Send a test message from WeCom
3. Check Claude Code session for the incoming message

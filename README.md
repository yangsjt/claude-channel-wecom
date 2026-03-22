# WeCom Channel Plugin for Claude Code

A [Claude Code Channel](https://code.claude.com/docs/en/channels) plugin that bridges WeCom (Enterprise WeChat / 企业微信) messages into Claude Code sessions via MCP.

Send messages to Claude Code from WeCom, receive AI-powered replies with streaming support, and share images/files — all through your enterprise WeChat.

## Features

- **Dual Mode** — AI Bot (智能机器人) for minimal setup, or Agent (自建应用) for full control
- **Stream Reply** — Real-time "thinking..." indicator with typewriter-effect delivery
- **Media Support** — Send images and files from WeCom, Claude can download and analyze them
- **Access Control** — Pairing-based user authorization
- **Markdown** — Rich text formatting in AI Bot mode replies

## Architecture

```
WeCom User
    ↓ sends message
WeCom Server
    ↓ HTTPS callback
Reverse Proxy (nginx)
    ↓ proxy_pass
Plugin HTTP Server (:8788)
    ↓ decrypt + parse
MCP Server (stdio)
    ↓ notification
Claude Code Session
    ↓ calls reply tool
WeCom User ← stream response
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) v2.1.80+
- A WeCom enterprise account with AI Bot or Self-built App

### 1. Clone and Install

```bash
git clone https://github.com/yangsjt/claude-channel-wecom.git
cd claude-channel-wecom
npm install
```

### 2. Configure Credentials

Create `mcp-dev.json` (this file is gitignored):

```json
{
  "mcpServers": {
    "wecom-channel": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/claude-channel-wecom/server.ts"],
      "env": {
        "WECOM_MODE": "aibot",
        "WECOM_TOKEN": "<your-token>",
        "WECOM_ENCODING_AES_KEY": "<your-43-char-key>",
        "WECOM_CALLBACK_PORT": "8788"
      }
    }
  }
}
```

See `.env.example` for all available options.

### 3. Set Up Reverse Proxy

WeCom requires an HTTPS callback URL. Configure your reverse proxy (e.g., nginx) to forward to the plugin:

```nginx
# Example: forward /app/cc to the plugin's HTTP server
location /app/cc {
    proxy_pass         http://<YOUR_MACHINE_IP>:8788/callback;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 10s;
    proxy_read_timeout    60s;
    proxy_buffering       off;
    client_max_body_size  5m;
}
```

Then set the Callback URL in WeCom admin console to `https://<YOUR_DOMAIN>/app/cc`.

### 4. Start

```bash
claude --mcp-config ./mcp-dev.json \
       --dangerously-load-development-channels server:wecom-channel
```

### 5. Test

Send a message from WeCom to your bot — Claude Code should receive it and reply.

## Modes

| | AI Bot (智能机器人) | Agent (自建应用) |
|---|---|---|
| Config | Token + EncodingAESKey | + corpId, corpSecret, agentId |
| Inbound | JSON | XML |
| Reply | Stream + response_url | Agent REST API |
| Media | Encrypted URL download | `/cgi-bin/media/get` |
| Setup | Minimal | Full credentials |

## MCP Tools

| Tool | Description |
|------|-------------|
| `reply` | Send text/Markdown reply to the WeCom user |
| `download_attachment` | Download images/files from WeCom messages |
| `manage_access` | Manage access control: generate pairing codes, add/remove users, switch mode |

## Access Control

By default, all users are blocked (`paired` mode). To authorize a WeCom user:

### Pairing Flow

1. In the Claude Code session (where the plugin is running), type:
   ```
   wecom 配对码
   ```
2. Claude calls `manage_access(action: "pair")` and generates a 6-character code (valid 15 min)
3. Share the code with the WeCom user
4. The user sends the code as a message in WeCom
5. Plugin responds with "配对成功" — the user is now authorized

### Quick Setup (Testing)

For testing, you can set open mode in Claude Code:
```
把 wecom access 模式设为 open
```

Or edit `~/.claude/channels/wecom/access.json` directly:
```json
{ "mode": "open" }
```

See `ACCESS.md` for full details.

## Firewall Note

If your machine has a firewall (e.g., macOS `pf`), ensure port `8788` is open for inbound connections from your reverse proxy.

## License

MIT

---

# WeCom Channel 插件 — Claude Code 企业微信通道

一个 [Claude Code Channel](https://code.claude.com/docs/en/channels) 插件，通过 MCP 协议将企业微信消息桥接到 Claude Code 会话中。

从企业微信给 Claude Code 发消息，获取 AI 回复（支持流式输出），还能发送图片和文件让 Claude 分析。

## 功能特性

- **双模式** — 智能机器人（最简配置）或自建应用（完整控制）
- **流式回复** — 实时显示"正在思考..."，打字机效果展示回复
- **媒体支持** — 从企业微信发送图片和文件，Claude 可以下载并分析
- **访问控制** — 基于配对码的用户授权
- **Markdown** — 智能机器人模式支持富文本格式

## 架构

```
企业微信用户
    ↓ 发送消息
WeCom 服务器
    ↓ HTTPS 回调
反向代理（nginx）
    ↓ proxy_pass
插件 HTTP Server (:8788)
    ↓ 解密 + 解析
MCP Server (stdio)
    ↓ notification
Claude Code 会话
    ↓ 调用 reply tool
企业微信用户 ← 流式回复
```

## 快速开始

### 前置条件

- [Bun](https://bun.sh) 运行时
- [Claude Code](https://claude.ai/code) v2.1.80+
- 企业微信账号（智能机器人或自建应用）

### 1. 克隆并安装

```bash
git clone https://github.com/yangsjt/claude-channel-wecom.git
cd claude-channel-wecom
npm install
```

### 2. 配置凭据

创建 `mcp-dev.json`（已在 .gitignore 中排除）：

```json
{
  "mcpServers": {
    "wecom-channel": {
      "command": "bun",
      "args": ["run", "/绝对路径/claude-channel-wecom/server.ts"],
      "env": {
        "WECOM_MODE": "aibot",
        "WECOM_TOKEN": "<你的 Token>",
        "WECOM_ENCODING_AES_KEY": "<43位密钥>",
        "WECOM_CALLBACK_PORT": "8788"
      }
    }
  }
}
```

完整配置项参考 `.env.example`。

### 3. 配置反向代理

企业微信要求 HTTPS 回调 URL。配置 nginx 反向代理到插件：

```nginx
# 示例：将 /app/cc 转发到插件 HTTP 服务
location /app/cc {
    proxy_pass         http://<你的机器IP>:8788/callback;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 10s;
    proxy_read_timeout    60s;
    proxy_buffering       off;
    client_max_body_size  5m;
}
```

然后在企业微信管理后台设置回调 URL：`https://<你的域名>/app/cc`

### 4. 启动

```bash
claude --mcp-config ./mcp-dev.json \
       --dangerously-load-development-channels server:wecom-channel
```

### 5. 测试

从企业微信给机器人发一条消息 — Claude Code 应收到消息并自动回复。

## 两种模式对比

| | 智能机器人 (AI Bot) | 自建应用 (Agent) |
|---|---|---|
| 配置 | Token + EncodingAESKey | + corpId, corpSecret, agentId |
| 入站格式 | JSON | XML |
| 回复方式 | Stream + response_url | Agent REST API |
| 媒体下载 | 加密 URL 下载 | `/cgi-bin/media/get` |
| 搭建难度 | 最简 | 需完整凭据 |

## MCP 工具

| 工具 | 说明 |
|------|------|
| `reply` | 发送文本/Markdown 回复给企业微信用户 |
| `download_attachment` | 下载企业微信消息中的图片/文件 |
| `manage_access` | 管理访问控制：生成配对码、添加/移除用户、切换模式 |

## 访问控制

默认阻止所有用户（`paired` 模式）。授权企业微信用户的流程：

### 配对流程

1. 在运行插件的 Claude Code 会话中输入：
   ```
   wecom 配对码
   ```
2. Claude 调用 `manage_access` 生成 6 位配对码（15 分钟有效）
3. 将配对码分享给企业微信用户
4. 用户在企业微信中发送配对码
5. 插件返回"配对成功"— 用户获得授权

### 快速设置（测试用）

在 Claude Code 中输入：
```
把 wecom access 模式设为 open
```

或直接编辑 `~/.claude/channels/wecom/access.json`：
```json
{ "mode": "open" }
```

详见 `ACCESS.md`。

## 防火墙注意

如果你的机器有防火墙（如 macOS `pf`），确保端口 `8788` 对反向代理的入站连接开放。

## 许可证

MIT

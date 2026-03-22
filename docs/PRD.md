# WeCom Claude Code Channel Plugin 调研与方案

## Context

Anthropic 推出了 **Claude Code Channels** (研究预览, v2.1.80+)，允许开发者通过 Telegram/Discord 等外部消息平台与运行中的 Claude Code 会话双向通信。官方已发布 Telegram 和 Discord 插件作为参考实现。

用户需要评估：能否为 WeCom (企业微信) 构建类似的 Claude Code Channel 插件？是在现有 OpenClaw wecom 插件上改造，还是新建独立插件？

---

## 核心发现

### Claude Code Channels 是什么

| 维度 | 说明 |
|------|------|
| 本质 | **MCP Server**，作为 Claude Code 的子进程运行，通过 stdio 通信 |
| 能力声明 | `experimental: { 'claude/channel': {} }` |
| 消息推送 | 通过 `notifications/claude/channel` MCP notification 推入 Claude Code 会话 |
| 回复机制 | Claude 通过调用 MCP tool（如 `reply`）回复消息 |
| 运行时 | Bun/Node，与 Claude Code 同生命周期 |
| 认证 | 需要 claude.ai 登录（不支持 API key） |

### 与 OpenClaw 插件的架构差异

| 维度 | OpenClaw 插件 (现有) | Claude Code Channel (目标) |
|------|---------------------|---------------------------|
| 宿主进程 | OpenClaw Gateway | Claude Code CLI |
| 通信协议 | OpenClaw Plugin API (`api.registerChannel`) | MCP over stdio |
| AI 引擎 | OpenClaw 路由到多种 LLM | Claude Code 内置 Claude |
| 会话模型 | 多用户、多账户、网关集中管理 | 单用户、本地开发者工作站 |
| 消息接收 | WebSocket (AI Bot SDK) + HTTP Callback | HTTP Callback (AI Bot JSON / Agent XML) |
| 消息发送 | WS SDK / Agent API / Webhook 多路降级 | AI Bot: response_url / Agent: Agent API |
| 状态管理 | Gateway runtime, 动态 agent, 配额遥测 | MCP server 内部简单状态 |
| 复杂度 | 27 个模块, ~63.5KB | 参考实现为单文件 ~30KB |

---

## 结论：必须新建独立插件

**不可能在现有 OpenClaw 插件上添加 Claude Code Channel 支持**，原因：

1. **协议不兼容**：OpenClaw 用 `api.registerChannel()` / `api.registerTool()` 注册；Claude Code Channel 用 MCP `Server` + stdio transport。两者入口、生命周期、消息分发机制完全不同。
2. **进程模型不同**：OpenClaw 插件作为模块运行在 Gateway 进程内；Channel 插件作为独立子进程被 Claude Code spawn。
3. **用户场景不同**：OpenClaw 面向企业多用户网关；Channel 面向单个开发者本地会话。
4. **强行合并会导致**：入口代码分叉、双重依赖、两套配置体系、维护成本翻倍。

### 可复用代码深度分析（基于 v2.1.0 callback-only 路径）

v2.0.0 曾移除 HTTP 回调模式全面切换 WebSocket，但 v2.1.0 重新引入了完整的 callback inbound 路径。该路径本质上是一个**独立的纯 Agent API 回调通道**，与 Claude Code Channel 的需求高度吻合。

#### 可直接复制的模块（100% 复用）

| 模块 | 源文件 | 行数 | 说明 |
|------|--------|------|------|
| AES 加解密 | `wecom/callback-crypto.js` | 80 行 | `verifyCallbackSignature()` + `decryptCallbackMessage()`，纯函数，仅依赖 `node:crypto` |
| XML 解析 | `wecom/callback-inbound.js` | 30 行 | `extractXmlValue()` + `parseCallbackMessageXml()`，纯函数，正则解析 WeCom XML |
| 文本分块 | `utils.js` | 50 行 | `splitTextByByteLimit()`，二分查找 UTF-8 字节边界，换行优先拆分 |
| 去重器 | `utils.js` | 80 行 | `TTLCache` + `MessageDeduplicator`，5 分钟 TTL 防重放 |
| Think 解析 | `think-parser.js` | 160 行 | `normalizeThinkingTags()` + `parseThinkingContent()`，代码块感知的 think 标签处理 |

#### 需少量改写的模块（90%+ 复用）

| 模块 | 源文件 | 行数 | 改写点 |
|------|--------|------|--------|
| Agent API 客户端 | `wecom/agent-api.js` | 250 行 | 将 `wecomFetch()` 替换为原生 `fetch()`（去掉 undici 代理依赖）。核心函数 `getAccessToken()`, `agentSendText()`, `agentUploadMedia()`, `agentSendMedia()`, `agentDownloadMedia()` 逻辑不变 |
| 媒体下载 | `wecom/callback-media.js` | 77 行 | 将 `runtime.media.saveMediaBuffer()` 替换为本地文件写入 `~/.claude/channels/wecom/inbox/`。同上替换 `wecomFetch` |
| HTTP Handler 框架 | `wecom/callback-inbound.js` | ~120 行 | `createCallbackHandler()` 中的 GET 验证 + POST 解密 + 签名校验 + 时间戳防重放 → 替换 Node `req/res` 为 Bun `Request/Response`，核心逻辑不变 |
| 常量 | `wecom/constants.js` | 选择性 | API 端点（`AGENT_API_ENDPOINTS`）、超时值、字节限制 → 直接复制，去掉 WS 相关常量 |

#### 新增：pre-v2.0 AI Bot URL 回调代码（需从 git 历史恢复）

通过 `git show 7bbde3c~1:<file>` 获取以下 v2.0.0 前被删除的文件：

| 模块 | 源文件 (pre-v2.0) | 行数 | 说明 |
|------|-------------------|------|------|
| AI Bot 加解密 | `crypto.js` (WecomCrypto 类) | 135 行 | `encrypt()` + `decrypt()` + `getSignature()` + `decryptMedia()`。与 `callback-crypto.js` 功能相同但封装为类，且支持**加密回复**（AI Bot 回复需要加密） |
| AI Bot 消息解析 | `webhook.js` (WecomWebhook 类) | 473 行 | `handleVerify()` + `handleMessage()`。解析 JSON 消息：text/image/voice/file/mixed/link/location，提取 `response_url` |
| 流式回复构建 | `webhook.js` (buildStreamResponse) | 40 行 | 构建加密的 stream JSON 回复（用于 HTTP response body 初始应答） |
| response_url 回复 | `wecom/outbound-delivery.js` | 435 行 | `deliverWecomReply()` 三层降级：stream → response_url → Agent API |
| response_url 解析 | `wecom/response-url.js` | 33 行 | `parseResponseUrlResult()` 解析回复结果 |

**对 Claude Code Channel 的复用**：
- `crypto.js` 的 `encrypt()` 方法是关键 — AI Bot 的 URL 验证回复和 stream 初始应答都需要**加密回复**（`callback-crypto.js` 只有解密，没有加密）
- `webhook.js` 的 `handleMessage()` 直接复用 JSON 消息解析
- `response_url` 异步回复机制是 Channel 回复的主通道

#### 不需要复制的模块

| 模块 | 原因 |
|------|------|
| `ws-monitor.js` / `ws-state.js` | 不使用 WebSocket |
| `channel-plugin.js` / `accounts.js` | OpenClaw 插件协议 |
| `dynamic-agent.js` / `dm-policy.js` / `group-policy.js` | OpenClaw 路由/策略 |
| `stream-manager.js` (pre-v2.0) | 358 行 → **简化复用**约 100 行（只保留 create/update/finish/cleanup，去掉 image 队列） |
| `wecom/http-handler.js` (pre-v2.0) | OpenClaw HTTP 路由集成 |

#### 复用率估算

- **AI Bot 协议层**（crypto + webhook + response_url）：~640 行 → **90% 复用**
- **Agent 协议层**（callback-crypto + XML解析 + Agent API）：~500 行 → **95% 复用**
- **共享工具层**（TTLCache + Dedup + splitText + think-parser）：~290 行 → **100% 复用**
- **总结**：新插件预计 800-1000 行 TypeScript（双模式），大部分来自现有代码改写

---

## 实现方案

### 项目结构

```
claude-channel-wecom/
├── .claude-plugin/
│   └── plugin.json              # Claude Code 插件元数据
├── .mcp.json                    # MCP server 启动配置
├── server.ts                    # 主文件：MCP server + HTTP callback server
├── lib/
│   ├── callback-crypto.ts       # WeCom AES-256-CBC 加解密 (从现有项目复制)
│   ├── agent-api.ts             # WeCom Agent REST API 客户端 (从现有项目改写)
│   └── xml-parser.ts            # WeCom XML 消息解析
├── skills/
│   ├── access/SKILL.md          # /wecom:access 配对与权限管理
│   └── configure/SKILL.md       # /wecom:configure 凭据配置
├── ACCESS.md                    # 访问控制文档
├── README.md
├── package.json
└── tsconfig.json
```

### 两种应用模式对比

| 维度 | 智能机器人 (AI Bot) | 自建应用 (Self-built App) |
|------|-------------------|------------------------|
| 配置 | Token + EncodingAESKey (3 值) | corpId + corpSecret + agentId + Token + EncodingAESKey |
| 入站格式 | **JSON** `{ encrypt: "..." }` → 解密后 JSON | **XML** `<Encrypt>...</Encrypt>` → 解密后 XML |
| 消息结构 | `{ msgtype, text: { content }, from: { userid }, response_url, chattype }` | `<MsgType>text</MsgType><Content>...</Content><FromUserName>...</FromUserName>` |
| 回复机制 | **POST 到 response_url**（异步，支持 markdown） | **Agent API** `/cgi-bin/message/send` |
| 加密算法 | AES-256-CBC + SHA1 签名（相同） | AES-256-CBC + SHA1 签名（相同） |
| 群聊支持 | 有（chattype=group, chatid） | 有限（基础回调不区分群聊） |
| 媒体类型 | text/image/voice/file/mixed/link/location | text/image/voice/file/video |
| 参考代码 | pre-v2.0: `crypto.js` + `webhook.js` | v2.1+: `callback-crypto.js` + `callback-inbound.js` |

### 关键设计决策

**1. 双模式支持（智能机器人 + 自建应用）**
- 用户通过 `.env` 中的 `WECOM_MODE=aibot|agent` 选择模式
- AI Bot 模式：只需 Token + EncodingAESKey → 通过 `response_url` 异步回复
- Agent 模式：需要完整凭据 → 通过 Agent API 回复
- 加密/验签逻辑共享（AES-256-CBC + SHA1），仅消息解析和回复路径不同

**2. 消息接收：HTTP Callback（两种模式统一）**
- MCP server 内嵌 HTTP server (Bun.serve)
- GET 请求：URL 验证（两种模式相同）
- POST 请求：AI Bot 解析 JSON / Agent 解析 XML

**3. 消息回复：按模式分派**

- **AI Bot 模式：流式回复（主）+ response_url 降级**
  1. 消息到达 → 创建 stream → 返回加密 stream 初始应答 `{ stream: { id, content: "🤔", finish: false } }`
  2. WeCom 轮询 `{ msgtype: "stream" }` → 返回当前 stream 状态
  3. Claude 调用 `reply` tool → 更新 stream 内容 + `finish: true`
  4. WeCom 下次轮询 → 返回完整回复
  5. 如果 stream 超时 → 降级到 response_url POST 回复
  6. response_url 也失败 → 无法投递（AI Bot 无 Agent API）

  **stream-manager 需简化复用**（from pre-v2.0 `stream-manager.js`，358 行）：
  - `createStream()` / `updateStream()` / `finishStream()` / `cleanup()` — 核心状态管理
  - `buildStreamResponse()` — 构建加密流式 JSON 回复（from `webhook.js`）
  - 去掉 image queuing、msgItem 等复杂逻辑（Channel 不需要图片流式）

- **Agent 模式：Agent REST API**
  ```
  POST /cgi-bin/message/send?access_token=...
  { "touser": "...", "msgtype": "text", "text": { "content": "..." } }
  ```

**4. 语言：TypeScript**（与官方 Telegram/Discord 插件一致）

**5. 访问控制：Pairing 模式**（与官方插件一致）

### MCP Tools

| Tool | 功能 | 优先级 |
|------|------|--------|
| `reply` | 发送文本/Markdown 到用户（AI Bot 用 response_url，Agent 用 REST API） | P0 |
| `download_attachment` | 下载 WeCom 消息中的图片/文件（AI Bot 模式图片 URL 直接下载） | P1 |

不实现的 Tools（WeCom 不支持）：
- `react` / `edit_message` / `fetch_messages`

### 消息流

**AI Bot 模式（智能机器人 URL 回调）**：
```
[WeCom POST 用户消息]
  → HTTP POST { encrypt: "..." } (JSON)
  → 本地 HTTP Server (server.ts, 端口 8788)
  → SHA1 验签 + AES 解密 → JSON { msgtype, text, from, response_url }
  → 创建 stream (streamId) + 保存 response_url
  → 访问控制检查 (allowlist gate)
  → mcp.notification() → Claude Code 开始处理
  → 返回 HTTP 200 + 加密 stream 响应 { stream: { id, content: "🤔", finish: false } }

[WeCom 轮询 stream]
  → HTTP POST { encrypt: { msgtype: "stream", stream: { id } } }
  → 查 streamManager：Claude 回复了吗？
  → 未回复 → 返回 { stream: { id, content: "🤔", finish: false } }
  → 已回复 → 返回 { stream: { id, content: "<完整回复>", finish: true } }

[Claude 调用 reply tool]
  → streamManager.updateStream(id, replyText, finish=true)
  → 下次 WeCom 轮询时自动返回
  → 如果 stream 已超时 → 降级 POST response_url
```

**Agent 模式（自建应用 URL 回调）**：
```
[WeCom]
  → HTTP POST <xml><Encrypt>...</Encrypt></xml>
  → 本地 HTTP Server (同上端口)
  → SHA1 验签 + AES 解密 → XML → 解析 MsgType/Content/FromUserName
  → 返回 HTTP 200 "success"
  → 访问控制检查 (allowlist gate)
  → mcp.notification() → Claude Code 处理
  → Claude 调用 reply tool
  → Agent API: getAccessToken → /cgi-bin/message/send
  → WeCom 投递到用户
```

### 实现阶段

| 阶段 | 内容 | 关键文件 |
|------|------|---------|
| 1 | 脚手架：plugin.json, .mcp.json, package.json, MCP server shell | server.ts |
| 2 | 共享加解密 + AI Bot JSON 解析 (from pre-v2.0) | lib/crypto.ts, lib/aibot-handler.ts |
| 3 | Agent XML 解析 (from v2.1+) | lib/agent-handler.ts |
| 4 | HTTP Callback Server (双模式路由) | server.ts |
| 5 | reply tool: AI Bot → response_url / Agent → REST API | server.ts |
| 6 | 访问控制 (pairing flow, access.json) | server.ts, skills/access/ |
| 7 | 媒体处理 + download_attachment tool | server.ts |
| 8 | /wecom:configure skill + 文档 | skills/configure/, ACCESS.md |

### 现有基础设施复用分析（dm VPS + Mac Mini）

已有的 `dm VPS` + `Mac Mini` 基础设施**完全满足测试需求**，只需新加一个 WeCom 自建应用。

#### 现有基础设施

```
出站: Mac Mini (Claude Code Channel) → Tailscale → dm VPS nginx → WeCom API
入站: WeCom → dm VPS nginx (HTTPS 443) → Tailscale → Mac Mini → Channel Plugin
```

| 组件 | 现状 | 是否可复用 |
|------|------|-----------|
| VPS HTTPS 证书 | `<YOUR_DOMAIN>` Let's Encrypt 自动续期 | 直接复用 |
| WeCom API 出站代理 | `http://<PROXY_SERVER_IP>/wecom-api/` | 直接复用 |
| WeCom 可信 IP | `<TRUSTED_IP>` 已配置 | 直接复用（同企业） |
| Tailscale 网络 | Mac Mini `<YOUR_MAC_IP>` | 直接复用 |
| WW_verify 文件服务 | `/tmp/WW_verify_*.txt` | 直接复用 |

#### 需要新增的内容

**1. WeCom 管理后台 — 新建自建应用**
- 应用名：如 "Claude Code" 或 "CC"
- 获取：corpId (同企业)、corpSecret、agentId
- 设置：接收消息 → API 接收 → 启用
- 获取：Token、EncodingAESKey
- Callback URL: `https://<YOUR_DOMAIN>/app/cc`
- 可信 IP: `<TRUSTED_IP>` (同 tim/devin)

**2. dm VPS nginx — 新增 location 块**

在 `dm-claw.conf` 中添加（参照 tim/devin 的格式）：

```nginx
# Claude Code Channel callback (proxied to Mac Mini Channel plugin)
location /app/cc {
    proxy_pass         http://<YOUR_MAC_IP>:8788/callback;
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

> **注意**：端口 `8788` 是 Channel 插件内嵌 HTTP Server 的端口，与 OpenClaw Gateway 的 `18789` 不同。Channel 插件作为 Claude Code 的子进程运行，独立监听。

**3. Channel 插件 .env 配置**

AI Bot 模式（智能机器人，最简配置）：
```env
WECOM_MODE=aibot
WECOM_TOKEN=<截图中的 Token>
WECOM_ENCODING_AES_KEY=<截图中的 EncodingAESKey>
WECOM_CALLBACK_PORT=8788
```

Agent 模式（自建应用，需要额外凭据）：
```env
WECOM_MODE=agent
WECOM_TOKEN=<Token>
WECOM_ENCODING_AES_KEY=<EncodingAESKey>
WECOM_CORP_ID=<企业 corpId>
WECOM_CORP_SECRET=<应用 corpSecret>
WECOM_AGENT_ID=<应用 agentId>
WECOM_CALLBACK_PORT=8788
WECOM_API_BASE_URL=http://<PROXY_SERVER_IP>/wecom-api
```

#### 运行方式

```bash
# 在 Mac Mini 上运行 Claude Code 并启用 WeCom Channel
claude --dangerously-load-development-channels plugin:wecom@local
```

Channel 插件启动时会：
1. 启动 MCP server (stdio) 与 Claude Code 通信
2. 启动内嵌 HTTP server (端口 8788) 接收 WeCom callback
3. dm VPS nginx 将 WeCom callback 反代到 Mac Mini:8788

### 风险与对策

| 风险 | 对策 |
|------|------|
| HTTP Callback 需要公网 URL | **已解决** — 复用 dm VPS HTTPS + Tailscale 隧道 |
| 同一 WeCom 应用 Callback URL 只能设一个 | 新建独立自建应用，与 OpenClaw 使用的 tim/devin 互不冲突 |
| Claude Code 会话关闭后消息丢失 | Channel 设计如此（Telegram/Discord 也一样），文档说明 |
| WeCom API 限流 (200次/分) | Claude Code 单用户场景不太可能触发，但需处理 45009 错误 |
| Channels 仍为研究预览，API 可能变化 | 跟踪官方更新，保持架构简洁便于适配 |
| Channel 插件端口冲突 | 使用 8788（避开 Gateway 18789），可通过环境变量配置 |

### 发布策略

1. **初期**：独立 GitHub 仓库 (如 `github:<your-github-username>/claude-channel-wecom`)
2. **稳定后**：提交到 `claude-plugins-official` 官方市场
3. 安装方式：`claude plugin add github:<your-github-username>/claude-channel-wecom`

---

## 验证方式

1. **单元测试**：callback-crypto 加解密、XML 解析、访问控制逻辑
2. **集成测试**：使用 fakechat 模式 + 模拟 WeCom callback 请求验证端到端流程
3. **真机测试**：
   - 配置 WeCom 自建应用 + ngrok tunnel
   - `claude --dangerously-load-development-channels plugin:wecom@local` 启动
   - 从企业微信发送消息 → 确认 Claude Code 收到 → 确认回复投递到企业微信

---

## 下一步操作

> **重要**：本文档为 PRD，已存入 `docs/PRD.md`。
> 编码工作需在新项目目录下进行。

### 人工操作步骤

1. `cd ~/projects/claude-channel-wecom` 切换到新项目
2. 在新项目中重新启动 Claude Code 会话（`claude`）
3. 将本 PRD 文档作为上下文提供给新会话
4. 按照「实现阶段」逐步编码

### 源代码参考路径

**AI Bot 模式 — 从 git 历史恢复 (pre-v2.0, commit `7bbde3c~1`)**：
```bash
git show 7bbde3c~1:crypto.js          → lib/crypto.ts       # WecomCrypto 类 (encrypt+decrypt+sign)
git show 7bbde3c~1:webhook.js         → lib/aibot-handler.ts # JSON 消息解析 + stream 回复构建
git show 7bbde3c~1:wecom/response-url.js → lib/response-url.ts # response_url 结果解析
git show 7bbde3c~1:wecom/outbound-delivery.js  # 参考回复流程（不直接复制）
```

**Agent 模式 — 从当前代码复制 (v2.x)**：
```
<openclaw-plugin-wecom-path>/
├── wecom/callback-crypto.js     → lib/crypto.ts 合并     # 自建应用 AES 加解密
├── wecom/agent-api.js           → lib/agent-api.ts       # Agent REST API (替换 wecomFetch→fetch)
├── wecom/callback-media.js      → lib/agent-api.ts 合并  # 媒体下载
├── wecom/callback-inbound.js    → lib/agent-handler.ts   # XML 解析 + HTTP handler 逻辑
├── wecom/constants.js           → lib/constants.ts       # API 端点
├── utils.js                     → lib/utils.ts           # TTLCache, Dedup, splitText
└── think-parser.js              → lib/utils.ts 合并      # think 标签处理
```

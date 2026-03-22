---
name: wecom:access
description: Manage WeCom channel access control — pair users, list/add/remove allowed users, and set access mode.
---

# /wecom:access — WeCom Access Control

Manage who can send messages to your Claude Code session via WeCom.

## Commands

### Pair a new user

Generate a pairing code and share it with the WeCom user:

```
/wecom:access pair
```

The user sends the code in WeCom to complete pairing.

### List allowed users

```
/wecom:access list
```

### Add a user directly

```
/wecom:access add <userid>
```

### Remove a user

```
/wecom:access remove <userid>
```

### Set access mode

```
/wecom:access mode open    # Allow all users (no access control)
/wecom:access mode paired  # Only paired users (default)
```

## How Pairing Works

1. Developer runs `/wecom:access pair` in Claude Code
2. A 6-character code is generated and displayed
3. The WeCom user sends this code as a message
4. If the code matches, the user is added to the allowlist
5. Subsequent messages from this user are forwarded to Claude Code

## Access File

Access configuration is stored in `~/.claude/channels/wecom/access.json`.

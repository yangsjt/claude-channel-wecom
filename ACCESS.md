# WeCom Channel — Access Control

## Overview

The WeCom Channel Plugin uses a **pairing-based** access control system to ensure only authorized users can communicate with your Claude Code session.

## Access Modes

| Mode | Description |
|------|-------------|
| `paired` | **Default**. Only users in the allowlist can send messages. |
| `open` | All WeCom users can send messages (no access control). |

## Pairing Flow

```
Developer (Claude Code)              WeCom User
        │                                │
        │  1. /wecom:access pair         │
        │  → Code: ABC123               │
        │                                │
        │  2. Share code out-of-band     │
        │  ─────────────────────────────>│
        │                                │
        │  3. User sends "ABC123"        │
        │  <─────────────────────────────│
        │                                │
        │  4. ✅ Paired!                 │
        │  User added to allowlist       │
        │                                │
```

## Managing Access

Use the `/wecom:access` skill in Claude Code:

- `pair` — Generate a new pairing code
- `list` — Show all allowed users
- `add <userid>` — Directly add a user
- `remove <userid>` — Remove a user
- `mode open|paired` — Switch access mode

## Storage

Access configuration is persisted in:
```
~/.claude/channels/wecom/access.json
```

Format:
```json
{
  "mode": "paired",
  "allowedUsers": ["user1", "user2"],
  "pairingCode": null,
  "pairingInitiator": null
}
```

## Security Notes

- Pairing codes are single-use and cleared after successful pairing
- In `paired` mode, unauthorized users receive a "no permission" message
- The access file is local to the developer's machine
- Claude Code session termination does not affect the access list

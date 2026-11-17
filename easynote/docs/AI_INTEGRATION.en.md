# EasyNote AI Integration

[简体中文](AI_INTEGRATION.md) | [English](AI_INTEGRATION.en.md)

EasyNote exposes a remote Streamable HTTP MCP server at `/mcp`, allowing AI clients to connect directly over HTTPS:

```text
AI Client → https://your-easynote-domain/mcp → D1 / R2
```

## Create a Token

Sign in to EasyNote and open **Settings → AI Access** to create a token:

- **Name**: Displayed in the token list and note version history (e.g., `My Codex`).
- **Scope**: Choose **Read-only** or **Read & Write**.
- **Expiration**: 30, 90, 365 days, or permanent (up to 10 active tokens per account, revocable anytime).

Copy the `enai_...` token immediately upon creation.

## Connect Codex

Click **Copy Codex Config** and add it to `~/.codex/config.toml`:

```toml
[mcp_servers.easynote]
url = "https://your-easynote-domain/mcp"
http_headers = { Authorization = "Bearer enai_..." }
```

To use an environment variable, run `export EASYNOTE_TOKEN='enai_...'` and reference the variable name:

```toml
[mcp_servers.easynote]
url = "https://your-easynote-domain/mcp"
bearer_token_env_var = "EASYNOTE_TOKEN"
```

Restart Codex and verify with `/mcp`. In Codex Desktop, add the same URL under **Settings → MCP servers**.

## Connect ChatGPT Web

Add an MCP app in ChatGPT with:

- **Server URL**: `https://your-easynote-domain/mcp`
- **Authentication**: OAuth (Dynamic Client Registration + PKCE S256)

Authorize via the EasyNote login page to issue a revocable "ChatGPT" token (1-hour access token, 30-day rotating refresh token). OAuth endpoints: `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, and `/oauth/token`.

## MCP Tools & Resources

| Tool | Scope | Purpose |
| --- | --- | --- |
| `easynote_search_notes` | Read | Search active and archived notes with snippets, offsets, and pagination |
| `easynote_list_recent` | Read | List recent notes |
| `easynote_read_note` | Read | Read a full note or slice by offset |
| `easynote_read_notes` | Read | Batch read up to 20 notes |
| `easynote_connection_status` | Read | Verify account, token name, and permissions |
| `easynote_note_stats` | Read | Exact counts across active, archived, trash, and total notes |
| `easynote_create_note` | Read & Write | Create a note |
| `easynote_update_note` | Read & Write | Update a note (requires `expected_revision`) |
| `easynote_archive_note` | Read & Write | Archive or unarchive a note |
| `easynote_trash_note` | Read & Write | Move a note to trash |

- **Resources**: Read any note as `text/markdown` via `easynote://notes/{id}.md` (lists up to 100 recently updated notes).
- **Best Practices**: Use `easynote_note_stats` for counts; read slices with `startOffset` or batch with `easynote_read_notes`; fetch the latest `revision` before writing; keep titles plain text and start body headings at `##`. AI writes are recorded as `AI: <Token Name>`.

## Verification & Status Codes

Run `npm run test:ai` to verify search, read, write, resources, scope isolation, and revision conflicts with a real Streamable HTTP MCP client. Status codes: `401` (invalid/expired token), `403` (insufficient scope or HTTPS required), `405` (use Streamable HTTP POST on `/mcp`), `409` (revision conflict; re-read before retrying).

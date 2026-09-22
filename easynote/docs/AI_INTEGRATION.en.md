# EasyNote AI Integration

[简体中文](AI_INTEGRATION.md) | [English](AI_INTEGRATION.en.md)

EasyNote exposes a remote Streamable HTTP MCP server at `/mcp` after deployment. Users do not need to download source code, install Node.js, or run a local bridge:

```text
AI Client → https://EasyNote-Domain/mcp → D1 / R2
```

## Creating a Token

Log in to EasyNote, open "Settings", and create a token under "AI Integration":

- Name: Displayed in the token list and version history, e.g. "My Codex".
- Permissions: Select "Read & Write" if AI needs to modify notes; select "Read-Only" for search and retrieval only.
- Expiration: 30, 90, 365 days, or permanent.

Copy the `enai_...` token immediately after creation. Plaintext tokens are displayed only once.

## Connecting Codex

After generating a token, click "Copy Codex Configuration" and add the snippet to `~/.codex/config.toml`:

```toml
[mcp_servers.easynote]
url = "https://your-easynote-domain/mcp"
http_headers = { Authorization = "Bearer enai_..." }
```

Restart Codex and verify the connection with `/mcp`. On Codex Desktop, you can also add the same Streamable HTTP URL under "Settings → MCP servers".

To avoid storing tokens directly in configuration files, set an environment variable first:

```bash
export EASYNOTE_TOKEN='enai_...'
```

Then replace `http_headers` with:

```toml
bearer_token_env_var = "EASYNOTE_TOKEN"
```

`bearer_token_env_var` must be the name of the environment variable, not the `enai_...` token itself. Direct configuration stores plaintext tokens in `config.toml`; do not share or commit this file.

## MCP Tools

| Tool | Permission | Purpose |
| --- | --- | --- |
| `easynote_search_notes` | Read-only | Searches both active and archived notes by default, returning matched context, character offsets, and pagination |
| `easynote_list_recent` | Read-only | Lists recently updated notes |
| `easynote_read_note` | Read-only | Reads a complete note in segments |
| `easynote_read_notes` | Read-only | Batch reads up to 20 notes |
| `easynote_connection_status` | Read-only | Verifies account, token name, and permissions |
| `easynote_note_stats` | Read-only | Provides exact counts for active, archived, trash, and total notes |
| `easynote_create_note` | Read-write | Creates a new note |
| `easynote_update_note` | Read-write | Updates a note |
| `easynote_archive_note` | Read-write | Archives or unarchives a note |
| `easynote_trash_note` | Read-write | Moves a note to trash |

Read-only tokens do not expose mutating tools. Permanent deletion, account management, token management, and file uploads remain exclusively in the EasyNote web application.

## MCP Resources

Each note can be read as `text/markdown` via `easynote://notes/{id}.md`. The Resource list is intended for browsing the most recently updated active and archived notes (up to 100); searches still span the entire knowledge base.

## Best Practices

```text
Call easynote_search_notes first when retrieving knowledge; default view=any ensures archived notes are included.
Call easynote_note_stats for note counts; never extrapolate from paginated search results or Resource counts.
Search hits provide startOffset and endOffset; pass startOffset to easynote_read_note to read only the relevant section.
Prefer easynote_read_notes when fetching multiple note bodies.
Call easynote_read_note before updating to get the latest revision to use as expected_revision.
Stop and re-read the note if a 409 Conflict occurs.
Omit '#' from titles; start top-level sections in the body with '##'.
Use easynote_trash_note for deletion; permanent removal is confirmed by users in the web app.
```

## Security Boundaries

- `/mcp` strictly requires HTTPS (except loopback addresses during local development).
- Every MCP request verifies an independent Bearer token, expiration, revocation status, account status, and permissions.
- AI modifications enter standard version history, tagged as `AI: <token_name>`.
- Cross-origin browser requests are rejected.
- Each account holds at most 10 active tokens; tokens can be revoked at any time in Settings.

## Troubleshooting

- `401`: Token is invalid, expired, or revoked.
- `403`: Read-only token attempted a write, or request is not HTTPS.
- `409`: Note revision changed; re-read and retry.
- `405`: Incorrect MCP URL or client did not send Streamable HTTP POST.
- Missing tools: Ensure the URL ends with `/mcp` and restart Codex.

`npm run test:ai` tests search, read, write, Resources, permission isolation, and revision conflicts using a real Streamable HTTP MCP client.

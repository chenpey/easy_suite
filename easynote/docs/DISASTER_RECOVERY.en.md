# EasyNote Disaster Recovery

[简体中文](DISASTER_RECOVERY.md) | [English](DISASTER_RECOVERY.en.md)

## Backup Options

| Type | Contents | Use Case |
| --- | --- | --- |
| Web **Export ZIP** | Active notes, trash, and referenced files | Note migration and regular archiving |
| Web **Export Drafts** | Unsynced local drafts and cached files | Recovering local offline edits |
| `backup.sh` | Full D1 data and all `ready` R2 objects | Full account-level disaster recovery |

All `--remote` commands read your Cloudflare API Token invisibly in an interactive terminal (requiring `Workers Scripts (Edit)`, `D1 (Edit)`, and `Workers R2 Storage (Edit)` on the target account) and read resource IDs from `wrangler.deploy.json`.

## Create a Backup

```bash
bash backup.sh --remote              # Production backup (use --output DIR to specify path)
bash backup.sh --local               # Local development backup
```

The script exports D1 SQL tables (FTS5 is rebuilt on restore), downloads R2 objects by `<user_id>/<file_id>`, verifies every file size and SHA-256 hash, and writes `manifest.json` into a owner-only directory for encrypted offline storage.

## Preflight & Restore

Provision fresh empty D1 and private R2 resources with a matching `wrangler.deploy.json`, then run preflight and restore:

```bash
bash restore.sh /path/to/easynote-backup --remote --check   # Read-only manifest, hash, and empty-target check
bash restore.sh /path/to/easynote-backup --remote           # Initialize schema, restore R2 objects, and import D1
```

After restoring:

1. Run `bash reset-password.sh --remote` to reset passwords.
2. Recreate any needed AI tokens.
3. Sign in to verify notes, version history, images, and attachments, then take a fresh backup and run `--check`.

## Recovery Drill

Before going live, run a full drill against temporary D1, private R2, and Worker resources: preflight the backup, restore, verify D1 row counts, R2 object counts, and sample files, then remove the temporary resources.

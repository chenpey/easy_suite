# EasyNote Disaster Recovery

[简体中文](DISASTER_RECOVERY.md) | [English](DISASTER_RECOVERY.en.md)

## Three Types of Exports

| Type | Content | Purpose |
| --- | --- | --- |
| Web "Export ZIP" | Active notes, trash, referenced files | Migration and general archiving |
| Web "Export Drafts" | Unsynced browser drafts, cached referenced files | Rescuing local content during network or sync issues |
| `backup.sh` | Full D1 database, all R2 objects tracked in D1 | Account-level disaster recovery |

Web ZIPs are designed for note migration. Complete account states, sessions, AI token hashes, version history, and deletion tombstones are backed up via `backup.sh`.

## Remote Authorization

All commands using `--remote` (backup, preflight check, restore, and password reset) require an interactive terminal and read an invisible Cloudflare custom API Token on each run. Scoped permissions required on the target account include Workers Scripts (Edit), D1 (Edit), and Workers R2 Storage (Edit); initial automated deployments also require Account Settings (Read) to discover accounts, and Custom Domains require Zone (Read) and Workers Routes (Read) on the target Zone.

The script reads the Token invisibly through the terminal on each remote invocation, lifetime limited to the current process. `wrangler.deploy.json` stores the Account ID, Worker name, and D1/R2 resource IDs. Disaster recovery and deployment use Cloudflare API Tokens, whereas EasyNote AI integration tokens are used exclusively for MCP.

## Creating a Backup

Production backup:

```bash
bash backup.sh --remote
```

Local development data:

```bash
bash backup.sh --local
```

Use `--output DIR` to specify a custom destination directory. The script executes:

1. Exports all D1 business tables via Wrangler; reproducible FTS5 search indexes are excluded.
2. Reads all private file records with status `ready` from the SQL snapshot.
3. Downloads corresponding R2 objects using `<user_id>/<file_id>`.
4. Verifies each object against the size and SHA-256 recorded in D1.
5. Writes a `manifest.json` containing checksums for the database, schema baseline, and objects.

Backups contain password verifiers, session hashes, and AI token hashes; directory permissions are set to read/write for the current user only (`0700`). Store backups in an encrypted, offline location with an independent retention policy.

## Preflight Restoration Check

Create fresh, empty D1 and R2 resources and write their identifiers to a dedicated `wrangler.deploy.json`; the restoration target must be empty.

```bash
bash restore.sh /path/to/easynote-backup --remote --check
```

The preflight check performs read-only validations:

- Manifest, D1 SQL, current Schema baseline, and all R2 object hashes match.
- Target D1 is either uninitialized or has a complete but empty EasyNote Schema.
- Target D1 has zero accounts, notes, and file records.
- None of the R2 keys from the backup exist in the target bucket.

All conditions must pass before proceeding to full restoration.

## Executing Restoration

```bash
bash restore.sh /path/to/easynote-backup --remote
```

After entering the confirmation phrase, the script provisions the schema if needed, re-verifies that target resources are empty, uploads R2 objects first, and then imports D1 data. Full-text search indexes are automatically rebuilt upon note import. If interrupted, inspect output for troubleshooting and rerun against fresh, empty resources.

Immediately after restoration:

1. Run `bash reset-password.sh --remote`.
2. Recreate required AI tokens.
3. Log in to the web app and spot-check notes, version history, images, and attachments.
4. Create a fresh disaster recovery backup and run `--check`.

## Recovery Drills

Conduct at least one isolated recovery drill before going to production:

1. Create a temporary D1 database and private R2 bucket.
2. Generate an isolated configuration for temporary resources.
3. Run the restore preflight check against the latest backup.
4. Execute restoration and deploy a temporary Worker.
5. Verify D1 table counts, R2 object counts, and representative files.
6. Delete temporary Worker, D1, and R2 resources upon completion.

Cloudflare resources are explicitly created, deleted, and managed by administrators. Remote backups should be executed on a regular schedule and archived offline.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// These tests only exercise the documented CLI. Every assertion is a user
// visible result: printed output, exit status, or files the command rewrites.
const repository = fileURLToPath(new URL("..", import.meta.url));
const skippedDirectories = new Set(["node_modules", ".git", ".pnpm-store", "dist", ".wrangler"]);
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cloneRepository() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "easy-version-")));
  temporaryDirectories.push(base);
  const directory = join(base, "repo");
  await cp(repository, directory, {
    recursive: true,
    filter: (source) => !source.split(sep).some((part) => skippedDirectories.has(part)),
  });
  return directory;
}

function versionCli(directory, ...args) {
  const result = spawnSync(process.execPath, ["scripts/version.mjs", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.error, undefined, `version.mjs did not finish: ${result.error}`);
  return result;
}

async function readVersions(directory) {
  return JSON.parse(await readFile(join(directory, "versions.json"), "utf8"));
}

function escapeVersion(version) {
  return version.replaceAll(".", "\\.");
}

let baseline;
before(async () => {
  baseline = await cloneRepository();
});

test("show prints the versions kept in versions.json", async () => {
  const result = versionCli(baseline, "show");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), await readVersions(baseline));
});

test("check confirms synchronized files without changing them", async () => {
  const tracked = ["versions.json", join("easymac", "VERSION")];
  const contentsBefore = await Promise.all(tracked.map((path) => readFile(join(baseline, path), "utf8")));

  const result = versionCli(baseline, "check");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All project versions are synchronized/);
  const contentsAfter = await Promise.all(tracked.map((path) => readFile(join(baseline, path), "utf8")));
  assert.deepEqual(contentsAfter, contentsBefore);
});

test("check names every stale version file", async () => {
  const directory = await cloneRepository();
  const versions = await readVersions(directory);

  const packagePath = join(directory, "easydrop", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.version = "9.9.9";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const skillPath = join(directory, "easytest", "README.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(skillPath, skill.replace(`当前版本：\`${versions.easytest}\``, "当前版本：`9.9.9`"));

  const result = versionCli(directory, "check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /easydrop\/package\.json version is 9\.9\.9/);
  assert.match(result.stderr, new RegExp(`easytest/README\\.md is missing ${escapeVersion(versions.easytest)}`));
});

async function repositoryWithReleaseNotes() {
  const directory = await cloneRepository();
  const notesPath = join(directory, "easymac", "CHANGELOG.md");
  const existing = await readFile(notesPath, "utf8");
  await writeFile(
    notesPath,
    `## EasyMac 9.9.8\n\n- 新的发布说明。\n\n## EasyMac 9.9.7\n\n- 更早的发布说明。\n\n${existing}`,
  );
  return directory;
}

test("notes prints the requested release notes and explains missing ones", async () => {
  const directory = await repositoryWithReleaseNotes();
  const notes = versionCli(directory, "notes", "easymac", "9.9.8");
  assert.equal(notes.status, 0, notes.stderr);
  assert.match(notes.stdout, /新的发布说明/);
  assert.doesNotMatch(notes.stdout, /更早的发布说明/);
  assert.doesNotMatch(notes.stdout, /## EasyMac 9\.9\.8/);

  const titled = versionCli(directory, "notes", "easymac", "9.9.8", "--with-title");
  assert.equal(titled.status, 0, titled.stderr);
  assert.match(titled.stdout, /^## EasyMac 9\.9\.8/m);

  const missing = versionCli(directory, "notes", "easymac", "9.9.6");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Release notes for version 9\.9\.6 not found/);
});

test("notes infers the project when run from its directory", async () => {
  const directory = await repositoryWithReleaseNotes();
  const script = join(directory, "scripts", "version.mjs");
  const result = spawnSync(process.execPath, [script, "notes", "9.9.8"], {
    cwd: join(directory, "easymac"),
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(result.error, undefined, `notes did not finish: ${result.error}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /新的发布说明/);
});

test("bump advances the source of truth and every synchronized file", async () => {
  const directory = await cloneRepository();
  const versionsBefore = await readVersions(directory);
  const [major, minor, patch] = versionsBefore.easydrop.split(".").map(Number);
  const expected = `${major}.${minor}.${patch + 1}`;

  const result = versionCli(directory, "bump", "easydrop", "patch");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `EasyDrop version: ${expected}`);
  assert.equal((await readVersions(directory)).easydrop, expected);

  const packageJson = JSON.parse(await readFile(join(directory, "easydrop", "package.json"), "utf8"));
  assert.equal(packageJson.version, expected);
  const lock = JSON.parse(await readFile(join(directory, "easydrop", "package-lock.json"), "utf8"));
  assert.equal(lock.version, expected);
  assert.equal(lock.packages[""].version, expected);

  const rootReadme = await readFile(join(directory, "README.md"), "utf8");
  assert.match(rootReadme, new RegExp(`\\| \\[EasyDrop\\]\\(easydrop/\\) \\| \`${escapeVersion(expected)}\` \\|`));
  const projectReadme = await readFile(join(directory, "easydrop", "README.md"), "utf8");
  assert.match(projectReadme, new RegExp(`当前版本：\`${escapeVersion(expected)}\``));

  const check = versionCli(directory, "check");
  assert.equal(check.status, 0, check.stderr);
});

test("sync applies a manual versions.json edit", async () => {
  const directory = await cloneRepository();
  const versions = await readVersions(directory);
  const [major, minor, patch] = versions.easydrop.split(".").map(Number);
  const expected = `${major}.${minor}.${patch + 5}`;
  versions.easydrop = expected;
  await writeFile(join(directory, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);

  const result = versionCli(directory, "sync");

  assert.equal(result.status, 0, result.stderr);
  const packageJson = JSON.parse(await readFile(join(directory, "easydrop", "package.json"), "utf8"));
  assert.equal(packageJson.version, expected);
  const check = versionCli(directory, "check");
  assert.equal(check.status, 0, check.stderr);
});

test("invalid commands explain the problem and leave versions.json alone", async () => {
  const directory = await cloneRepository();
  const original = await readFile(join(directory, "versions.json"), "utf8");
  const cases = [
    { args: ["bump", "easydrop", "sideways"], message: /Unknown bump type "sideways"/ },
    { args: ["set", "easydrop", "1.2"], message: /Invalid version "1\.2"/ },
    { args: ["notes", "nope", "1.0.0"], message: /Unknown project "nope"/ },
  ];

  for (const { args, message } of cases) {
    const label = args.join(" ");
    const result = versionCli(directory, ...args);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, message, label);
  }
  assert.equal(await readFile(join(directory, "versions.json"), "utf8"), original);
});

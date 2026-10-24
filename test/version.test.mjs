import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// These tests only exercise the documented CLI. Every assertion is a user
// visible result: printed output, exit status, or files the command rewrites.
// Projects are discovered from <project>/version.config.json, so nothing here
// names a specific project: adding or removing one never edits this file.
const repository = fileURLToPath(new URL("..", import.meta.url));
const skippedDirectories = new Set([
  "node_modules",
  ".git",
  ".pnpm-store",
  "dist",
  ".wrangler",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  "test-results",
  "playwright-report",
  "backups",
]);
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

// Mirrors what the CLI documents: a project is any directory with a config.
async function discoveredProjects(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let config;
    try {
      config = JSON.parse(await readFile(join(directory, entry.name, "version.config.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    found.push({ name: entry.name, config });
  }
  return found.sort((left, right) => (left.config.order ?? 0) - (right.config.order ?? 0)
    || left.name.localeCompare(right.name));
}

function select(projects, predicate, description) {
  const project = projects.find(predicate);
  assert.ok(project, `No project declares ${description}; the repository needs one to cover this case.`);
  return project;
}

const hasTarget = (type) => (project) => project.config.targets?.some((target) => target.type === type);
const npmProject = hasTarget("npm");
const readmeProject = hasTarget("readme");
const notesProject = (project) => typeof project.config.notes === "string";
const textSourceProject = (project) => project.config.source?.type === "text";

function escapeVersion(version) {
  return version.replaceAll(".", "\\.");
}

function readmeLine(version) {
  return `当前版本：\`${version}\``;
}

let baseline;
let projects;
before(async () => {
  baseline = await cloneRepository();
  projects = await discoveredProjects(baseline);
});

test("show prints exactly the versions kept in versions.json", async () => {
  const result = versionCli(baseline, "show");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), await readVersions(baseline));
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), projects.map((project) => project.name));
});

test("check confirms synchronized files without changing them", async () => {
  const sources = projects.map((project) => join(project.name, project.config.source.path));
  const tracked = ["versions.json", ...sources];
  const contentsBefore = await Promise.all(tracked.map((path) => readFile(join(baseline, path), "utf8")));

  const result = versionCli(baseline, "check");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All project versions are synchronized/);
  const contentsAfter = await Promise.all(tracked.map((path) => readFile(join(baseline, path), "utf8")));
  assert.deepEqual(contentsAfter, contentsBefore);
});

test("check names every stale version file", async () => {
  const directory = await cloneRepository();
  const discovered = await discoveredProjects(directory);
  const npm = select(discovered, npmProject, "an npm target");
  const readme = select(
    discovered.filter((project) => project.name !== npm.name),
    readmeProject,
    "a README target in a second project",
  );
  const versions = await readVersions(directory);

  // The package manifest is the npm project's source of truth, so drift is
  // introduced in the lock file and in another project's README instead.
  const lockPath = join(directory, npm.name, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.version = "9.9.9";
  lock.packages[""].version = "9.9.9";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const readmePath = join(directory, readme.name, "README.md");
  const readmeContent = await readFile(readmePath, "utf8");
  await writeFile(readmePath, readmeContent.replace(/^当前版本：.*$/m, readmeLine("9.9.9")));

  const result = versionCli(directory, "check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${npm.name}/package-lock\\.json root version is not ${escapeVersion(versions[npm.name])}`));
  assert.match(result.stderr, new RegExp(`${readme.name}/README\\.md is missing ${escapeVersion(versions[readme.name])}`));
});

test("check rejects a stale aggregate version table", async () => {
  const directory = await cloneRepository();
  const versions = await readVersions(directory);
  const [name] = Object.keys(versions);
  versions[name] = "9.9.9";
  await writeFile(join(directory, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);

  const result = versionCli(directory, "check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /versions\.json is stale/);
});

test("a plain-text source stays authoritative for show and check", async () => {
  const directory = await cloneRepository();
  const discovered = await discoveredProjects(directory);
  const project = select(discovered, textSourceProject, "a plain-text version source");
  const path = join(directory, project.name, project.config.source.path);
  await writeFile(path, "9.9.9\n");

  const shown = versionCli(directory, "show");
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout)[project.name], "9.9.9");

  const result = versionCli(directory, "check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${project.name}/README\\.md is missing 9\\.9\\.9`));
});

async function repositoryWithReleaseNotes() {
  const directory = await cloneRepository();
  const discovered = await discoveredProjects(directory);
  const project = select(discovered, notesProject, "release notes");
  const notesPath = join(directory, project.name, project.config.notes);
  const existing = await readFile(notesPath, "utf8");
  await writeFile(
    notesPath,
    `## ${project.config.title} 9.9.8\n\n- 新的发布说明。\n\n## ${project.config.title} 9.9.7\n\n- 更早的发布说明。\n\n${existing}`,
  );
  return { directory, project };
}

test("notes prints the requested release notes and explains missing ones", async () => {
  const { directory, project } = await repositoryWithReleaseNotes();
  const notes = versionCli(directory, "notes", project.name, "9.9.8");
  assert.equal(notes.status, 0, notes.stderr);
  assert.match(notes.stdout, /新的发布说明/);
  assert.doesNotMatch(notes.stdout, /更早的发布说明/);
  assert.doesNotMatch(notes.stdout, new RegExp(`## ${project.config.title} 9\\.9\\.8`));

  const titled = versionCli(directory, "notes", project.name, "9.9.8", "--with-title");
  assert.equal(titled.status, 0, titled.stderr);
  assert.match(titled.stdout, new RegExp(`^## ${project.config.title} 9\\.9\\.8`, "m"));

  const missing = versionCli(directory, "notes", project.name, "9.9.6");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Release notes for version 9\.9\.6 not found/);
});

test("notes infers the project when run from its directory", async () => {
  const { directory, project } = await repositoryWithReleaseNotes();
  const script = join(directory, "scripts", "version.mjs");
  const result = spawnSync(process.execPath, [script, "notes", "9.9.8"], {
    cwd: join(directory, project.name),
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(result.error, undefined, `notes did not finish: ${result.error}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /新的发布说明/);
});

test("bump advances the source of truth and every synchronized file", async () => {
  const directory = await cloneRepository();
  const discovered = await discoveredProjects(directory);
  const project = select(discovered, npmProject, "an npm target");
  const versionsBefore = await readVersions(directory);
  const [major, minor, patch] = versionsBefore[project.name].split(".").map(Number);
  const expected = `${major}.${minor}.${patch + 1}`;

  const result = versionCli(directory, "bump", project.name, "patch");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${project.config.title} version: ${expected}`);
  assert.equal((await readVersions(directory))[project.name], expected);

  const packageJson = JSON.parse(await readFile(join(directory, project.name, "package.json"), "utf8"));
  assert.equal(packageJson.version, expected);
  const lock = JSON.parse(await readFile(join(directory, project.name, "package-lock.json"), "utf8"));
  assert.equal(lock.version, expected);
  assert.equal(lock.packages[""].version, expected);

  const rootReadme = await readFile(join(directory, "README.md"), "utf8");
  assert.ok(
    rootReadme.includes(`| [${project.config.title}](${project.name}/) | \`${expected}\` |`),
    "the repository version table keeps the project row in sync",
  );
  const projectReadme = await readFile(join(directory, project.name, "README.md"), "utf8");
  assert.ok(projectReadme.includes(readmeLine(expected)), "the project README version line is updated");

  const check = versionCli(directory, "check");
  assert.equal(check.status, 0, check.stderr);
});

test("sync applies a manual edit back to the declared files", async () => {
  const directory = await cloneRepository();
  const discovered = await discoveredProjects(directory);
  const project = select(discovered, readmeProject, "a README target");
  const versions = await readVersions(directory);
  const [major, minor, patch] = versions[project.name].split(".").map(Number);
  const expected = `${major}.${minor}.${patch + 5}`;

  const readmePath = join(directory, project.name, "README.md");
  await writeFile(
    readmePath,
    (await readFile(readmePath, "utf8")).replace(/^当前版本：.*$/m, readmeLine(expected)),
  );

  const result = versionCli(directory, "sync");

  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readFile(readmePath, "utf8")).includes(readmeLine(versions[project.name])));
  const check = versionCli(directory, "check");
  assert.equal(check.status, 0, check.stderr);
});

test("a new project is picked up from its config without editing repository files", async () => {
  const directory = await cloneRepository();
  const scriptBefore = await readFile(join(directory, "scripts", "version.mjs"), "utf8");
  const projectDirectory = join(directory, "sampletool");
  await mkdir(projectDirectory);
  await writeFile(join(projectDirectory, "version.config.json"), `${JSON.stringify({
    title: "SampleTool",
    order: 90,
    source: { type: "json", path: "package.json", field: "version" },
    targets: [
      { type: "npm", path: "package.json", lock: "package-lock.json" },
      { type: "readme", path: "README.md" },
    ],
  }, null, 2)}\n`);
  await writeFile(join(projectDirectory, "package.json"), `${JSON.stringify({ name: "sampletool", version: "0.0.1" }, null, 2)}\n`);
  await writeFile(join(projectDirectory, "package-lock.json"), `${JSON.stringify({ name: "sampletool", version: "0.0.1", lockfileVersion: 3, packages: { "": { name: "sampletool", version: "0.0.1" } } }, null, 2)}\n`);
  await writeFile(join(projectDirectory, "README.md"), `# SampleTool\n\n${readmeLine("0.0.1")}\n`);

  const synced = versionCli(directory, "sync");
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal((await readVersions(directory)).sampletool, "0.0.1");
  assert.match(await readFile(join(directory, "README.md"), "utf8"), /\| \[SampleTool\]\(sampletool\/\) \| `0\.0\.1` \|/);

  const bumped = versionCli(directory, "bump", "sampletool", "minor");
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(bumped.stdout.trim(), "SampleTool version: 0.1.0");
  const check = versionCli(directory, "check");
  assert.equal(check.status, 0, check.stderr);
  assert.equal(await readFile(join(directory, "scripts", "version.mjs"), "utf8"), scriptBefore);
});

test("invalid commands explain the problem and leave versions.json alone", async () => {
  const directory = await cloneRepository();
  const discovered = await discoveredProjects(directory);
  const project = select(discovered, npmProject, "an npm target");
  const original = await readFile(join(directory, "versions.json"), "utf8");
  const cases = [
    { args: ["bump", project.name, "sideways"], message: /Unknown bump type "sideways"/ },
    { args: ["set", project.name, "1.2"], message: /Invalid version "1\.2"/ },
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

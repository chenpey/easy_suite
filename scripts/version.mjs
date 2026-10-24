#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The repository script owns no project knowledge. Every project declares its
// version source and synchronised files in <project>/version.config.json, so
// adding or removing a project never requires editing this file.
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const aggregatePath = resolve(root, 'versions.json');
const configName = 'version.config.json';
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sourceTypes = new Set(['json', 'text', 'toml-project-version']);
const targetTypes = new Set([
  'npm',
  'version-file',
  'pyproject',
  'uv-lock',
  'python-version',
  'runtime-ts',
  'json-field',
  'readme',
]);

function fail(message) {
  throw new Error(message);
}

function validateVersion(version) {
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    fail(`Invalid version "${version}". Use semantic versioning such as 0.1.1.`);
  }
  return version;
}

export function bumpVersion(version, kind) {
  validateVersion(version);
  if (!['major', 'minor', 'patch'].includes(kind)) {
    fail(`Unknown bump type "${kind}". Use major, minor or patch.`);
  }
  const [major, minor, patch] = version.split('-')[0].split('+')[0].split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function extractReleaseNotes(content, version, options = {}) {
  const { includeHeading = false } = options;
  const escapedVersion = version.replace(/\./g, '\\.');
  const headingPattern = new RegExp(`^##\\s+(?:.*\\b)?v?${escapedVersion}(?:\\b|\\s|$).*$`, 'm');
  const match = headingPattern.exec(content);
  if (!match) {
    throw new Error(`Release notes for version ${version} not found.`);
  }
  const afterHeading = content.slice(match.index + match[0].length);
  const nextHeadingMatch = afterHeading.search(/^##?\s+/m);
  const body = nextHeadingMatch === -1 ? afterHeading : afterHeading.slice(0, nextHeadingMatch);
  if (includeHeading) {
    return `${match[0]}\n\n${body.trim()}`.trim();
  }
  return body.trim();
}

function jsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeIfChanged(path, content) {
  let current = '';
  try { current = await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== content) await writeFile(path, content);
}

function validateConfig(directory, config) {
  const label = `${directory}/${configName}`;
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail(`${label} must contain an object.`);
  if (typeof config.title !== 'string' || !config.title.trim()) fail(`${label} is missing a title.`);
  if (config.order !== undefined && !Number.isFinite(config.order)) fail(`${label} order must be a number.`);
  const { source } = config;
  if (!source || typeof source !== 'object' || !sourceTypes.has(source.type)) {
    fail(`${label} source.type must be one of ${[...sourceTypes].join(', ')}.`);
  }
  if (typeof source.path !== 'string' || !source.path) fail(`${label} source.path is required.`);
  if (source.type === 'json' && (typeof source.field !== 'string' || !source.field)) {
    fail(`${label} source.field is required for a json source.`);
  }
  const targets = config.targets ?? [];
  if (!Array.isArray(targets)) fail(`${label} targets must be an array.`);
  targets.forEach((target, index) => {
    const where = `${label} target ${index + 1}`;
    if (!target || typeof target !== 'object' || !targetTypes.has(target.type)) {
      fail(`${where} type must be one of ${[...targetTypes].join(', ')}.`);
    }
    if (typeof target.path !== 'string' || !target.path) fail(`${where} path is required.`);
    if (target.type === 'npm' && typeof target.lock !== 'string') fail(`${where} lock is required for an npm target.`);
    if (target.type === 'uv-lock' && typeof target.package !== 'string') {
      fail(`${where} package is required for a uv-lock target.`);
    }
    if (target.type === 'runtime-ts' && typeof target.name !== 'string') {
      fail(`${where} name is required for a runtime-ts target.`);
    }
    if (target.type === 'json-field' && typeof target.field !== 'string') {
      fail(`${where} field is required for a json-field target.`);
    }
  });
  if (config.notes !== undefined && (typeof config.notes !== 'string' || !config.notes)) {
    fail(`${label} notes must be a project-relative path.`);
  }
  return {
    name: directory,
    title: config.title,
    order: config.order ?? Number.MAX_SAFE_INTEGER,
    source,
    targets,
    notes: config.notes,
    directory: resolve(root, directory),
  };
}

export async function loadProjects() {
  const entries = await readdir(root, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let raw;
    try {
      raw = await readFile(resolve(root, entry.name, configName), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      fail(`${entry.name}/${configName} is not valid JSON.`);
    }
    projects.push(validateConfig(entry.name, config));
  }
  return projects.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

function findProject(projects, name) {
  const project = projects.find((entry) => entry.name === name);
  if (!project) fail(`Unknown project "${name}". Use ${projects.map((entry) => entry.name).join(', ')}.`);
  return project;
}

function projectPath(project, relativePath) {
  return resolve(project.directory, relativePath);
}

function projectLabel(project, relativePath) {
  return `${project.name}/${relativePath}`;
}

function jsonFieldValue(content, field, label) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    fail(`${label} is not valid JSON.`);
  }
  if (typeof data?.[field] !== 'string') fail(`${label} is missing ${field}.`);
  return data[field];
}

function replaceTomlProjectVersion(content, version, label) {
  const pattern = /(\[project\][\s\S]*?^version\s*=\s*")[^"]+(")/m;
  if (!pattern.test(content)) fail(`${label} is missing [project].version.`);
  return content.replace(pattern, (_match, prefix, suffix) => `${prefix}${version}${suffix}`);
}

function tomlProjectVersion(content, label) {
  const match = /(\[project\][\s\S]*?^version\s*=\s*")([^"]+)(")/m.exec(content);
  if (!match) fail(`${label} is missing [project].version.`);
  return match[2];
}

async function readVersion(project) {
  const relativePath = project.source.path;
  const content = await readFile(projectPath(project, relativePath), 'utf8');
  if (project.source.type === 'json') {
    return validateVersion(jsonFieldValue(content, project.source.field, projectLabel(project, relativePath)));
  }
  if (project.source.type === 'text') return validateVersion(content.trim());
  return validateVersion(tomlProjectVersion(content, projectLabel(project, relativePath)));
}

async function writeSourceVersion(project, version) {
  const relativePath = project.source.path;
  const path = projectPath(project, relativePath);
  if (project.source.type === 'text') {
    await writeIfChanged(path, `${version}\n`);
    return;
  }
  if (project.source.type === 'toml-project-version') {
    const content = await readFile(path, 'utf8');
    await writeIfChanged(path, replaceTomlProjectVersion(content, version, projectLabel(project, relativePath)));
    return;
  }
  const document = await readJson(path);
  document[project.source.field] = version;
  await writeIfChanged(path, jsonContent(document));
}

function uvPackagePattern(packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = ")([^"]+)(")`);
}

async function syncTarget(project, target, version) {
  const path = projectPath(project, target.path);
  const label = projectLabel(project, target.path);
  if (target.type === 'npm') {
    const packageJson = await readJson(path);
    packageJson.version = version;
    await writeIfChanged(path, jsonContent(packageJson));
    const lockPath = projectPath(project, target.lock);
    const lockJson = await readJson(lockPath);
    lockJson.version = version;
    if (lockJson.packages?.['']) lockJson.packages[''].version = version;
    await writeIfChanged(lockPath, jsonContent(lockJson));
    return;
  }
  if (target.type === 'version-file') {
    await writeIfChanged(path, `${version}\n`);
    return;
  }
  if (target.type === 'pyproject') {
    const content = await readFile(path, 'utf8');
    await writeIfChanged(path, replaceTomlProjectVersion(content, version, label));
    return;
  }
  if (target.type === 'uv-lock') {
    const content = await readFile(path, 'utf8');
    const pattern = uvPackagePattern(target.package);
    if (!pattern.test(content)) fail(`${label} is missing package ${target.package}.`);
    await writeIfChanged(path, content.replace(pattern, (_match, prefix, _current, suffix) => `${prefix}${version}${suffix}`));
    return;
  }
  if (target.type === 'python-version') {
    await writeIfChanged(path, `__version__ = "${version}"\n`);
    return;
  }
  if (target.type === 'runtime-ts') {
    const content = `// Generated from version.config.json. Run node scripts/version.mjs sync after editing the source.\nexport const ${target.name} = '${version}';\n`;
    await writeIfChanged(path, content);
    return;
  }
  if (target.type === 'json-field') {
    const document = await readJson(path);
    for (const [field, value] of Object.entries(target.require ?? {})) {
      if (document[field] !== value) fail(`${label} must have ${field}: ${value}.`);
    }
    document[target.field] = version;
    await writeIfChanged(path, jsonContent(document));
    return;
  }
  if (target.type === 'readme') {
    let content = await readFile(path, 'utf8');
    const line = `当前版本：\`${version}\`${target.suffix ?? ''}`;
    if (/^当前版本：.*$/m.test(content)) {
      content = content.replace(/^当前版本：.*$/m, line);
    } else {
      content = content.replace(/^(# [^\n]*\n)/, `$1\n${line}\n`);
    }
    await writeIfChanged(path, content);
    if (target.en) {
      const enPath = projectPath(project, target.en);
      let enContent;
      try {
        enContent = await readFile(enPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      const enLine = `Current Version: \`${version}\``;
      if (/^Current Version: .*$/m.test(enContent)) {
        enContent = enContent.replace(/^Current Version: .*$/m, enLine);
      } else {
        enContent = enContent.replace(/^(# [^\n]*\n)/, `$1\n${enLine}\n`);
      }
      await writeIfChanged(enPath, enContent);
    }
    return;
  }
  fail(`Unsupported target type "${target.type}".`);
}

async function checkTarget(project, target, version, errors) {
  const path = projectPath(project, target.path);
  const label = projectLabel(project, target.path);
  if (target.type === 'npm') {
    const packageJson = await readJson(path);
    if (packageJson.version !== version) errors.push(`${label} version is ${packageJson.version}`);
    const lockPath = projectPath(project, target.lock);
    const lockLabel = projectLabel(project, target.lock);
    const lockJson = await readJson(lockPath);
    if (lockJson.version !== version || lockJson.packages?.['']?.version !== version) {
      errors.push(`${lockLabel} root version is not ${version}`);
    }
    return;
  }
  if (target.type === 'version-file') {
    const current = (await readFile(path, 'utf8')).trim();
    if (current !== version) errors.push(`${label} is ${current}`);
    return;
  }
  if (target.type === 'pyproject') {
    const content = await readFile(path, 'utf8');
    if (tomlProjectVersion(content, label) !== version) errors.push(`${label} version is not ${version}`);
    return;
  }
  if (target.type === 'uv-lock') {
    const content = await readFile(path, 'utf8');
    const match = uvPackagePattern(target.package).exec(content);
    if (!match) errors.push(`${label} is missing package ${target.package}`);
    else if (match[2] !== version) errors.push(`${label} package version is not ${version}`);
    return;
  }
  if (target.type === 'python-version') {
    const current = (await readFile(path, 'utf8')).trim();
    if (current !== `__version__ = "${version}"`) errors.push(`${label} is stale`);
    return;
  }
  if (target.type === 'runtime-ts') {
    const content = await readFile(path, 'utf8');
    if (!content.includes(`${target.name} = '${version}'`)) errors.push(`${label} is stale`);
    return;
  }
  if (target.type === 'json-field') {
    const document = await readJson(path);
    for (const [field, value] of Object.entries(target.require ?? {})) {
      if (document[field] !== value) errors.push(`${label} must have ${field}: ${value}`);
    }
    if (document[target.field] !== version) errors.push(`${label} ${target.field} is not ${version}`);
    return;
  }
  if (target.type === 'readme') {
    const content = await readFile(path, 'utf8');
    if (!content.includes(`当前版本：\`${version}\`${target.suffix ?? ''}`)) errors.push(`${label} is missing ${version}`);
    if (target.en) {
      const enLabel = projectLabel(project, target.en);
      let enContent;
      try {
        enContent = await readFile(projectPath(project, target.en), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (!enContent.includes(`Current Version: \`${version}\``)) errors.push(`${enLabel} is missing ${version}`);
    }
    return;
  }
  fail(`Unsupported target type "${target.type}".`);
}

async function syncProject(project, version) {
  for (const target of project.targets) await syncTarget(project, target, version);
}

function aggregateVersions(entries) {
  return Object.fromEntries(entries.map(({ project, version }) => [project.name, version]));
}

function readmeTable(entries, language) {
  const header = language === 'en'
    ? ['| Project | Current Version |', '| --- | --- |']
    : ['| 项目 | 当前版本 |', '| --- | --- |'];
  return [
    '<!-- versions:start -->',
    ...header,
    ...entries.map(({ project, version }) => `| [${project.title}](${project.name}/) | \`${version}\` |`),
    '<!-- versions:end -->',
  ].join('\n');
}

function replaceTable(content, block, label) {
  if (!/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/.test(content)) {
    fail(`${label} is missing the versions:start / versions:end markers.`);
  }
  return content.replace(/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/, block);
}

async function writeAggregate(entries) {
  await writeIfChanged(aggregatePath, jsonContent(aggregateVersions(entries)));
  const readmePath = resolve(root, 'README.md');
  await writeIfChanged(readmePath, replaceTable(await readFile(readmePath, 'utf8'), readmeTable(entries, 'zh'), 'README.md'));
  const enPath = resolve(root, 'README.en.md');
  let enContent;
  try {
    enContent = await readFile(enPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await writeIfChanged(enPath, replaceTable(enContent, readmeTable(entries, 'en'), 'README.en.md'));
}

async function readEntries(projects) {
  const entries = [];
  for (const project of projects) entries.push({ project, version: await readVersion(project) });
  return entries;
}

async function checkVersions() {
  const projects = await loadProjects();
  const entries = [];
  const errors = [];
  for (const project of projects) {
    let version;
    try {
      version = await readVersion(project);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    entries.push({ project, version });
    for (const target of project.targets) {
      try {
        await checkTarget(project, target, version, errors);
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (project.notes) {
      try {
        extractReleaseNotes(await readFile(projectPath(project, project.notes), 'utf8'), version);
      } catch {
        errors.push(`${projectLabel(project, project.notes)} is missing release notes for ${version}`);
      }
    }
  }
  if (!errors.length) {
    const expected = jsonContent(aggregateVersions(entries));
    let current = '';
    try {
      current = await readFile(aggregatePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== expected) errors.push('versions.json is stale');
    const readmePath = resolve(root, 'README.md');
    const readmeContent = await readFile(readmePath, 'utf8');
    if (!readmeContent.includes(readmeTable(entries, 'zh'))) errors.push('README.md version table is stale');
    const enPath = resolve(root, 'README.en.md');
    try {
      const enContent = await readFile(enPath, 'utf8');
      if (!enContent.includes(readmeTable(entries, 'en'))) errors.push('README.en.md version table is stale');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (errors.length) fail(`Version files are out of sync:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

function projectFromCwd(projects, cwd = process.cwd()) {
  const current = resolve(cwd);
  return projects.find((project) => project.directory === current)?.name ?? '';
}

function usage() {
  return `Usage:
  node scripts/version.mjs show
  node scripts/version.mjs check
  node scripts/version.mjs sync
  node scripts/version.mjs notes [project] [version] [--with-title]
  node scripts/version.mjs set <project> <version>
  node scripts/version.mjs bump <project> <major|minor|patch>

Projects are discovered from <project>/${configName}; each project owns its
version source and the files that must follow it.

From a project directory, the project name may be omitted:
  cd <project> && node ../scripts/version.mjs bump patch
  cd <project> && node ../scripts/version.mjs notes`;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const [command = 'show', first, second] = rawArgs;
  const projects = await loadProjects();
  if (command === 'show') {
    const entries = await readEntries(projects);
    console.log(JSON.stringify(aggregateVersions(entries), null, 2));
    return;
  }
  if (command === 'check') {
    await checkVersions();
    console.log('All project versions are synchronized.');
    return;
  }
  if (command === 'sync') {
    const entries = await readEntries(projects);
    for (const { project, version } of entries) await syncProject(project, version);
    await writeAggregate(entries);
    console.log('Synchronized project version files and the repository version table.');
    return;
  }
  if (command === 'notes') {
    const withTitle = rawArgs.includes('--with-title');
    const positional = rawArgs.slice(1).filter((arg) => !arg.startsWith('--'));
    const inferred = projectFromCwd(projects);
    let projectName = '';
    let targetVersion = '';

    if (projects.some((project) => project.name === positional[0])) {
      projectName = positional[0];
      targetVersion = positional[1] || '';
    } else if (inferred) {
      projectName = inferred;
      targetVersion = positional[0] || '';
    } else if (positional[0]) {
      findProject(projects, positional[0]);
    } else {
      fail('Project name required when not running from a project directory.');
    }

    const project = findProject(projects, projectName);
    if (!project.notes) fail(`Project "${projectName}" does not declare release notes.`);
    const version = targetVersion || await readVersion(project);
    validateVersion(version);
    const notesContent = await readFile(projectPath(project, project.notes), 'utf8');
    console.log(extractReleaseNotes(notesContent, version, { includeHeading: withTitle }));
    return;
  }
  if (command === 'set' || command === 'bump') {
    const inferred = projectFromCwd(projects);
    const projectName = projects.some((project) => project.name === first) ? first : inferred;
    const value = projects.some((project) => project.name === first) ? second : first;
    if (!projectName) fail(usage());
    if (!value) fail(`${command} requires a version or bump type.`);
    const project = findProject(projects, projectName);
    const current = await readVersion(project);
    const next = command === 'set' ? validateVersion(value) : bumpVersion(current, value);
    await writeSourceVersion(project, next);
    await syncProject(project, next);
    const entries = await readEntries(projects);
    await writeAggregate(entries);
    console.log(`${project.title} version: ${next}`);
    return;
  }
  fail(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Version update failed: ${error.message}`);
    process.exitCode = 1;
  });
}

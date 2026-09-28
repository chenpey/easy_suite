#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const sourcePath = resolve(root, 'versions.json');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const projects = {
  easynote: {
    title: 'EasyNote',
    directory: 'easynote',
    packagePath: 'easynote/package.json',
    lockPath: 'easynote/package-lock.json',
    readmePath: 'easynote/README.md',
    runtimePath: 'easynote/src/shared/version.ts',
  },
  easydrop: {
    title: 'EasyDrop',
    directory: 'easydrop',
    packagePath: 'easydrop/package.json',
    lockPath: 'easydrop/package-lock.json',
    readmePath: 'easydrop/README.md',
  },
  easymac: {
    title: 'EasyMac',
    directory: 'easymac',
    readmePath: 'easymac/README.md',
    versionPath: 'easymac/VERSION',
    notesPath: 'easymac/RELEASE_NOTES.md',
  },
  easytest: {
    title: 'EasyTest',
    directory: 'easytest',
    readmePath: 'easytest/README.md',
    readmeVersionSuffix: '，支持 Python 3.12 和 3.13。',
    pyprojectPath: 'easytest/pyproject.toml',
    uvLockPath: 'easytest/uv.lock',
    pythonVersionPath: 'easytest/src/easytest/_version.py',
    compiledCasePaths: [
      'easytest/examples/jsonplaceholder/cases/demo.json',
      'easytest/examples/jsonplaceholder/failure_cases/mock_errors.json',
      'easytest/examples/jsonplaceholder/failure_cases/wrong_user_id.json',
      'easytest/examples/jsonplaceholder/mock_cases/demo.json',
      'easytest/tests/fixtures/project/cases/http/profile_api.json',
      'easytest/tests/fixtures/project/cases/rpc/limit_service.json',
      'easytest/tests/fixtures/project/cases/scenario/account_flow.json',
    ],
  },
};

function fail(message) {
  throw new Error(message);
}

function validateProject(name) {
  if (!projects[name]) {
    fail(`Unknown project "${name}". Use ${Object.keys(projects).join(', ')}.`);
  }
  return projects[name];
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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readVersions() {
  const versions = await readJson(sourcePath);
  for (const name of Object.keys(projects)) validateVersion(versions[name]);
  return versions;
}

async function writeIfChanged(path, content) {
  let current = '';
  try { current = await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== content) await writeFile(path, content);
}

function jsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function versionReadmeLine(version, project = {}) {
  return `当前版本：\`${version}\`${project.readmeVersionSuffix || ''}`;
}

function versionReadmeEnLine(version) {
  return `Current Version: \`${version}\``;
}

function rootReadmeBlock(versions) {
  return [
    '<!-- versions:start -->',
    '| 项目 | 当前版本 |',
    '| --- | --- |',
    `| [EasyDrop](easydrop/) | \`${versions.easydrop}\` |`,
    `| [EasyNote](easynote/) | \`${versions.easynote}\` |`,
    `| [EasyMac](easymac/) | \`${versions.easymac}\` |`,
    `| [EasyTest](easytest/) | \`${versions.easytest}\` |`,
    '<!-- versions:end -->',
  ].join('\n');
}

function rootReadmeEnBlock(versions) {
  return [
    '<!-- versions:start -->',
    '| Project | Current Version |',
    '| --- | --- |',
    `| [EasyDrop](easydrop/) | \`${versions.easydrop}\` |`,
    `| [EasyNote](easynote/) | \`${versions.easynote}\` |`,
    `| [EasyMac](easymac/) | \`${versions.easymac}\` |`,
    `| [EasyTest](easytest/) | \`${versions.easytest}\` |`,
    '<!-- versions:end -->',
  ].join('\n');
}

async function syncPackage(project, version) {
  if (!project.packagePath) return;
  const packagePath = resolve(root, project.packagePath);
  const packageJson = await readJson(packagePath);
  packageJson.version = version;
  await writeIfChanged(packagePath, jsonContent(packageJson));

  const lockPath = resolve(root, project.lockPath);
  const lockJson = await readJson(lockPath);
  lockJson.version = version;
  if (lockJson.packages?.['']) lockJson.packages[''].version = version;
  await writeIfChanged(lockPath, jsonContent(lockJson));
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

function replaceUvPackageVersion(content, packageName, version, label) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = ")[^"]+(")`,
  );
  if (!pattern.test(content)) fail(`${label} is missing package ${packageName}.`);
  return content.replace(pattern, (_match, prefix, suffix) => `${prefix}${version}${suffix}`);
}

function uvPackageVersion(content, packageName, label) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "([^"]+)"`,
  ).exec(content);
  if (!match) fail(`${label} is missing package ${packageName}.`);
  return match[1];
}

async function syncPythonPackage(project, version) {
  if (!project.pyprojectPath) return;
  const pyprojectPath = resolve(root, project.pyprojectPath);
  const pyproject = await readFile(pyprojectPath, 'utf8');
  await writeIfChanged(
    pyprojectPath,
    replaceTomlProjectVersion(pyproject, version, project.pyprojectPath),
  );

  const lockPath = resolve(root, project.uvLockPath);
  const lock = await readFile(lockPath, 'utf8');
  await writeIfChanged(
    lockPath,
    replaceUvPackageVersion(lock, project.directory, version, project.uvLockPath),
  );
  await writeIfChanged(
    resolve(root, project.pythonVersionPath),
    `__version__ = "${version}"\n`,
  );

  for (const relativePath of project.compiledCasePaths || []) {
    const path = resolve(root, relativePath);
    const document = await readJson(path);
    if (document.source_mode !== 'xlsx') {
      fail(`${relativePath} must be an XLSX-generated case document.`);
    }
    document.compiler_version = version;
    await writeIfChanged(path, jsonContent(document));
  }
}

async function syncVersionFile(project, version) {
  if (!project.versionPath) return;
  await writeIfChanged(resolve(root, project.versionPath), `${version}\n`);
}

async function syncProjectReadme(project, version) {
  const path = resolve(root, project.readmePath);
  let content = await readFile(path, 'utf8');
  const line = versionReadmeLine(version, project);
  if (/^当前版本：.*$/m.test(content)) {
    content = content.replace(/^当前版本：.*$/m, line);
  } else {
    content = content.replace(new RegExp(`^(# ${project.title}\\n)`), `$1\n${line}\n`);
  }
  await writeIfChanged(path, content);

  const enPath = resolve(root, project.directory, 'README.en.md');
  try {
    let enContent = await readFile(enPath, 'utf8');
    const enLine = versionReadmeEnLine(version);
    if (/^Current Version: .*$/m.test(enContent)) {
      enContent = enContent.replace(/^Current Version: .*$/m, enLine);
    } else {
      enContent = enContent.replace(new RegExp(`^(# ${project.title}\\n)`), `$1\n${enLine}\n`);
    }
    await writeIfChanged(enPath, enContent);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function syncRuntimeVersion(project, version) {
  if (!project.runtimePath) return;
  const content = `// Generated from versions.json. Run node scripts/version.mjs sync after editing the source.\nexport const EASYNOTE_VERSION = '${version}';\n`;
  await writeIfChanged(resolve(root, project.runtimePath), content);
}

async function syncReadme(versions) {
  const path = resolve(root, 'README.md');
  let content = await readFile(path, 'utf8');
  const block = rootReadmeBlock(versions);
  if (/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/.test(content)) {
    content = content.replace(/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/, block);
  } else {
    content = content.replace(/^(Easy Suite[\s\S]*?\n\n)/, `$1## 版本\n\n${block}\n\n`);
  }
  await writeIfChanged(path, content);

  const enPath = resolve(root, 'README.en.md');
  try {
    let enContent = await readFile(enPath, 'utf8');
    const enBlock = rootReadmeEnBlock(versions);
    if (/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/.test(enContent)) {
      enContent = enContent.replace(/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/, enBlock);
    }
    await writeIfChanged(enPath, enContent);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function syncAll(versions) {
  for (const [name, project] of Object.entries(projects)) {
    await syncPackage(project, versions[name]);
    await syncPythonPackage(project, versions[name]);
    await syncVersionFile(project, versions[name]);
    await syncProjectReadme(project, versions[name]);
    await syncRuntimeVersion(project, versions[name]);
  }
  await syncReadme(versions);
}

async function checkVersions(versions) {
  const errors = [];
  for (const [name, project] of Object.entries(projects)) {
    if (project.packagePath) {
      const packageJson = await readJson(resolve(root, project.packagePath));
      if (packageJson.version !== versions[name]) errors.push(`${project.packagePath} version is ${packageJson.version}`);
      const lockJson = await readJson(resolve(root, project.lockPath));
      if (lockJson.version !== versions[name] || lockJson.packages?.['']?.version !== versions[name]) {
        errors.push(`${project.lockPath} root version is not ${versions[name]}`);
      }
    }
    if (project.pyprojectPath) {
      const pyproject = await readFile(resolve(root, project.pyprojectPath), 'utf8');
      if (tomlProjectVersion(pyproject, project.pyprojectPath) !== versions[name]) {
        errors.push(`${project.pyprojectPath} version is not ${versions[name]}`);
      }
      const lock = await readFile(resolve(root, project.uvLockPath), 'utf8');
      if (uvPackageVersion(lock, project.directory, project.uvLockPath) !== versions[name]) {
        errors.push(`${project.uvLockPath} package version is not ${versions[name]}`);
      }
      const pythonVersion = await readFile(
        resolve(root, project.pythonVersionPath),
        'utf8',
      );
      if (pythonVersion.trim() !== `__version__ = "${versions[name]}"`) {
        errors.push(`${project.pythonVersionPath} is stale`);
      }
      for (const relativePath of project.compiledCasePaths || []) {
        const document = await readJson(resolve(root, relativePath));
        if (
          document.source_mode !== 'xlsx'
          || document.compiler_version !== versions[name]
        ) {
          errors.push(`${relativePath} compiler_version is not ${versions[name]}`);
        }
      }
    }
    if (project.versionPath) {
      const versionFile = (await readFile(resolve(root, project.versionPath), 'utf8')).trim();
      if (versionFile !== versions[name]) errors.push(`${project.versionPath} is ${versionFile}`);
    }
    const readme = await readFile(resolve(root, project.readmePath), 'utf8');
    if (!readme.includes(versionReadmeLine(versions[name], project))) {
      errors.push(`${project.readmePath} is missing ${versions[name]}`);
    }
    const enPath = resolve(root, project.directory, 'README.en.md');
    try {
      const enReadme = await readFile(enPath, 'utf8');
      if (!enReadme.includes(versionReadmeEnLine(versions[name]))) {
        errors.push(`${project.directory}/README.en.md is missing ${versions[name]}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (project.runtimePath) {
      const runtime = await readFile(resolve(root, project.runtimePath), 'utf8');
      if (!runtime.includes(`EASYNOTE_VERSION = '${versions[name]}'`)) errors.push(`${project.runtimePath} is stale`);
    }
    if (project.notesPath) {
      try {
        const notesContent = await readFile(resolve(root, project.notesPath), 'utf8');
        extractReleaseNotes(notesContent, versions[name]);
      } catch (error) {
        errors.push(`${project.notesPath} is missing release notes for ${versions[name]}`);
      }
    }
  }
  const rootReadme = await readFile(resolve(root, 'README.md'), 'utf8');
  if (!rootReadme.includes(rootReadmeBlock(versions))) errors.push('README.md version table is stale');
  const rootReadmeEnPath = resolve(root, 'README.en.md');
  try {
    const rootReadmeEn = await readFile(rootReadmeEnPath, 'utf8');
    if (!rootReadmeEn.includes(rootReadmeEnBlock(versions))) {
      errors.push('README.en.md version table is stale');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (errors.length) fail(`Version files are out of sync:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

function projectFromCwd() {
  const current = resolve(process.cwd());
  const match = Object.entries(projects).find(([, project]) => resolve(root, project.directory) === current);
  return match?.[0] ?? '';
}

function usage() {
  return `Usage:
  node scripts/version.mjs show
  node scripts/version.mjs check
  node scripts/version.mjs sync
  node scripts/version.mjs notes [project] [version] [--with-title]
  node scripts/version.mjs set <project> <version>
  node scripts/version.mjs bump <project> <major|minor|patch>

From a project directory, the project name may be omitted:
  cd easymac && node ../scripts/version.mjs bump patch
  cd easymac && node ../scripts/version.mjs notes`;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const [command = 'show', first, second] = rawArgs;
  const versions = await readVersions();
  if (command === 'show') {
    console.log(JSON.stringify(versions, null, 2));
    return;
  }
  if (command === 'check') {
    await checkVersions(versions);
    console.log('All project versions are synchronized.');
    return;
  }
  if (command === 'sync') {
    await syncAll(versions);
    console.log('Synchronized package metadata, runtime versions and README files.');
    return;
  }
  if (command === 'notes') {
    const withTitle = rawArgs.includes('--with-title');
    const positional = rawArgs.slice(1).filter((arg) => !arg.startsWith('--'));
    const inferred = projectFromCwd();
    let projectName = '';
    let targetVersion = '';

    if (projects[positional[0]]) {
      projectName = positional[0];
      targetVersion = positional[1] || '';
    } else if (inferred && projects[inferred]) {
      projectName = inferred;
      targetVersion = positional[0] || '';
    } else if (positional[0]) {
      validateProject(positional[0]);
    } else {
      fail('Project name required when not running from a project directory.');
    }

    const project = projects[projectName];
    if (!project.notesPath) {
      fail(`Project "${projectName}" does not have a notesPath configured.`);
    }

    const version = targetVersion || versions[projectName];
    validateVersion(version);

    const notesContent = await readFile(resolve(root, project.notesPath), 'utf8');
    const notes = extractReleaseNotes(notesContent, version, { includeHeading: withTitle });
    console.log(notes);
    return;
  }
  if (command === 'set' || command === 'bump') {
    const inferred = projectFromCwd();
    const projectName = projects[first] ? first : inferred;
    const value = projects[first] ? second : first;
    validateProject(projectName);
    if (!value) fail(`${command} requires a version or bump type.`);
    versions[projectName] = command === 'set'
      ? validateVersion(value)
      : bumpVersion(versions[projectName], value);
    await writeIfChanged(sourcePath, jsonContent(versions));
    await syncAll(versions);
    console.log(`${projects[projectName].title} version: ${versions[projectName]}`);
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

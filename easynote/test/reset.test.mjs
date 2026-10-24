import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { project, resetRemote } from "../scripts/reset.mjs";

// The CLI needs an interactive terminal before it will touch data. Tests that
// run the real command provide one through this preload instead of a pty;
// everything else (arguments, config loading, file changes, output) stays real.
const source = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories = [];
const accountId = "a".repeat(32);
const databaseId = "12345678-1234-4234-8234-123456789abc";
const credentials = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN", "CF_API_KEY"];

const terminalStub = `for (const stream of [process.stdin, process.stdout, process.stderr]) {
  try { Object.defineProperty(stream, "isTTY", { value: true, configurable: true }); } catch {}
}
`;

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

// Every case runs against a copy of this project's own reset.sh and
// scripts/reset.mjs, so the working tree's .wrangler state is never touched.
async function createProject() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "easynote-reset-")));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "scripts"));
  await cp(join(source, "reset.sh"), join(directory, "reset.sh"));
  await cp(join(source, "scripts", "reset.mjs"), join(directory, "scripts", "reset.mjs"));
  await writeFile(join(directory, "terminal.cjs"), terminalStub);
  await mkdir(join(directory, ".wrangler", "state"), { recursive: true });
  await writeFile(join(directory, ".wrangler", "state", "data"), "local");
  await writeFile(join(directory, ".dev.vars"), "INITIAL_OWNER='test'\n");
  return directory;
}

function runReset(directory, args, { input = "", terminal = true, env = {} } = {}) {
  const childEnvironment = { ...process.env };
  for (const name of credentials) delete childEnvironment[name];
  Object.assign(childEnvironment, env);
  if (terminal) childEnvironment.NODE_OPTIONS = `--require ${join(directory, "terminal.cjs")}`;
  else delete childEnvironment.NODE_OPTIONS;
  const result = spawnSync("bash", ["reset.sh", ...args], {
    cwd: directory,
    env: childEnvironment,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.error, undefined, `reset.sh did not finish: ${result.error}`);
  return result;
}

function cloudflareTarget(overrides = {}) {
  return {
    ...project,
    accountId,
    workerName: "note-worker",
    databaseName: "note-db",
    bucketName: "note-images",
    configPath: join(tmpdir(), "easynote-wrangler.deploy.json"),
    ...overrides,
  };
}

function deployConfig(overrides = {}) {
  return {
    name: "note-worker",
    account_id: accountId,
    d1_databases: [{ binding: "DB", database_name: "note-db", database_id: databaseId }],
    r2_buckets: [{ binding: "IMAGES", bucket_name: "note-images" }],
    ...overrides,
  };
}

test("help prints the supported reset commands", async () => {
  const directory = await createProject();
  const result = runReset(directory, ["--help"], { terminal: false });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bash reset\.sh --local/);
  assert.match(result.stdout, /bash reset\.sh --remote/);
  assert.match(result.stdout, /bash \.\.\/reset\.sh easynote --local\|--remote/);
});

test("invalid arguments print usage and exit non-zero", async () => {
  const directory = await createProject();
  const cases = [[], ["easynote"], ["--cloud"], ["--local", "--remote"]];

  for (const args of cases) {
    const label = args.join(" ") || "(no arguments)";
    const result = runReset(directory, args, { terminal: false });
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /Usage:/, label);
  }
});

test("a terminal is required before any reset starts", async () => {
  const directory = await createProject();
  const result = runReset(directory, ["--local"], {
    terminal: false,
    input: "reset easynote local\n",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /An interactive terminal is required/);
  assert.equal((await stat(join(directory, ".wrangler", "state"))).isDirectory(), true);
});

test("local reset removes Wrangler state and keeps account configuration", async () => {
  const directory = await createProject();
  const result = runReset(directory, ["--local"], {
    input: "reset easynote local\n",
  });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(join(directory, ".wrangler", "state")), { code: "ENOENT" });
  assert.equal(await readFile(join(directory, ".dev.vars"), "utf8"), "INITIAL_OWNER='test'\n");
  assert.match(result.stdout, /EasyNote local D1\/R2 state removed\./);
  assert.match(result.stdout, /Clear site data for http:\/\/127\.0\.0\.1:8791/);
});

test("local reset stops when the confirmation phrase is wrong", async () => {
  const directory = await createProject();
  const result = runReset(directory, ["--local"], {
    input: "reset easynote remote\n",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Reset cancelled\./);
  assert.equal((await stat(join(directory, ".wrangler", "state"))).isDirectory(), true);
});

test("remote reset explains a missing deployment target", async () => {
  const directory = await createProject();
  const result = runReset(directory, ["--remote"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrangler\.deploy\.json is missing/);
});

test("remote reset rejects unsafe deployment settings", async () => {
  const directory = await createProject();
  const configPath = join(directory, "wrangler.deploy.json");
  const cases = [
    { config: deployConfig({ account_id: "short" }), message: /Invalid Cloudflare account ID/ },
    {
      config: deployConfig({ d1_databases: [{ binding: "DB", database_name: "note-db", database_id: "not-a-uuid" }] }),
      message: /Invalid D1 database UUID/,
    },
    { config: deployConfig({ name: "x" }), message: /Invalid Worker name/ },
    {
      config: deployConfig({ r2_buckets: [{ binding: "FILES", bucket_name: "note-images" }] }),
      message: /Invalid R2 bucket name/,
    },
  ];

  for (const { config, message } of cases) {
    await writeFile(configPath, JSON.stringify(config));
    const result = runReset(directory, ["--remote"]);
    assert.equal(result.status, 1, JSON.stringify(config));
    assert.match(result.stderr, message);
  }
});

test("remote reset refuses credentials from the environment", async () => {
  const directory = await createProject();
  await writeFile(join(directory, "wrangler.deploy.json"), JSON.stringify(deployConfig()));

  const result = runReset(directory, ["--remote"], {
    env: { CLOUDFLARE_API_TOKEN: "secret" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Environment credentials are not accepted/);
});

// Destroying real Cloudflare resources cannot be observed end to end in a test.
// These cases mock only the external systems (wrangler and the Cloudflare API)
// and assert the visible effects: which resources are deleted, in what order,
// and what the command reports.
test("remote reset deletes tracked objects, recreates R2 and reapplies the D1 baseline", async () => {
  const target = cloudflareTarget();
  const keys = [
    "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444",
  ];
  const wranglerCalls = [];
  const requests = [];
  const output = [];
  const run = (args) => {
    wranglerCalls.push(args);
    const sql = args.includes("--command") ? args[args.indexOf("--command") + 1] : "";
    if (sql.includes("sqlite_master")) {
      return JSON.stringify([{ success: true, results: [{ name: target.objectTable }] }]);
    }
    if (sql === target.objectQuery) {
      return JSON.stringify([{ success: true, results: keys.map((object_key) => ({ object_key })) }]);
    }
    return "";
  };
  const request = async (method, path, body) => {
    requests.push({ method, path, body });
    return {};
  };

  await resetRemote(target, "secret", { run, request, log: (line) => output.push(line) });

  assert.deepEqual(
    wranglerCalls.filter((args) => args[0] === "r2" && args[1] === "object").map((args) => args[3]),
    keys.map((key) => `${target.bucketName}/${key}`),
  );
  assert.ok(wranglerCalls.some((args) => args[0] === "d1" && args[1] === "execute" && args.includes(target.dropSql)));
  assert.ok(wranglerCalls.some((args) => args.slice(0, 3).join(" ") === "d1 migrations apply"));
  assert.match(target.dropSql, /DROP TABLE IF EXISTS notes/);
  assert.deepEqual(
    requests.map(({ method, path }) => `${method} ${path}`),
    [
      `DELETE /accounts/${accountId}/workers/scripts/${target.workerName}`,
      `DELETE /accounts/${accountId}/r2/buckets/${target.bucketName}`,
      `POST /accounts/${accountId}/r2/buckets`,
    ],
  );
  assert.match(output.join("\n"), /Tracked R2 objects to delete: 2/);
  assert.match(output.join("\n"), /Deleted R2 objects: 2\/2/);
  assert.match(output.join("\n"), /were reset\./);
});

test("remote reset stops before deleting when D1 reports an unexpected object key", async () => {
  const target = cloudflareTarget();
  let requests = 0;
  const run = (args) => {
    const sql = args.includes("--command") ? args[args.indexOf("--command") + 1] : "";
    if (sql.includes("sqlite_master")) {
      return JSON.stringify([{ success: true, results: [{ name: target.objectTable }] }]);
    }
    if (sql === target.objectQuery) {
      return JSON.stringify([{ success: true, results: [{ object_key: "../other" }] }]);
    }
    return "";
  };

  await assert.rejects(
    resetRemote(target, "secret", { run, request: async () => { requests += 1; }, log: () => {} }),
    /unexpected R2 object key/,
  );
  assert.equal(requests, 0);
});

test("remote reset stops when wrangler returns unusable D1 output", async () => {
  const target = cloudflareTarget();
  const replies = [
    { output: "not json", message: /invalid JSON/ },
    { output: JSON.stringify([{ success: false, results: [] }]), message: /invalid D1 result/ },
  ];

  for (const { output, message } of replies) {
    let requests = 0;
    const run = () => output;
    await assert.rejects(
      resetRemote(target, "secret", { run, request: async () => { requests += 1; }, log: () => {} }),
      message,
    );
    assert.equal(requests, 0, message.source);
  }
});

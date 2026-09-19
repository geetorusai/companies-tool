import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildCommonGeetorusArgs,
  compareGeetorusVersions,
  DEFAULT_GEETORUS_API_BASE,
  isGeetorusVersionSupported,
  listGeetorusCompanies,
  resolveCompanySelector,
  resolveGeetorusCommand,
  resolveLocalGeetorusConnection,
  runGeetorus,
  sanitizeGeetorusChildEnv,
  setSpawnImplementationForTests,
} from "./geetorus.js";

function stubSpawn(options: { stdout?: string; exitCode?: number } = {}) {
  const calls: Array<[string, string[], childProcess.SpawnOptions]> = [];

  setSpawnImplementationForTests(((command: string, args: string[], spawnOptions?: childProcess.SpawnOptions) => {
    calls.push([command, args, spawnOptions ?? {}]);
    const child = new EventEmitter() as childProcess.ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();

    Object.assign(child, {
      stdout,
      stderr: new PassThrough(),
      stdin: null,
    });

    queueMicrotask(() => {
      if (options.stdout) {
        stdout.write(options.stdout);
      }
      stdout.end();
      child.emit("exit", options.exitCode ?? 0);
    });

    return child;
  }) as typeof childProcess.spawn);

  return {
    calls,
    restore() {
      setSpawnImplementationForTests(null);
    },
  };
}

test("buildCommonGeetorusArgs appends shared CLI flags in order", () => {
  assert.deepEqual(
    buildCommonGeetorusArgs({
      config: "./config.json",
      dataDir: "./data",
      context: "./context.json",
      profile: "dev",
      apiBase: "http://localhost:3100",
      apiKey: "secret",
      json: true,
    }),
    [
      "--config",
      "./config.json",
      "--data-dir",
      "./data",
      "--context",
      "./context.json",
      "--profile",
      "dev",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "secret",
      "--json",
    ],
  );
});

test("resolveGeetorusCommand supports prefixed commands from GEETORUSAI_CMD", () => {
  assert.deepEqual(
    resolveGeetorusCommand("pnpm --dir '/tmp/geetorus cli' geetorusai"),
    {
      command: "pnpm",
      prefixArgs: ["--dir", "/tmp/geetorus cli", "geetorusai"],
    },
  );
});

test("runGeetorus spawns the configured Geetorus command with translated args", async () => {
  const original = process.env.GEETORUSAI_CMD;
  process.env.GEETORUSAI_CMD = "pnpm --dir /tmp/geetorus geetorusai";

  const spawnMock = stubSpawn();
  try {
    await runGeetorus(["company", "list"], {
      captureStdout: true,
      config: "./config.json",
      profile: "dev",
    });
  } finally {
    spawnMock.restore();
    if (original === undefined) {
      delete process.env.GEETORUSAI_CMD;
    } else {
      process.env.GEETORUSAI_CMD = original;
    }
  }

  assert.equal(spawnMock.calls.length, 1);
  const [command, args, options] = spawnMock.calls[0] as [
    string,
    string[],
    childProcess.SpawnOptions,
  ];

  assert.equal(command, "pnpm");
  assert.deepEqual(args, ["--dir", "/tmp/geetorus", "geetorusai", "company", "list", "--config", "./config.json", "--profile", "dev"]);
  assert.equal(options.shell, false);
});

test("sanitizeGeetorusChildEnv strips injected Geetorus runtime env while keeping user config env", () => {
  const sanitized = sanitizeGeetorusChildEnv({
    GEETORUS_AGENT_ID: "agent-1",
    GEETORUS_API_KEY: "secret",
    GEETORUS_API_URL: "http://127.0.0.1:3100",
    GEETORUS_DEPLOYMENT_MODE: "authenticated",
    GEETORUS_HOME: "/tmp/geetorus-home",
    GEETORUS_INSTANCE_ID: "default",
    GEETORUS_CONFIG: "/tmp/config.json",
    PATH: process.env.PATH,
  });

  assert.equal(sanitized.GEETORUS_AGENT_ID, undefined);
  assert.equal(sanitized.GEETORUS_API_KEY, undefined);
  assert.equal(sanitized.GEETORUS_API_URL, undefined);
  assert.equal(sanitized.GEETORUS_DEPLOYMENT_MODE, undefined);
  assert.equal(sanitized.GEETORUS_HOME, "/tmp/geetorus-home");
  assert.equal(sanitized.GEETORUS_INSTANCE_ID, "default");
  assert.equal(sanitized.GEETORUS_CONFIG, "/tmp/config.json");
});

test("listGeetorusCompanies parses JSON output from geetorusai company list", async () => {
  const spawnMock = stubSpawn({
    stdout: JSON.stringify([{ id: "company-1", name: "Acme", issuePrefix: "AC" }]),
  });

  try {
    const companies = await listGeetorusCompanies({});
    assert.deepEqual(companies, [{ id: "company-1", name: "Acme", issuePrefix: "AC" }]);
  } finally {
    spawnMock.restore();
  }
});

test("resolveCompanySelector matches company issue prefix via company list lookup", async () => {
  const spawnMock = stubSpawn({
    stdout: JSON.stringify([
      { id: "company-1", name: "Acme", issuePrefix: "AC" },
      { id: "company-2", name: "Beta", issuePrefix: "BET" },
    ]),
  });

  try {
    const resolved = await resolveCompanySelector("bet", {});
    assert.equal(resolved, "company-2");
  } finally {
    spawnMock.restore();
  }
});

test("compareGeetorusVersions handles canary prereleases", () => {
  assert.equal(compareGeetorusVersions("2026.324.0-canary.2", "2026.324.0-canary.0") > 0, true);
  assert.equal(compareGeetorusVersions("2026.324.0", "2026.324.0-canary.9") > 0, true);
  assert.equal(compareGeetorusVersions("2026.324.9", "2026.325.0-canary.0") < 0, true);
});

test("isGeetorusVersionSupported enforces the minimum stable gate", () => {
  assert.equal(isGeetorusVersionSupported("2026.325.0"), true);
  assert.equal(isGeetorusVersionSupported("2026.325.1-canary.1"), true);
  assert.equal(isGeetorusVersionSupported("2026.325.0-canary.1"), false);
  assert.equal(isGeetorusVersionSupported("2026.324.9"), false);
});

test("resolveLocalGeetorusConnection uses a discovered project config when present", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "companies-geetorus-config-"));
  const projectDir = path.join(tempRoot, "workspace", "nested");
  const configDir = path.join(tempRoot, "workspace", ".geetorus");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      server: {
        host: "0.0.0.0",
        port: 4100,
      },
    }),
    "utf8",
  );

  try {
    const resolved = resolveLocalGeetorusConnection({}, projectDir, {});
    assert.equal(resolved.configExists, true);
    assert.equal(resolved.apiBase, "http://127.0.0.1:4100");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLocalGeetorusConnection falls back to the default local base when config is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "companies-geetorus-default-"));

  try {
    const resolved = resolveLocalGeetorusConnection({ dataDir: path.join(tempRoot, "pc-home") }, tempRoot, {});
    assert.equal(resolved.configExists, false);
    assert.equal(resolved.apiBase, DEFAULT_GEETORUS_API_BASE);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLocalGeetorusConnection respects HOST and PORT env overrides before onboarding", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "companies-geetorus-env-"));

  try {
    const resolved = resolveLocalGeetorusConnection(
      { dataDir: path.join(tempRoot, "pc-home") },
      tempRoot,
      { HOST: "0.0.0.0", PORT: "3210" },
    );
    assert.equal(resolved.configExists, false);
    assert.equal(resolved.apiBase, "http://127.0.0.1:3210");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildAddGeetorusArgs,
  buildListGeetorusArgs,
  getUnsupportedAutoBootstrapMessage,
  isDirectCliInvocation,
  pickProvider,
  promptGeetorusConnection,
  promptSource,
  promptTargetMode,
  resolveGeetorusRunApiBase,
} from "./index.js";

test("buildAddGeetorusArgs translates wrapper add options to geetorus import args", () => {
  assert.deepEqual(
    buildAddGeetorusArgs({
      source: "./fixtures/company",
      includeArg: "company,agents,projects,issues,skills",
      target: "existing",
      agents: "ceo,cto",
      collision: "replace",
      companyId: "company-123",
      dryRun: true,
      yes: true,
    }),
    [
      "company",
      "import",
      "./fixtures/company",
      "--include",
      "company,agents,projects,issues,skills",
      "--target",
      "existing",
      "--agents",
      "ceo,cto",
      "--collision",
      "replace",
      "--company-id",
      "company-123",
      "--dry-run",
      "--yes",
    ],
  );
});

test("buildAddGeetorusArgs auto-applies imports through the wrapped geetorus command", () => {
  assert.deepEqual(
    buildAddGeetorusArgs({
      source: "./fixtures/company",
      includeArg: "company,agents",
      target: "new",
    }),
    [
      "company",
      "import",
      "./fixtures/company",
      "--include",
      "company,agents",
      "--target",
      "new",
      "--agents",
      "all",
      "--collision",
      "rename",
    ],
  );
});

test("buildListGeetorusArgs returns the company list command", () => {
  assert.deepEqual(buildListGeetorusArgs(), ["company", "list"]);
});

test("pickProvider defaults to geetorus in non-interactive mode", async () => {
  assert.equal(await pickProvider(undefined, true), "geetorus");
});

test("promptTargetMode defaults to new in non-interactive mode", async () => {
  assert.equal(await promptTargetMode(undefined, true), "new");
});

test("promptSource fails fast in non-interactive mode when no source is provided", async () => {
  await assert.rejects(() => promptSource(undefined, true), /A source is required in non-interactive mode/);
});

test("promptGeetorusConnection defaults to auto in non-interactive mode", async () => {
  assert.deepEqual(await promptGeetorusConnection({ yes: true }), { mode: "auto" });
});

test("promptGeetorusConnection treats apiBase as custom-url", async () => {
  assert.deepEqual(
    await promptGeetorusConnection({ apiBase: "http://localhost:3100/" }),
    { mode: "custom-url", apiBase: "http://localhost:3100" },
  );
});

test("resolveGeetorusRunApiBase only forwards apiBase for custom-url mode", () => {
  assert.equal(resolveGeetorusRunApiBase("auto", "http://127.0.0.1:3100"), undefined);
  assert.equal(resolveGeetorusRunApiBase("custom-url", "http://localhost:3100"), "http://localhost:3100");
});

test("getUnsupportedAutoBootstrapMessage blocks linux root auto bootstrap", () => {
  assert.match(
    getUnsupportedAutoBootstrapMessage("linux", 0) ?? "",
    /not supported when this command runs as root on Linux/,
  );
  assert.equal(getUnsupportedAutoBootstrapMessage("linux", 1000), undefined);
  assert.equal(getUnsupportedAutoBootstrapMessage("darwin", 0), undefined);
});

test("isDirectCliInvocation treats npm bin symlinks as direct execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "companies-cli-"));
  const modulePath = join(dir, "dist-index.js");
  const shimPath = join(dir, "companies.sh");

  try {
    writeFileSync(modulePath, "console.log('test');\n");
    symlinkSync(modulePath, shimPath);

    assert.equal(isDirectCliInvocation(shimPath, new URL(`file://${modulePath}`).href), true);
    assert.equal(isDirectCliInvocation(modulePath, new URL(`file://${modulePath}`).href), true);
    assert.equal(isDirectCliInvocation(join(dir, "other.js"), new URL(`file://${modulePath}`).href), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

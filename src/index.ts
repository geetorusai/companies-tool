#!/usr/bin/env node

import { intro, outro, select, text, isCancel, cancel, note } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertGeetorusApiReady,
  DEFAULT_GEETORUS_API_BASE,
  ensureLocalGeetorusReady,
  listGeetorusCompanies,
  normalizeApiBase,
  printWarnings,
  runGeetorus,
  type CommonGeetorusOptions,
  type GeetorusBootstrapResult,
  type GeetorusCompanyRecord,
} from "./geetorus.js";
import {
  INCLUDE_OPTION_HELP_TEXT,
  normalizeIncludeValues,
  resolveProvider,
} from "./flags.js";
import { normalizeSourceInput } from "./sources.js";
import {
  prepareInstallTelemetry,
  sendInstallCompletedTelemetry,
} from "./telemetry.js";

type TargetMode = "new" | "existing";
type CollisionMode = "rename" | "skip" | "replace";
type ConnectionMode = "auto" | "custom-url";

interface BaseOptions extends CommonGeetorusOptions {
  connection?: ConnectionMode;
  provider?: string;
  yes?: boolean;
}

interface AddOptions extends BaseOptions {
  include?: string;
  target?: TargetMode;
  agents?: string;
  collision?: CollisionMode;
  dryRun?: boolean;
}

const INCLUDE_OPTION_DESCRIPTION = `Comma-separated include set: ${INCLUDE_OPTION_HELP_TEXT}`;
const packageVersion = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function isDirectCliInvocation(executedPath: string | undefined, moduleUrl: string): boolean {
  if (!executedPath) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);

  try {
    return realpathSync(executedPath) === realpathSync(modulePath);
  } catch {
    return executedPath === modulePath;
  }
}

function addCommonOptions(command: Command, opts?: { includeCompanyId?: boolean }): Command {
  const configured = command
    .option("-p, --provider <provider>", "Destination provider")
    .option("-y, --yes", "Skip interactive prompts", false)
    .option("-c, --config <path>", "Path to Geetorus config file")
    .option("-d, --data-dir <path>", "Geetorus data directory root")
    .option("--context <path>", "Path to Geetorus CLI context file")
    .option("--profile <name>", "Geetorus CLI context profile name")
    .option("--api-base <url>", "Geetorus API base URL")
    .option("--api-key <token>", "Geetorus API key");

  if (opts?.includeCompanyId) {
    configured.option("-C, --company-id <id>", "Geetorus company id");
  }

  return configured;
}

function fail(message: string): never {
  console.error(pc.red(message));
  process.exit(1);
}

function coerceCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled");
    process.exit(1);
  }
  return value;
}

export async function pickProvider(current: string | undefined, skipPrompts: boolean): Promise<"geetorus"> {
  if (current?.trim()) {
    return resolveProvider(current);
  }

  if (skipPrompts) {
    return "geetorus";
  }

  const result = await select({
    message: "Which service do you want to import your company into?",
    options: [
      {
        value: "geetorus",
        label: "geetorus",
        hint: "The current launch provider",
      },
    ],
  });

  return resolveProvider(coerceCancel(result));
}

export async function promptTargetMode(current: TargetMode | undefined, skipPrompts: boolean): Promise<TargetMode> {
  if (current) return current;
  if (skipPrompts) return "new";

  const result = await select({
    message: "Where should this company be imported?",
    options: [
      { value: "new", label: "New company", hint: "Create a fresh company in Geetorus" },
      { value: "existing", label: "Existing company", hint: "Import into an existing Geetorus company" },
    ],
  });

  return coerceCancel(result);
}

export async function promptSource(current: string | undefined, skipPrompts: boolean): Promise<string> {
  if (current?.trim()) return normalizeSourceInput(current);
  if (skipPrompts) {
    throw new Error("A source is required in non-interactive mode.");
  }

  const result = await text({
    message: "Where is the company package?",
    placeholder: "owner/repo, full Git URL, or local path",
  });

  return normalizeSourceInput(coerceCancel(result));
}

function resolveConnectionMode(input: string | undefined): ConnectionMode | undefined {
  if (!input?.trim()) return undefined;
  const normalized = input.trim().toLowerCase();
  if (normalized === "auto" || normalized === "custom-url") {
    return normalized;
  }
  throw new Error(`Invalid --connection value '${input}'. Use auto or custom-url.`);
}

export async function promptGeetorusConnection(
  options: BaseOptions,
): Promise<{ mode: ConnectionMode; apiBase?: string }> {
  if (options.apiBase?.trim()) {
    return {
      mode: "custom-url",
      apiBase: normalizeApiBase(options.apiBase),
    };
  }

  const explicitMode = resolveConnectionMode(options.connection);
  if (explicitMode === "custom-url") {
    if (options.yes) {
      throw new Error("--api-base is required when --connection custom-url is used in non-interactive mode.");
    }

    const entered = await text({
      message: "Geetorus URL",
      placeholder: DEFAULT_GEETORUS_API_BASE,
      defaultValue: DEFAULT_GEETORUS_API_BASE,
    });
    return {
      mode: "custom-url",
      apiBase: normalizeApiBase(coerceCancel(entered)),
    };
  }

  if (explicitMode === "auto" || options.yes) {
    return { mode: "auto" };
  }

  const selected = await select({
    message: "How should companies connect to Geetorus?",
    options: [
      {
        value: "auto",
        label: "auto",
        hint: "Use the local Geetorus install, onboard if needed, and start it if it is not running",
      },
      {
        value: "custom-url",
        label: "custom-url",
        hint: "Use a specific Geetorus base URL",
      },
    ],
    initialValue: "auto",
  });
  const mode = coerceCancel(selected) as ConnectionMode;
  if (mode === "auto") {
    return { mode };
  }

  const entered = await text({
    message: "Geetorus URL",
    placeholder: DEFAULT_GEETORUS_API_BASE,
    defaultValue: DEFAULT_GEETORUS_API_BASE,
  });
  return {
    mode,
    apiBase: normalizeApiBase(coerceCancel(entered)),
  };
}

async function promptExistingCompanyId(options: BaseOptions): Promise<string> {
  const companies = await listGeetorusCompanies(options).catch(() => []);
  if (options.yes || companies.length === 0) {
    const typed = await text({
      message: "Target company id",
      placeholder: "uuid",
    });
    return coerceCancel(typed).trim();
  }

  const picked = await select({
    message: "Choose the Geetorus company to import into",
    options: companies.map((company) => ({
      value: company.id,
      label: company.name,
      hint: company.issuePrefix ? `${company.issuePrefix} - ${company.id}` : company.id,
    })),
  });

  return coerceCancel(picked).trim();
}

export function resolveGeetorusRunApiBase(
  mode: ConnectionMode,
  apiBase: string,
): string | undefined {
  return mode === "custom-url" ? apiBase : undefined;
}

export function getUnsupportedAutoBootstrapMessage(
  platform = process.platform,
  uid = process.getuid?.(),
): string | undefined {
  if (platform === "linux" && uid === 0) {
    return [
      "Automatic local Geetorus bootstrap is not supported when this command runs as root on Linux.",
      "Run it as a regular user instead (for Docker hand-tests, `su node -s /bin/bash` first),",
      "or connect to an existing Geetorus instance with --connection custom-url --api-base <url>.",
    ].join(" ");
  }

  return undefined;
}

async function prepareGeetorus(options: BaseOptions): Promise<GeetorusBootstrapResult & { mode: ConnectionMode }> {
  const connection = await promptGeetorusConnection(options);
  return prepareGeetorusWithConnection(connection, options);
}

async function prepareGeetorusWithConnection(
  connection: { mode: ConnectionMode; apiBase?: string },
  options: BaseOptions,
): Promise<GeetorusBootstrapResult & { mode: ConnectionMode }> {
  if (connection.mode === "auto") {
    const unsupportedMessage = getUnsupportedAutoBootstrapMessage();
    if (unsupportedMessage) {
      throw new Error(unsupportedMessage);
    }

    if (!options.yes) {
      note("Starting local Geetorus", "Preparing Geetorus");
    }

    return {
      ...(await ensureLocalGeetorusReady(options)),
      mode: "auto",
    };
  }

  return {
    ...(await assertGeetorusApiReady(connection.apiBase ?? DEFAULT_GEETORUS_API_BASE)),
    mode: "custom-url",
  };
}

export function buildAddGeetorusArgs(input: {
  source: string;
  includeArg: string;
  target: TargetMode;
  agents?: string;
  collision?: CollisionMode;
  companyId?: string;
  dryRun?: boolean;
  yes?: boolean;
}): string[] {
  const args = [
    "company",
    "import",
    input.source,
    "--include",
    input.includeArg,
    "--target",
    input.target,
    "--agents",
    input.agents?.trim() || "all",
    "--collision",
    input.collision?.trim() || "rename",
  ];

  if (input.companyId) {
    args.push("--company-id", input.companyId);
  }
  if (input.dryRun) {
    args.push("--dry-run");
  }
  if (input.yes) {
    args.push("--yes");
  }

  return args;
}

export function buildListGeetorusArgs(): string[] {
  return ["company", "list"];
}

export async function handleAdd(source: string | undefined, options: AddOptions): Promise<void> {
  intro("companies.sh");

  const provider = await pickProvider(options.provider, Boolean(options.yes));
  if (provider !== "geetorus") {
    fail("Only geetorus is supported.");
  }

  const include = normalizeIncludeValues(options.include);
  printWarnings(include.warnings);

  const connection = await promptGeetorusConnection(options);
  const normalizedSource = await promptSource(source, Boolean(options.yes));
  const target = await promptTargetMode(options.target, Boolean(options.yes));

  const telemetry = await prepareInstallTelemetry(normalizedSource, target);

  const prepared = await prepareGeetorusWithConnection(connection, options);
  const geetorusOptions: AddOptions = {
    ...options,
    apiBase: resolveGeetorusRunApiBase(prepared.mode, prepared.apiBase),
  };

  const companyId = target === "existing"
    ? (options.companyId?.trim() || await promptExistingCompanyId(geetorusOptions))
    : undefined;

  const args = buildAddGeetorusArgs({
    source: normalizedSource,
    includeArg: include.includeArg,
    target,
    agents: options.agents,
    collision: options.collision,
    companyId,
    dryRun: options.dryRun,
    yes: options.yes,
  });

  note(
    [
      `provider: ${provider}`,
      `geetorus: ${prepared.apiBase} (${prepared.mode}${prepared.startedServer ? ", started locally" : ""})`,
      `geetorusai: ${prepared.version}`,
      `source: ${normalizedSource}`,
      `target: ${target}${companyId ? ` (${companyId})` : ""}`,
      `include: ${include.includeArg}`,
      `telemetry: ${telemetry.enabled ? "enabled" : "disabled"}${telemetry.companySlug ? ` (${telemetry.companySlug})` : ""}`,
    ].join("\n"),
    "Running",
  );

  await runGeetorus(args, geetorusOptions);
  await sendInstallCompletedTelemetry(telemetry);
  outro("Geetorus import finished.");
}

export async function handleList(options: BaseOptions): Promise<void> {
  intro("companies.sh");
  const provider = await pickProvider(options.provider, Boolean(options.yes));
  if (provider !== "geetorus") {
    fail("Only geetorus is supported.");
  }

  const prepared = await prepareGeetorus(options);
  const geetorusOptions: CommonGeetorusOptions = {
    ...options,
    apiBase: resolveGeetorusRunApiBase(prepared.mode, prepared.apiBase),
  };

  const companies = await listGeetorusCompanies(geetorusOptions);

  for (const company of companies) {
    const status = company.status ?? "unknown";
    const statusColor = status === "active" ? pc.green(status) : pc.dim(status);
    console.log(`${pc.bold(company.name)} ${pc.dim(`(${company.id})`)} ${statusColor}`);
  }

  outro("Geetorus company list finished.");
}

const program = new Command();

program
  .name("companies.sh")
  .description("A skills-style CLI for importing Agent Companies into supported providers")
  .version(packageVersion);

addCommonOptions(
  program
    .command("add")
    .alias("import")
    .description("Import an Agent Company into a provider")
    .argument("[source]", "Source path or repository")
    .option("--connection <mode>", "Geetorus connection mode: auto | custom-url")
    .option("--include <values>", INCLUDE_OPTION_DESCRIPTION, "company,agents")
    .option("--target <mode>", "Import target: new | existing")
    .option("--agents <list>", "Comma-separated agent slugs to import, or all", "all")
    .option("--collision <mode>", "Collision strategy: rename | skip | replace", "rename")
    .option("--dry-run", "Preview the import without applying it", false)
    .action((source: string | undefined, options: AddOptions) => {
      handleAdd(source, options).catch((error) => fail(error instanceof Error ? error.message : String(error)));
    }),
  { includeCompanyId: true },
);

addCommonOptions(
  program
    .command("list")
    .alias("ls")
    .description("List companies visible through the provider")
    .option("--connection <mode>", "Geetorus connection mode: auto | custom-url")
    .action((options: BaseOptions) => {
      handleList(options).catch((error) => fail(error instanceof Error ? error.message : String(error)));
    }),
);

if (isDirectCliInvocation(process.argv[1], import.meta.url)) {
  program.parseAsync().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}

import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

export interface CommonGeetorusOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  companyId?: string;
  json?: boolean;
}

export interface GeetorusRunOptions extends CommonGeetorusOptions {
  captureStdout?: boolean;
}

export interface GeetorusCompanyRecord {
  id: string;
  name: string;
  issuePrefix?: string | null;
  status?: string | null;
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number | null;
}

export interface GeetorusConnectionResolution {
  apiBase: string;
  configExists: boolean;
  configPath: string;
}

export interface GeetorusBootstrapResult {
  apiBase: string;
  startedServer: boolean;
  version: string;
}

export const DEFAULT_GEETORUS_API_BASE = "http://127.0.0.1:3100";
export const MINIMUM_GEETORUS_VERSION = "2026.325.0";
export const DEFAULT_GEETORUS_READY_TIMEOUT_MS = 120_000;

const require = createRequire(import.meta.url);
const STRIPPED_GEETORUS_CHILD_ENV_KEYS = [
  "GEETORUS_AGENT_ID",
  "GEETORUS_API_KEY",
  "GEETORUS_API_URL",
  "GEETORUS_APPROVAL_ID",
  "GEETORUS_APPROVAL_STATUS",
  "GEETORUS_AUTH_BASE_URL_MODE",
  "GEETORUS_COMPANY_ID",
  "GEETORUS_DEPLOYMENT_EXPOSURE",
  "GEETORUS_DEPLOYMENT_MODE",
  "GEETORUS_DEV_SERVER_STATUS_FILE",
  "GEETORUS_LINKED_ISSUE_IDS",
  "GEETORUS_LISTEN_HOST",
  "GEETORUS_LISTEN_PORT",
  "GEETORUS_RUN_ID",
  "GEETORUS_TASK_ID",
  "GEETORUS_UI_DEV_MIDDLEWARE",
  "GEETORUS_WAKE_COMMENT_ID",
  "GEETORUS_WAKE_REASON",
  "GEETORUS_WORKSPACE_CWD",
  "GEETORUS_WORKSPACE_ID",
  "GEETORUS_WORKSPACE_REPO_URL",
  "GEETORUS_WORKSPACES_JSON",
];

export function buildCommonGeetorusArgs(options: CommonGeetorusOptions): string[] {
  const args: string[] = [];
  appendFlag(args, "--config", options.config);
  appendFlag(args, "--data-dir", options.dataDir);
  appendFlag(args, "--context", options.context);
  appendFlag(args, "--profile", options.profile);
  appendFlag(args, "--api-base", options.apiBase);
  appendFlag(args, "--api-key", options.apiKey);
  if (options.json) {
    args.push("--json");
  }
  return args;
}

export interface GeetorusCommand {
  command: string;
  prefixArgs: string[];
}

export type SpawnImplementation = typeof childProcess.spawn;

let spawnImplementation: SpawnImplementation = childProcess.spawn;

export function setSpawnImplementationForTests(next: SpawnImplementation | null): void {
  spawnImplementation = next ?? childProcess.spawn;
}

export function sanitizeGeetorusChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };

  for (const key of STRIPPED_GEETORUS_CHILD_ENV_KEYS) {
    delete sanitized[key];
  }

  return sanitized;
}

export function resolveGeetorusCommand(raw = process.env.GEETORUSAI_CMD?.trim()): GeetorusCommand {
  if (!raw) {
    const bundledShim = resolveBundledGeetorusShim();
    if (bundledShim) {
      return {
        command: process.execPath,
        prefixArgs: [bundledShim],
      };
    }

    return {
      command: "geetorusai",
      prefixArgs: [],
    };
  }

  const tokens = splitCommandString(raw);
  const [command, ...prefixArgs] = tokens;
  if (!command) {
    throw new Error("GEETORUSAI_CMD must not be empty.");
  }

  return { command, prefixArgs };
}

export async function runGeetorus(args: string[], options: GeetorusRunOptions = {}): Promise<string> {
  const captureStdout = Boolean(options.captureStdout);
  const { command, prefixArgs } = resolveGeetorusCommand();
  const fullArgs = [...prefixArgs, ...args, ...buildCommonGeetorusArgs(options)];

  return await new Promise<string>((resolve, reject) => {
    const child = spawnImplementation(command, fullArgs, {
      stdio: captureStdout ? ["inherit", "pipe", "inherit"] : "inherit",
      env: sanitizeGeetorusChildEnv(process.env),
      shell: false,
    });

    let stdout = "";
    if (captureStdout && child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `Could not find '${command}'. Install the Geetorus CLI or set GEETORUSAI_CMD to the executable path or command.`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Geetorus command failed with exit code ${code}.`));
    });
  });
}

export async function listGeetorusCompanies(
  options: CommonGeetorusOptions,
): Promise<GeetorusCompanyRecord[]> {
  const output = await runGeetorus(["company", "list", "--json"], {
    ...options,
    json: false,
    captureStdout: true,
  });
  const parsed = JSON.parse(output) as GeetorusCompanyRecord[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function resolveCompanySelector(
  selector: string,
  options: CommonGeetorusOptions,
): Promise<string> {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("A company selector is required.");
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }

  const companies = await listGeetorusCompanies(options);
  const lower = trimmed.toLowerCase();
  const match = companies.find((company) =>
    company.id === trimmed
    || company.name.toLowerCase() === lower
    || company.issuePrefix?.toLowerCase() === lower,
  );

  if (!match) {
    throw new Error(`Could not resolve company selector '${selector}'. Use a company id, name, or issue prefix.`);
  }

  return match.id;
}

export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(pc.yellow(`warning: ${warning}`));
  }
}

export function normalizeApiBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Geetorus API base URL must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Geetorus API base URL '${input}'.`);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Unsupported Geetorus API base URL '${input}'. Use http:// or https://.`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function compareGeetorusVersions(left: string, right: string): number {
  const leftParsed = parseGeetorusVersion(left);
  const rightParsed = parseGeetorusVersion(right);

  if (leftParsed && rightParsed) {
    return compareParsedVersion(leftParsed, rightParsed);
  }

  if (left === right) return 0;
  return left.localeCompare(right);
}

export function isGeetorusVersionSupported(version: string): boolean {
  return compareGeetorusVersions(version, MINIMUM_GEETORUS_VERSION) >= 0;
}

export async function getGeetorusVersion(): Promise<string> {
  const output = await runGeetorus(["--version"], { captureStdout: true });
  return output.trim();
}

export function resolveLocalGeetorusConnection(
  options: Pick<CommonGeetorusOptions, "config" | "dataDir">,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): GeetorusConnectionResolution {
  const configPath = resolveLocalGeetorusConfigPath(options, cwd, env);
  const configExists = fs.existsSync(configPath);
  return {
    apiBase: configExists ? readApiBaseFromConfig(configPath) : resolveDefaultLocalApiBase(env),
    configExists,
    configPath,
  };
}

export async function isGeetorusApiReachable(apiBase: string, timeoutMs = 1_500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizeApiBase(apiBase)}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureGeetorusVersion(): Promise<string> {
  const version = await getGeetorusVersion();
  if (!isGeetorusVersionSupported(version)) {
    throw new Error(
      `companies.sh requires geetorusai ${MINIMUM_GEETORUS_VERSION} or newer. Found ${version}. ` +
      "Install a newer stable geetorusai release or point GEETORUSAI_CMD at a newer build.",
    );
  }
  return version;
}

export async function ensureLocalGeetorusReady(
  options: Pick<CommonGeetorusOptions, "config" | "dataDir">,
): Promise<GeetorusBootstrapResult> {
  const version = await ensureGeetorusVersion();

  let connection = resolveLocalGeetorusConnection(options);
  if (await isGeetorusApiReachable(connection.apiBase)) {
    return {
      apiBase: connection.apiBase,
      startedServer: false,
      version,
    };
  }

  if (!connection.configExists) {
    launchGeetorusInBackground(["onboard", "--yes"], pickSetupOptions(options));
    await waitForGeetorusApi(connection.apiBase);
    return {
      apiBase: connection.apiBase,
      startedServer: true,
      version,
    };
  }

  launchGeetorusInBackground(["run"], pickSetupOptions(options));
  await waitForGeetorusApi(connection.apiBase);

  return {
    apiBase: connection.apiBase,
    startedServer: true,
    version,
  };
}

export async function assertGeetorusApiReady(
  apiBase: string,
): Promise<GeetorusBootstrapResult> {
  const version = await ensureGeetorusVersion();
  const normalizedApiBase = normalizeApiBase(apiBase);
  if (!await isGeetorusApiReachable(normalizedApiBase, 3_000)) {
    throw new Error(
      `Could not reach Geetorus at ${normalizedApiBase}. Start Geetorus there or use auto connection mode.`,
    );
  }

  return {
    apiBase: normalizedApiBase,
    startedServer: false,
    version,
  };
}

function appendFlag(args: string[], flag: string, value: string | undefined): void {
  if (!value?.trim()) return;
  args.push(flag, value.trim());
}

function splitCommandString(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Unterminated quote in GEETORUSAI_CMD: ${input}`);
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function pickSetupOptions(
  options: Pick<CommonGeetorusOptions, "config" | "dataDir">,
): CommonGeetorusOptions {
  return {
    ...(options.config?.trim() ? { config: options.config.trim() } : {}),
    ...(options.dataDir?.trim() ? { dataDir: options.dataDir.trim() } : {}),
  };
}

function launchGeetorusInBackground(
  commandArgs: string[],
  options: Pick<CommonGeetorusOptions, "config" | "dataDir">,
): void {
  const { command, prefixArgs } = resolveGeetorusCommand();
  const child = spawnImplementation(command, [...prefixArgs, ...commandArgs, ...buildCommonGeetorusArgs(options)], {
    stdio: "ignore",
    detached: true,
    shell: false,
    env: {
      ...sanitizeGeetorusChildEnv(process.env),
      GEETORUS_OPEN_ON_LISTEN: "false",
    },
  });

  child.unref();
}

async function waitForGeetorusApi(apiBase: string, timeoutMs = resolveGeetorusReadyTimeoutMs()): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isGeetorusApiReachable(apiBase, 2_000)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Geetorus did not become ready at ${apiBase} within ${Math.round(timeoutMs / 1000)} seconds.`,
  );
}

function resolveBundledGeetorusShim(): string | null {
  try {
    require.resolve("geetorusai/package.json");
    const shimPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "geetorus-shim.js",
    );
    if (!fs.existsSync(shimPath)) {
      return null;
    }
    return shimPath;
  } catch {
    return null;
  }
}

function resolveLocalGeetorusConfigPath(
  options: Pick<CommonGeetorusOptions, "config" | "dataDir">,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  if (options.config?.trim()) {
    return path.resolve(options.config.trim());
  }

  if (env.GEETORUS_CONFIG?.trim()) {
    return path.resolve(env.GEETORUS_CONFIG.trim());
  }

  const ancestorConfig = findConfigFileFromAncestors(cwd);
  if (ancestorConfig) {
    return ancestorConfig;
  }

  const homeDir = options.dataDir?.trim()
    ? path.resolve(options.dataDir.trim())
    : env.GEETORUS_HOME?.trim()
      ? path.resolve(env.GEETORUS_HOME.trim())
      : path.resolve(os.homedir(), ".geetorus");
  const instanceId = env.GEETORUS_INSTANCE_ID?.trim() || "default";
  return path.resolve(homeDir, "instances", instanceId, "config.json");
}

function findConfigFileFromAncestors(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.resolve(currentDir, ".geetorus", "config.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) {
      return null;
    }
    currentDir = nextDir;
  }
}

function readApiBaseFromConfig(configPath: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      auth?: { publicBaseUrl?: string };
      server?: { host?: string; port?: number };
    };
    const publicBaseUrl = raw.auth?.publicBaseUrl?.trim();
    if (publicBaseUrl) {
      return normalizeApiBase(publicBaseUrl);
    }

    const port = Number(raw.server?.port);
    const safePort = Number.isFinite(port) && port > 0 ? port : 3100;
    const host = normalizeLocalHost(raw.server?.host);
    return normalizeApiBase(`http://${host}:${safePort}`);
  } catch {
    return DEFAULT_GEETORUS_API_BASE;
  }
}

function resolveDefaultLocalApiBase(env: NodeJS.ProcessEnv): string {
  const publicBaseUrl =
    env.GEETORUS_PUBLIC_URL?.trim()
    || env.GEETORUS_AUTH_PUBLIC_BASE_URL?.trim()
    || env.BETTER_AUTH_URL?.trim()
    || env.BETTER_AUTH_BASE_URL?.trim();
  if (publicBaseUrl) {
    try {
      return normalizeApiBase(publicBaseUrl);
    } catch {
      // Fall through to HOST/PORT defaults.
    }
  }

  const host = normalizeLocalHost(env.HOST);
  const port = Number(env.PORT);
  const safePort = Number.isFinite(port) && port > 0 ? port : 3100;
  return normalizeApiBase(`http://${host}:${safePort}`);
}

function normalizeLocalHost(host: string | undefined): string {
  const trimmed = host?.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::") {
    return "127.0.0.1";
  }
  if (trimmed === "localhost") {
    return "127.0.0.1";
  }
  return trimmed;
}

function resolveGeetorusReadyTimeoutMs(): number {
  const raw = process.env.COMPANIES_GEETORUS_START_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_GEETORUS_READY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GEETORUS_READY_TIMEOUT_MS;
  }
  return parsed;
}

type ParsedGeetorusVersion = {
  main: number[];
  prerelease: Array<number | string>;
};

function parseGeetorusVersion(input: string): ParsedGeetorusVersion | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  return {
    main: match[1].split(".").map((part) => Number(part)),
    prerelease: match[2]
      ? match[2].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

function compareParsedVersion(left: ParsedGeetorusVersion, right: ParsedGeetorusVersion): number {
  const maxMainLength = Math.max(left.main.length, right.main.length);
  for (let index = 0; index < maxMainLength; index += 1) {
    const leftPart = left.main[index] ?? 0;
    const rightPart = right.main[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const maxPreLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < maxPreLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart > rightPart ? 1 : -1;
    }
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

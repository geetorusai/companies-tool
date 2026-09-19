export type ProviderName = "geetorus";

export interface IncludeNormalizationResult {
  includeArg: string;
  warnings: string[];
}

export const PUBLIC_INCLUDE_VALUES = [
  "company",
  "agents",
  "projects",
  "tasks",
  "issues",
  "skills",
 ] as const;

export const INCLUDE_OPTION_HELP_TEXT = PUBLIC_INCLUDE_VALUES.join(",");

const PUBLIC_INCLUDE_TOKENS = new Set<string>(PUBLIC_INCLUDE_VALUES);

const GEETORUS_INCLUDE_ORDER = ["company", "agents", "projects", "issues", "skills"] as const;

export function normalizeIncludeValues(input: string | undefined): IncludeNormalizationResult {
  const values = (input ?? "company,agents")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const warnings: string[] = [];
  const normalized = new Set<string>();

  for (const value of values) {
    if (!PUBLIC_INCLUDE_TOKENS.has(value)) {
      throw new Error(
        `Invalid --include value '${value}'. Use a comma-separated subset of company,agents,projects,tasks,issues,skills.`,
      );
    }

    if (value === "tasks") {
      normalized.add("issues");
      continue;
    }

    normalized.add(value);
  }

  if (normalized.size === 0) {
    throw new Error("At least one supported include value is required after normalization.");
  }

  return {
    includeArg: GEETORUS_INCLUDE_ORDER.filter((value) => normalized.has(value)).join(","),
    warnings,
  };
}

export function normalizeTaskSelectors(input: string | undefined): string[] {
  if (!input?.trim()) return [];
  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export function resolveProvider(input: string | undefined): ProviderName {
  const provider = (input ?? "geetorus").trim().toLowerCase();
  if (provider !== "geetorus") {
    throw new Error(`Unsupported provider '${input}'. The current release supports only geetorus.`);
  }
  return "geetorus";
}

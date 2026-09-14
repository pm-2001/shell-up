import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { CONFIG_DIR, CONFIG_FILE, tilde } from "./paths.js";
import { THEMES, type ThemeName } from "../themes/index.js";

export interface Config {
  version: number;
  theme: ThemeName;
  /** Tool ids the user opted into. Integrations stay dormant until the binary exists. */
  tools: string[];
  aliases: boolean;
  keybindings: boolean;
  functions: boolean;
  /** Set when the user has a Nerd Font; unlocks glyph-heavy themes. */
  nerdFont: boolean;
  shell: "zsh";
  installedAt: string;
  /** The shellup version that last ran init, so the next run knows which tools are new. */
  shellupVersion?: string;
  /** Global git settings as they were before init changed them; null means unset. */
  gitConfigBackup?: Record<string, string | null>;
}

/** config.json exists but can't be used. The message is written for the user. */
export class ConfigError extends Error {}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  theme: "minimal",
  tools: [],
  aliases: true,
  keybindings: true,
  functions: true,
  nerdFont: false,
  shell: "zsh",
  installedAt: new Date().toISOString(),
};

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * null only when there is no config.json. A file that exists but is broken throws,
 * so no command mistakes a typo for "not set up yet" and writes defaults over it.
 */
export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  const where = tilde(CONFIG_FILE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    throw new ConfigError(
      `${where} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Fix the file, or move it aside and run \`shellup init\`. shellup won't write over it.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${where} should hold a JSON object.`);
  }

  // Missing fields fall back to defaults, so a config from an older shellup still loads.
  const config = { ...DEFAULT_CONFIG, ...(parsed as Partial<Config>) };
  const invalid = (field: string, expected: string, got: unknown) =>
    new ConfigError(`${where}: "${field}" ${expected}, but it's ${JSON.stringify(got)}.`);

  if (!THEMES.some((t) => t.name === config.theme)) {
    throw invalid("theme", `must be one of ${THEMES.map((t) => t.name).join(", ")}`, config.theme);
  }
  if (!Array.isArray(config.tools) || config.tools.some((t) => typeof t !== "string")) {
    throw invalid("tools", "must be a list of tool names", config.tools);
  }
  for (const key of ["aliases", "functions", "keybindings", "nerdFont"] as const) {
    if (typeof config[key] !== "boolean") throw invalid(key, "must be true or false", config[key]);
  }
  return config;
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { CONFIG_DIR, CONFIG_FILE } from "./paths.js";
import type { ThemeName } from "../themes/index.js";

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
}

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

export function loadConfig(): Config | null {
  if (!configExists()) return null;
  try {
    // Merge over defaults so a config written by an older version stays loadable.
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) } as Config;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

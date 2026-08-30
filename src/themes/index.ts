import pc from "picocolors";

export type ThemeName = "minimal" | "neon" | "powerline";

export interface ThemeMeta {
  name: ThemeName;
  label: string;
  hint: string;
  requiresNerdFont: boolean;
  /** Rendered in the wizard so the choice isn't blind. */
  preview: string[];
}

export const THEMES: ThemeMeta[] = [
  {
    name: "minimal",
    label: "minimal",
    hint: "clean two-line prompt, no special font needed",
    requiresNerdFont: false,
    preview: [
      `${pc.blue("~/dev/shellup")} ${pc.dim("on")} ${pc.magenta("main")} ${pc.green("+2")} ${pc.yellow("!1")}`,
      `${pc.green(">")} npm test${" ".repeat(18)}${pc.dim("4s")}`,
    ],
  },
  {
    name: "neon",
    label: "neon",
    hint: "bright boxed prompt, still font-safe",
    requiresNerdFont: false,
    preview: [
      `${pc.dim("╭─")} ${pc.cyan("~/dev/shellup")} ${pc.dim("·")} ${pc.magenta("⌥ main")} ${pc.yellow("✚1")} ${pc.cyan("⇡2")}`,
      `${pc.dim("╰─")}${pc.magenta("❯")} npm test${" ".repeat(15)}${pc.dim("4s")}`,
    ],
  },
  {
    name: "powerline",
    label: "powerline",
    hint: "segmented arrows and icons — requires a Nerd Font",
    requiresNerdFont: true,
    preview: [
      `${pc.bgBlue(pc.black(" ~/dev/shellup "))}${pc.bgGreen(pc.black("   main +2 "))}`,
      `${pc.green("❯")} npm test${" ".repeat(18)}${pc.dim("4s")}`,
    ],
  },
];

export const themeByName = (name: string): ThemeMeta | undefined => THEMES.find((t) => t.name === name);

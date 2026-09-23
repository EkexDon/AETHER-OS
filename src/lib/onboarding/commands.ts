/**
 * Command palette contributions of the onboarding feature. Registered via
 * `...onboardingCommands` in `src/lib/commands/registry.ts`, which must stay
 * the module that loads this one (the `getCommands` import below is a
 * circular reference that is only read when a command runs).
 */
import { CircleArrowUp, ClipboardCopy, HardDrive, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { getCommands, type CommandContribution } from "../commands/registry";
import { useOnboardingStore } from "../onboardingStore";
import { buildCheatSheet, collectShortcuts } from "./cheatsheet";
import { copyText } from "./clipboard";
import { APP_VERSION } from "./appVersion";

/** Palette group for help and setup commands. */
export const HELP_GROUP = "Help";

export const onboardingCommands: CommandContribution[] = [
  {
    id: "onboarding.runSetup",
    title: "Help: run setup again",
    group: HELP_GROUP,
    icon: WandSparkles,
    keywords: ["onboarding", "wizard", "first run", "welcome", "tour", "setup"],
    run: (ctx) => {
      ctx.closeLauncher();
      useOnboardingStore.getState().openWizard({ restart: true });
    },
  },
  {
    id: "onboarding.whatsNew",
    title: "Help: what's new",
    group: HELP_GROUP,
    icon: Sparkles,
    keywords: ["changelog", "release notes", "update", "version"],
    run: (ctx) => {
      ctx.closeLauncher();
      useOnboardingStore.getState().openWhatsNew();
    },
  },
  {
    id: "onboarding.ollamaGuide",
    title: "Help: fix the local AI setup (Ollama)",
    group: HELP_GROUP,
    icon: HardDrive,
    keywords: ["ollama", "offline", "model", "pull", "install", "download", "local ai"],
    run: (ctx) => {
      ctx.closeLauncher();
      useOnboardingStore.getState().openOllamaGuide();
    },
  },
  {
    id: "onboarding.checkUpdates",
    title: "Check for updates",
    group: HELP_GROUP,
    icon: CircleArrowUp,
    keywords: ["update", "release", "version", "upgrade", "github"],
    run: (ctx) => {
      ctx.openSettings("updates");
      // The Updates section shows the result (or the error) inline.
      void useOnboardingStore
        .getState()
        .checkUpdates()
        .catch(() => undefined);
    },
  },
  {
    id: "onboarding.copyCheatSheet",
    title: "Copy keyboard cheat sheet (Markdown)",
    group: HELP_GROUP,
    icon: ClipboardCopy,
    keywords: ["shortcuts", "keys", "hotkeys", "print", "markdown", "table"],
    run: async (ctx) => {
      await copyText(buildCheatSheet(collectShortcuts(getCommands()), { version: APP_VERSION }));
      ctx.toast.success("Cheat sheet copied", { description: "A Markdown table of every shortcut — paste it into any note." });
    },
  },
  {
    id: "onboarding.privacy",
    title: "Data & privacy settings",
    group: HELP_GROUP,
    icon: ShieldCheck,
    keywords: ["privacy", "data", "crash reports", "logs", "reset", "telemetry", "what leaves"],
    run: (ctx) => ctx.openSettings("privacy"),
  },
];

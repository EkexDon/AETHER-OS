/** Command palette contributions of the `intel` feature. */
import { Activity, FoldVertical, Sparkles } from "lucide-react";
import type { CommandContribution } from "../commands/registry";
import { useIntelStore } from "../intelStore";
import { useAetherStore } from "../store";
import { toast } from "../../ui/Toast";
import { canCompact, compactSession, persistSession } from "./pipeline";

/** Run a manual compaction of the agent chat and report the outcome. */
export async function compactNow(): Promise<void> {
  const { provider, modelByProvider, agentContext } = useAetherStore.getState();
  const result = await compactSession(modelByProvider[provider], provider);
  if (!result) return;
  await persistSession(agentContext).catch(() => undefined);
  if (result.source === "extractive") {
    toast.info("Conversation compacted (fallback)", {
      description: `The model was unavailable, so ${result.dropped_count} messages were summarised locally.`,
    });
  } else {
    toast.success("Conversation compacted", {
      description: `${result.dropped_count} earlier messages → summary (≈ ${Math.max(0, result.tokens_before - result.tokens_after).toLocaleString()} tokens saved).`,
    });
  }
}

export const intelCommands: CommandContribution[] = [
  {
    id: "intel.showRelated",
    title: "Notes: show related notes",
    group: "Notes",
    icon: Sparkles,
    shortcut: "mod+shift+r",
    keywords: ["related", "suggestions", "links", "tags", "similar", "backlink"],
    when: (ctx) => ctx.view === "editor",
    run: () => useIntelStore.getState().toggleRelated(),
  },
  {
    id: "intel.compact",
    title: "AI: compact conversation",
    group: "AI Agent",
    icon: FoldVertical,
    keywords: ["summary", "summarize", "context", "tokens", "memory", "compaction"],
    when: () => canCompact(),
    run: () => compactNow(),
  },
  {
    id: "intel.activity",
    title: "AI: show agent activity",
    group: "AI Agent",
    icon: Activity,
    keywords: ["audit", "log", "approvals", "history", "actions", "run command"],
    run: (ctx) => ctx.openSettings("intel"),
  },
];

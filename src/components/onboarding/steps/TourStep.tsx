import type { LucideIcon } from "lucide-react";
import { Bot, CalendarDays, CodeXml, Command, SquareTerminal, Zap } from "lucide-react";
import { runCommand, useCommands } from "../../../lib/commands/registry";
import { useOnboardingStore } from "../../../lib/onboardingStore";
import { Button, Kbd } from "../../../ui";

/** One tour card. `commandId` is run by "Try it"; its shortcut comes from the registry. */
export interface TourCard {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  commandId: string;
}

/** The six things worth knowing on day one. */
export const TOUR_CARDS: TourCard[] = [
  {
    id: "launcher",
    title: "Command palette",
    description: "Jump to any note, view or command without touching the mouse.",
    icon: Command,
    commandId: "app.commandPalette",
  },
  {
    id: "capture",
    title: "Quick capture",
    description: "Drop a thought into today's note from anywhere.",
    icon: Zap,
    commandId: "capture.quick",
  },
  {
    id: "agent",
    title: "Agent panel",
    description: "Chat with your notes; the agent can create notes and remember facts.",
    icon: Bot,
    commandId: "agent.toggle",
  },
  {
    id: "ide",
    title: "IDE",
    description: "Edit code with Git, diffs and language servers built in.",
    icon: CodeXml,
    commandId: "view.ide",
  },
  {
    id: "terminal",
    title: "Terminal",
    description: "Real shells in tabs that stay alive while you switch views.",
    icon: SquareTerminal,
    commandId: "view.terminal",
  },
  {
    id: "plan",
    title: "Calendar & tasks",
    description: "Plan days and projects right next to your notes.",
    icon: CalendarDays,
    commandId: "view.calendar",
  },
];

/** Step 5 — six cards, each with its shortcut and a "Try it" button. */
export function TourStep() {
  const commands = useCommands();
  const minimize = useOnboardingStore((s) => s.minimizeWizard);

  const tryIt = (commandId: string) => {
    minimize();
    // Let the wizard hide before the command opens its own overlay.
    window.setTimeout(() => {
      void runCommand(commandId).catch(() => undefined);
    }, 0);
  };

  return (
    <div className="ob-tour-grid">
      {TOUR_CARDS.map((card) => {
        const command = commands.find((c) => c.id === card.commandId);
        const Icon = card.icon;
        return (
          <article key={card.id} className="ob-tour-card">
            <div className="ob-tour-card-head">
              <span className="ob-tour-icon">
                <Icon size={16} />
              </span>
              {command?.shortcut && <Kbd shortcut={command.shortcut} />}
            </div>
            <h3 className="ob-tour-title">{card.title}</h3>
            <p className="ob-tour-text">{card.description}</p>
            <Button size="sm" variant="ghost" onClick={() => tryIt(card.commandId)} disabled={!command} aria-label={`Try ${card.title}`}>
              Try it
            </Button>
          </article>
        );
      })}
    </div>
  );
}

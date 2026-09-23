import { Bot, Keyboard, NotebookPen, ShieldCheck } from "lucide-react";

const POINTS = [
  { icon: NotebookPen, text: "Your notes, projects and AI in one keyboard-first workspace." },
  { icon: Bot, text: "Ask questions about your own notes — the agent answers with them as context." },
  { icon: Keyboard, text: "Code, terminal, calendar and tasks sit right next to your knowledge." },
];

/** Step 1 — what AETHER-OS is, in three lines, plus the privacy promise. */
export function WelcomeStep() {
  return (
    <div className="ob-step-stack">
      <ul className="ob-points">
        {POINTS.map(({ icon: Icon, text }) => (
          <li key={text}>
            <span className="ob-point-icon">
              <Icon size={16} />
            </span>
            {text}
          </li>
        ))}
      </ul>
      <div className="ob-privacy">
        <ShieldCheck size={16} className="ob-privacy-icon" />
        <div>
          <strong>Local-first by design.</strong> Your notes stay plain Markdown files on this disk. AI runs through
          Ollama on this machine; nothing leaves it unless you add an OpenRouter key and pick a cloud model. No account,
          no telemetry — crash reports stay local too.
        </div>
      </div>
      <p className="ob-muted">Setup takes about two minutes: vault → AI model → semantic search → a short tour.</p>
    </div>
  );
}

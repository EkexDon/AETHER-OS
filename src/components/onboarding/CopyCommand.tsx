import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton, useToast } from "../../ui";
import { copyText } from "../../lib/onboarding/clipboard";

/** A shell command in a code well with a copy button. */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await copyText(command);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      toast.error("Could not copy", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="ob-command">
      {label && <span className="ob-command-label">{label}</span>}
      <code className="ob-command-code">
        <span className="ob-command-prompt" aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <IconButton
        size="sm"
        label={copied ? "Copied" : `Copy “${command}”`}
        icon={copied ? <Check size={14} /> : <Copy size={14} />}
        onClick={() => void copy()}
      />
    </div>
  );
}

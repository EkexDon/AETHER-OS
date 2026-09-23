import { useEffect, useRef, useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { QuitRequest } from "../types";
import { confirmQuit, isMockRuntime, onQuitRequested, type UnlistenFn } from "../lib/ipc";
import { useOnboardingStore } from "../lib/onboardingStore";
import { Button, Checkbox, Kbd, Modal, toast } from "../ui";

/** Title of the confirmation for `terminals` running sessions. */
export function quitTitle(terminals: number): string {
  const n = Math.max(1, Math.round(terminals));
  return n === 1
    ? "1 terminal session is running — quit anyway?"
    : `${n} terminal sessions are running — quit anyway?`;
}

/**
 * Confirms quitting while terminal sessions are running. The backend emits
 * `quit-requested` instead of exiting (when "Confirm on quit with running
 * terminals" is on); Quit calls `cmd_quit_confirmed`, Cancel keeps the app
 * open. Mounted once by {@link FeatureHosts}.
 */
export function QuitConfirmHost() {
  const [request, setRequest] = useState<QuitRequest | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | null = null;
    void onQuitRequested((next) => {
      setDontAsk(false);
      setRequest(next);
    }).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const cancel = () => {
    if (!quitting) setRequest(null);
  };

  const quit = async () => {
    setQuitting(true);
    try {
      if (dontAsk) {
        // Best effort: a failed save must not keep the app from quitting.
        await useOnboardingStore
          .getState()
          .updateGeneralPrefs({ confirm_quit_with_terminals: false })
          .catch(() => undefined);
      }
      await confirmQuit();
      setRequest(null);
      if (isMockRuntime()) {
        toast.info("Quit confirmed", { description: "The desktop app closes here; the browser preview keeps running." });
      }
    } catch (e) {
      toast.error("Could not quit", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setQuitting(false);
    }
  };

  return (
    <Modal
      open={request !== null}
      onClose={cancel}
      title={request ? quitTitle(request.terminals) : undefined}
      description="Quitting AETHER-OS ends them — commands still running inside stop immediately."
      icon={SquareTerminal}
      size="sm"
      initialFocusRef={cancelRef}
      dismissible={!quitting}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={cancel} disabled={quitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void quit()} loading={quitting}>
            Quit
          </Button>
        </>
      }
    >
      <p className="quit-confirm-hint">
        Press <Kbd shortcut="mod+q" /> again within a few seconds to quit without this dialog.
      </p>
      <Checkbox
        checked={dontAsk}
        onChange={setDontAsk}
        label="Don't ask again"
        description="Change it later in Settings → General."
      />
    </Modal>
  );
}

import { useMemo, useState, type KeyboardEvent, type Ref } from "react";
import { Eye, EyeOff, FolderOpen } from "lucide-react";
import { Button, IconButton, Input, cx } from "../../ui";
import { estimatePassphrase } from "../../lib/sync/entropy";
import { pickFolder, type FolderPurpose } from "../../lib/sync/pickFolder";

/** Password field with a show/hide toggle. Never autocompleted or spell-checked. */
export function PassphraseInput({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
  invalid,
  onEnter,
  autoComplete = "current-password",
  "aria-describedby": describedBy,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  onEnter?: () => void;
  autoComplete?: "current-password" | "new-password";
  "aria-describedby"?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      ref={inputRef}
      id={id}
      type={shown ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      invalid={invalid}
      aria-describedby={describedBy}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
      suffix={
        <IconButton
          size="sm"
          label={shown ? "Hide passphrase" : "Show passphrase"}
          tooltip={false}
          icon={shown ? <EyeOff size={14} /> : <Eye size={14} />}
          onClick={() => setShown((v) => !v)}
        />
      }
    />
  );
}

/** Four-segment strength meter for a new passphrase. */
export function StrengthMeter({ passphrase, id }: { passphrase: string; id?: string }) {
  const estimate = useMemo(() => estimatePassphrase(passphrase), [passphrase]);
  const filled = passphrase ? Math.max(1, estimate.score) : 0;
  return (
    <div className="sync-strength" data-score={estimate.score} id={id}>
      <div
        className="sync-strength-bar"
        role="meter"
        aria-label="Passphrase strength"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={estimate.score}
        aria-valuetext={passphrase ? `${estimate.label}, about ${estimate.bits} bits` : "No passphrase"}
      >
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx("sync-strength-segment", i < filled && "is-filled")} />
        ))}
      </div>
      <div className="sync-strength-text">
        <span className="sync-strength-label">{passphrase ? estimate.label : "Strength"}</span>
        {passphrase && <span className="sync-strength-bits tabular">~{estimate.bits} bits</span>}
      </div>
      {passphrase && estimate.hints[0] && <p className="ui-field-hint sync-strength-hint">{estimate.hints[0]}</p>}
    </div>
  );
}

/** Path field with a "Browse…" button that opens the native folder dialog. */
export function FolderField({
  id,
  value,
  onChange,
  purpose,
  dialogTitle,
  placeholder,
  disabled,
  onPicked,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  purpose: FolderPurpose;
  dialogTitle: string;
  placeholder?: string;
  disabled?: boolean;
  /** Called after a folder was chosen in the dialog. */
  onPicked?: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    setBusy(true);
    try {
      const picked = await pickFolder(purpose, dialogTitle, value || null);
      if (picked) {
        onChange(picked);
        onPicked?.(picked);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ui-field-row sync-folder-field">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        iconLeft={<FolderOpen size={14} />}
        inputClassName="mono"
        spellCheck={false}
        disabled={disabled}
      />
      <Button variant="secondary" onClick={() => void browse()} loading={busy} disabled={disabled}>
        Browse…
      </Button>
    </div>
  );
}

/** Horizontal progress bar (indeterminate when `percent` is null). */
export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      className={cx("sync-progress", percent === null && "is-indeterminate")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      <span className="sync-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

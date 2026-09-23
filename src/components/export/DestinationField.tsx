import { useId } from "react";
import { FolderOpen } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Button, Input, Switch } from "../../ui";
import { isTauriRuntime } from "../../lib/ipc";
import { isInsideVault, parentDir } from "../../lib/export/scope";
import type { ExportFlow } from "../../types";

export interface DestinationFieldProps {
  flow: ExportFlow;
  value: string;
  onChange: (value: string) => void;
  vaultRoot: string | null;
  allowInsideVault: boolean;
  onAllowInsideVault: (allow: boolean) => void;
  onError: (message: string) => void;
}

const HINTS: Record<ExportFlow, string> = {
  html: "An .html file. Images are inlined, so it can be mailed or opened anywhere.",
  site: "A folder that is empty or holds a previous AETHER-OS site — re-exporting replaces it.",
  bundle: "A .zip file.",
};

/** Output file/folder with a native picker and the inside-the-vault guard. */
export function DestinationField({
  flow,
  value,
  onChange,
  vaultRoot,
  allowInsideVault,
  onAllowInsideVault,
  onError,
}: DestinationFieldProps) {
  const id = useId();
  const native = isTauriRuntime();
  const inside = isInsideVault(value, vaultRoot);
  const invalid = value.trim() !== "" && !value.trim().startsWith("/");

  const choose = async () => {
    try {
      if (flow === "site") {
        const dir = await open({
          directory: true,
          multiple: false,
          defaultPath: value ? parentDir(value) : undefined,
          title: "Choose the folder for the website",
        });
        if (typeof dir === "string") onChange(dir);
        return;
      }
      const ext = flow === "html" ? "html" : "zip";
      const path = await save({
        defaultPath: value || undefined,
        filters: [{ name: flow === "html" ? "HTML page" : "Zip archive", extensions: [ext] }],
        title: flow === "html" ? "Save the note as HTML" : "Save the Markdown bundle",
      });
      if (path) onChange(path);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="export-destination">
      <div className="ui-field">
        <label className="ui-field-label" htmlFor={`${id}-dest`}>
          {flow === "site" ? "Folder" : "File"}
        </label>
        <div className="export-destination-row">
          <Input
            id={`${id}-dest`}
            size="sm"
            value={value}
            invalid={invalid || (inside && !allowInsideVault)}
            onChange={(e) => onChange(e.target.value)}
            inputClassName="mono"
            placeholder={flow === "site" ? "/Users/you/Sites/my-garden" : "/Users/you/Desktop/note.html"}
            aria-describedby={`${id}-hint`}
          />
          {native && (
            <Button size="sm" variant="secondary" iconLeft={<FolderOpen size={13} />} onClick={() => void choose()}>
              Choose…
            </Button>
          )}
        </div>
        <span className="ui-field-hint" id={`${id}-hint`}>
          {invalid ? "Enter an absolute path (starting with /)." : HINTS[flow]}
          {!native && !invalid && " In the browser preview nothing is written to disk."}
        </span>
      </div>
      {inside && (
        <div className="ui-notice ui-notice-warning export-inside-vault" role="status">
          <div>
            This destination is inside your vault — exported files would be indexed as notes.
            <Switch
              size="sm"
              checked={allowInsideVault}
              onChange={onAllowInsideVault}
              label="Export into the vault anyway"
              className="export-inside-switch"
            />
          </div>
        </div>
      )}
    </div>
  );
}

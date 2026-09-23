import { useEffect, useRef, useState } from "react";
import { FileArchive, FolderOpen, PackagePlus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { isMockRuntime, isTauriRuntime } from "../../lib/ipc";
import { usePluginsStore } from "../../lib/pluginsStore";
import { Button, Input, Modal, useToast } from "../../ui";

/** Demo packages the browser preview's mock backend can install. */
const MOCK_DEMO_PATHS = [
  "/Users/demo/Downloads/github-zen",
  "/Users/demo/Downloads/github-zen.zip",
  "/Users/demo/Downloads/zip-slip.zip",
];

/** "Install plugin" dialog: a folder or `.zip` path, picked or typed. */
export function InstallPluginModal() {
  const openState = usePluginsStore((s) => s.installOpen);
  const setInstallOpen = usePluginsStore((s) => s.setInstallOpen);
  const install = usePluginsStore((s) => s.install);
  const openReview = usePluginsStore((s) => s.openReview);
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const canBrowse = isTauriRuntime();

  useEffect(() => {
    if (openState) {
      setError(null);
      setInstalling(false);
    }
  }, [openState]);

  if (!openState) return null;
  const close = () => setInstallOpen(false);

  const browse = async (kind: "folder" | "zip") => {
    try {
      const picked =
        kind === "folder"
          ? await open({ directory: true, multiple: false, title: "Choose a plugin folder" })
          : await open({ multiple: false, title: "Choose a plugin archive", filters: [{ name: "Plugin archive", extensions: ["zip"] }] });
      if (typeof picked === "string") {
        setPath(picked);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    const target = path.trim();
    if (!target) return;
    setInstalling(true);
    setError(null);
    try {
      const info = await install(target);
      close();
      setPath("");
      toast.success(`Installed ${info.manifest.name} ${info.manifest.version}`, {
        description: info.enabled ? "The update is live." : "Review its permissions to enable it.",
        action: info.enabled
          ? undefined
          : { label: "Review & enable", onClick: () => openReview(info.manifest.id, "enable") },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      icon={PackagePlus}
      size="md"
      title="Install plugin"
      description="Pick a plugin folder or a .zip archive containing manifest.json and its main module. Installing the same id again updates it."
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={installing} disabled={!path.trim()} onClick={() => void submit()}>
            Install
          </Button>
        </>
      }
    >
      <form
        className="plugin-install"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="plugin-install-path">
            Folder or archive
          </label>
          <Input
            id="plugin-install-path"
            ref={inputRef}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/Downloads/my-plugin.zip"
            spellCheck={false}
            invalid={!!error}
            inputClassName="mono"
          />
          {canBrowse && (
            <div className="plugin-install-browse">
              <Button size="sm" iconLeft={<FolderOpen size={14} />} onClick={() => void browse("folder")}>
                Choose folder…
              </Button>
              <Button size="sm" iconLeft={<FileArchive size={14} />} onClick={() => void browse("zip")}>
                Choose .zip…
              </Button>
            </div>
          )}
        </div>
        {isMockRuntime() && (
          <div className="plugin-install-demo">
            <span className="ui-section-label">Demo packages</span>
            <div className="plugin-install-demo-list">
              {MOCK_DEMO_PATHS.map((demo) => (
                <button key={demo} type="button" className="plugin-install-demo-path mono" onClick={() => setPath(demo)}>
                  {demo}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div className="ui-notice ui-notice-danger" role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}

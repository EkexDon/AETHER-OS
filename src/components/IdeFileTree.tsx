import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Loader2 } from "lucide-react";
import { ideListDir } from "../lib/ipc";
import type { FsEntry } from "../types";

interface IdeFileTreeProps {
  rootPath: string;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}

/**
 * Directory tree that loads one level at a time.
 *
 * Real projects are far too large to walk eagerly, so children are fetched on
 * first expand and then cached for the lifetime of the open folder.
 */
export function IdeFileTree({ rootPath, activePath, onOpenFile }: IdeFileTreeProps) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading((prev) => new Set(prev).add(path));
    try {
      const entries = await ideListDir(path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  // Reset and load the root whenever a different folder is opened.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set([rootPath]));
    setError(null);
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      if (!children[path]) void loadDir(path);
    },
    [children, loadDir]
  );

  const renderLevel = (path: string, depth: number) => {
    const entries = children[path];
    if (!entries) return null;
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const isLoading = loading.has(entry.path);
      return (
        <div key={entry.path}>
          <div
            className={`ide-tree-row${
              activePath === entry.path ? " ide-tree-row-active" : ""
            }`}
            style={{ paddingLeft: depth * 12 + 8 }}
            onClick={() =>
              entry.is_dir ? toggleDir(entry.path) : onOpenFile(entry.path)
            }
            title={entry.path}
          >
            {entry.is_dir ? (
              <>
                <span className="ide-tree-chevron">
                  {isLoading ? (
                    <Loader2 size={12} className="spin" />
                  ) : isOpen ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </span>
                {isOpen ? (
                  <FolderOpen size={13} className="ide-tree-icon ide-tree-icon-dir" />
                ) : (
                  <Folder size={13} className="ide-tree-icon ide-tree-icon-dir" />
                )}
              </>
            ) : (
              <>
                <span className="ide-tree-chevron" />
                <File size={13} className="ide-tree-icon" />
              </>
            )}
            <span className="ide-tree-name">{entry.name}</span>
          </div>
          {entry.is_dir && isOpen && renderLevel(entry.path, depth + 1)}
        </div>
      );
    });
  };

  const rootName = rootPath.split("/").filter(Boolean).pop() ?? rootPath;

  return (
    <div className="ide-tree">
      <div className="ide-tree-header" title={rootPath}>
        {rootName}
      </div>
      {error && <div className="ide-tree-error">{error}</div>}
      {loading.has(rootPath) && !children[rootPath] && (
        <div className="ide-tree-loading">
          <Loader2 size={13} className="spin" /> Loading…
        </div>
      )}
      {renderLevel(rootPath, 0)}
    </div>
  );
}

import { Suspense, useMemo, useState } from "react";
import { getSettingsSections, resolveSettingsSection } from "../settings/registry";
import { Modal, SearchField, Spinner, cx } from "../ui";
import { scoreFields } from "../lib/commands/fuzzy";
import { APP_VERSION } from "../settings/sections/AboutSettings";

/**
 * Settings modal: section list on the left, the selected section on the
 * right. Sections come from `src/settings/registry.tsx`.
 */
export function SettingsPanel({
  onClose,
  initialSection,
  onSectionChange,
}: {
  onClose: () => void;
  initialSection?: string | null;
  onSectionChange?: (id: string) => void;
}) {
  const sections = useMemo(() => getSettingsSections(), []);
  const [activeId, setActiveId] = useState(() => resolveSettingsSection(initialSection, sections)?.id ?? "");
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim();
    if (!q) return sections;
    return sections.filter((s) => scoreFields(q, s.title, s.keywords ?? []) > 0);
  }, [filter, sections]);

  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  const Content = active?.component;

  const select = (id: string) => {
    setActiveId(id);
    onSectionChange?.(id);
  };

  return (
    <Modal open onClose={onClose} size="xl" flush aria-label="Settings" className="settings-modal" hideCloseButton={false}>
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          <SearchField value={filter} onChange={setFilter} placeholder="Find a setting" size="sm" className="settings-nav-search" />
          <nav className="settings-nav-list">
            {visible.map((s) => {
              const Icon = s.icon;
              const selected = s.id === active?.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={cx("settings-nav-item", selected && "is-selected")}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => select(s.id)}
                >
                  <Icon size={15} />
                  <span>{s.title}</span>
                </button>
              );
            })}
            {visible.length === 0 && <p className="settings-nav-empty">No matching section</p>}
          </nav>
          <div className="settings-nav-footer">AETHER-OS v{APP_VERSION}</div>
        </aside>
        <div className="settings-content" key={active?.id}>
          {Content && (
            <Suspense
              fallback={
                <div className="view-loading">
                  <Spinner size={16} />
                </div>
              }
            >
              <Content />
            </Suspense>
          )}
        </div>
      </div>
    </Modal>
  );
}

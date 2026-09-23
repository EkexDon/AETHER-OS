import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, Plus, Tags, X } from "lucide-react";
import {
  editFrontmatter,
  frontmatterYaml,
  isValidPropertyKey,
  listProperties,
  normalizeTags,
  removeProperty,
  setProperty,
  type FrontmatterProperty,
  type PropertyValue,
} from "../lib/editor/frontmatter";
import { Button, IconButton, Input, Tooltip, cx, toast } from "../ui";

/** localStorage key of the collapsed state of the Properties panel. */
export const PROPERTIES_COLLAPSED_KEY = "aether-note-properties-collapsed";

/** Keys shown as tag chips. */
const TAG_KEYS = new Set(["tags", "tag"]);

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(PROPERTIES_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(PROPERTIES_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // storage unavailable — the state still applies for this session
  }
}

/** Display text of a value in a single-line field. */
function valueText(value: PropertyValue): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Parse a field back: comma lists stay lists when the property is one. */
function parseField(text: string, wasList: boolean): PropertyValue {
  if (!wasList) return text.trim();
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface NotePropertiesProps {
  /** The note's raw front matter block (`null` = none). */
  frontmatter: string | null;
  /** Called with the new block (`null` when the last property was removed). */
  onChange: (frontmatter: string | null) => void;
  /** Incremented to open the "Add property" row (toolbar button). */
  addRequest?: number;
}

/**
 * Compact Properties panel above the note canvas: one row per front matter
 * key, tag chips for `tags`, values editable in place (Enter commits,
 * Escape reverts) and "Add property". Edits rewrite only the affected YAML
 * lines (see `lib/editor/frontmatter.ts`); YAML the panel does not
 * understand is shown read-only and kept byte for byte.
 */
export function NoteProperties({ frontmatter, onChange, addRequest = 0 }: NotePropertiesProps) {
  const yaml = useMemo(() => frontmatterYaml(frontmatter), [frontmatter]);
  const properties = useMemo(() => {
    const seen = new Set<string>();
    return listProperties(yaml).filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
  }, [yaml]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [adding, setAdding] = useState(false);
  const lastAddRequest = useRef(addRequest);

  useEffect(() => {
    if (addRequest === lastAddRequest.current) return;
    lastAddRequest.current = addRequest;
    setCollapsed(false);
    setAdding(true);
  }, [addRequest]);

  const apply = (edit: (yaml: string) => string): boolean => {
    try {
      onChange(editFrontmatter(frontmatter, edit));
      return true;
    } catch (e) {
      toast.error("Could not change the property", { description: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  if (!frontmatter && !adding) return null;

  const toggle = () => {
    const next = !collapsed;
    writeCollapsed(next);
    setCollapsed(next);
  };

  return (
    <section className={cx("note-properties", collapsed && "is-collapsed")} aria-label="Properties">
      <button type="button" className="note-properties-toggle" aria-expanded={!collapsed} onClick={toggle}>
        <ChevronRight size={14} className={cx("note-properties-chevron", !collapsed && "is-open")} aria-hidden="true" />
        <span className="ui-section-label">Properties</span>
        <span className="note-properties-count tabular">{properties.length}</span>
      </button>
      {!collapsed && (
        <div className="note-properties-body">
          {properties.map((p) => (
            <PropertyRow
              key={p.key}
              property={p}
              onSet={(value) => apply((y) => setProperty(y, p.key, value))}
              onRemove={() => apply((y) => removeProperty(y, p.key))}
            />
          ))}
          {adding ? (
            <AddPropertyRow
              existing={properties.map((p) => p.key)}
              onAdd={(key, value) => {
                if (apply((y) => setProperty(y, key, value))) setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="note-properties-add"
              iconLeft={<Plus size={14} />}
              onClick={() => setAdding(true)}
            >
              Add property
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function PropertyRow({
  property,
  onSet,
  onRemove,
}: {
  property: FrontmatterProperty;
  onSet: (value: PropertyValue) => boolean;
  onRemove: () => void;
}) {
  const id = useId();
  const isTags = TAG_KEYS.has(property.key.toLowerCase()) && property.editable;

  return (
    <div className="note-prop-row">
      <label className="note-prop-key" htmlFor={id} title={property.key}>
        {isTags && <Tags size={14} aria-hidden="true" />}
        <span>{property.key}</span>
      </label>
      <div className="note-prop-value">
        {!property.editable ? (
          <Tooltip content="This YAML is kept as written — edit it in the file" placement="top">
            <span id={id} className="note-prop-raw mono" tabIndex={0}>
              {valueText(property.value)}
            </span>
          </Tooltip>
        ) : isTags ? (
          <TagEditor id={id} name={property.key} tags={normalizeTags(property.value)} onSet={onSet} />
        ) : (
          <ValueField id={id} property={property} onSet={onSet} />
        )}
      </div>
      <IconButton
        size="sm"
        className="note-prop-remove"
        label={`Remove property ${property.key}`}
        icon={<X size={14} />}
        onClick={onRemove}
        disabled={!property.editable}
      />
    </div>
  );
}

function ValueField({
  id,
  property,
  onSet,
}: {
  id: string;
  property: FrontmatterProperty;
  onSet: (value: PropertyValue) => boolean;
}) {
  const committed = valueText(property.value);
  const [draft, setDraft] = useState(committed);
  const isList = Array.isArray(property.value);

  useEffect(() => setDraft(committed), [committed]);

  const commit = () => {
    if (draft === committed) return;
    if (!onSet(parseField(draft, isList))) setDraft(committed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDraft(committed);
      e.currentTarget.blur();
    }
  };

  return (
    <Input
      id={id}
      size="sm"
      className="note-prop-input"
      value={draft}
      placeholder={isList ? "a, b, c" : "Empty"}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}

function TagEditor({
  id,
  name,
  tags,
  onSet,
}: {
  id: string;
  name: string;
  tags: string[];
  onSet: (value: PropertyValue) => boolean;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const next = normalizeTags([...tags, ...draft.split(/[,\s]+/)]);
    if (next.length === tags.length) {
      setDraft("");
      return;
    }
    if (onSet(next)) setDraft("");
  };

  return (
    <div className="note-prop-tags">
      {tags.map((tag) => (
        <span key={tag} className="note-prop-tag">
          <span className="note-prop-tag-label">#{tag}</span>
          <button
            type="button"
            className="note-prop-tag-remove"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onSet(tags.filter((t) => t !== tag))}
          >
            <X size={14} />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="note-prop-tag-input"
        value={draft}
        aria-label={`Add to ${name}`}
        placeholder={tags.length ? "Add tag" : "Add a tag…"}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && tags.length > 0) {
            e.preventDefault();
            onSet(tags.slice(0, -1));
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft("");
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function AddPropertyRow({
  existing,
  onAdd,
  onCancel,
}: {
  existing: string[];
  onAdd: (key: string, value: PropertyValue) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => keyRef.current?.focus(), []);

  const submit = () => {
    const k = key.trim();
    if (!isValidPropertyKey(k)) {
      setError("Use a name without “:” that does not start with -, # or ?.");
      keyRef.current?.focus();
      return;
    }
    if (existing.includes(k)) {
      setError(`“${k}” already exists — edit it above.`);
      keyRef.current?.focus();
      return;
    }
    const v = TAG_KEYS.has(k.toLowerCase()) ? normalizeTags(value) : value.trim();
    onAdd(k, v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="note-prop-row is-new">
      <Input
        ref={keyRef}
        size="sm"
        className="note-prop-key-input"
        aria-label="Property name"
        placeholder="Name"
        value={key}
        invalid={!!error}
        spellCheck={false}
        onChange={(e) => {
          setKey(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="note-prop-value">
        <Input
          size="sm"
          className="note-prop-input"
          aria-label="Property value"
          placeholder={TAG_KEYS.has(key.trim().toLowerCase()) ? "tag-one, tag-two" : "Value"}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {error && (
          <p className="ui-field-error note-prop-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <IconButton size="sm" className="note-prop-remove" label="Cancel new property" icon={<X size={14} />} onClick={onCancel} />
    </div>
  );
}

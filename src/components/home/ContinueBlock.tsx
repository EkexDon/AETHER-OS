import { useMemo, useState } from "react";
import { FileText, FolderGit2, GitBranch, History, MessagesSquare } from "lucide-react";
import type { Conversation, Project, VaultNote } from "../../types";
import {
  conversationTitle,
  gitStatusLabel,
  gitStatusTone,
  recentConversations,
  recentNotes,
  recentProjects,
} from "../../lib/home/recent";
import { relativeFolder, relativeTime } from "../../lib/home/format";
import { Badge, Button, EmptyState, ListRow, SegmentedControl } from "../../ui";
import { HomeBlock } from "./HomeBlock";
import { PinButton } from "./PinButton";

/** Rows per tab. */
const LIMIT = 7;

/** Which list the Continue block shows. */
export type ContinueTab = "notes" | "projects" | "chats";

export interface ContinueBlockProps {
  now: number;
  vaultPath: string | null;
  notes: VaultNote[];
  projects: Project[];
  conversations: Conversation[];
  loadingProjects?: boolean;
  loadingConversations?: boolean;
  projectsError?: string | null;
  conversationsError?: string | null;
  onOpenNote: (path: string) => void;
  onOpenProject: (project: Project) => void;
  onOpenConversation: (conversation: Conversation) => void;
  onSeeAll: (tab: ContinueTab) => void;
  onNewNote: () => void;
  onChooseVault: () => void;
}

const SEE_ALL: Record<ContinueTab, string> = { notes: "Search", projects: "Projects", chats: "Open chat" };

/** Recently edited notes, recently committed projects and recent AI chats. */
export function ContinueBlock(props: ContinueBlockProps) {
  const [tab, setTab] = useState<ContinueTab>("notes");
  const { now } = props;
  const notes = useMemo(() => recentNotes(props.notes, LIMIT), [props.notes]);
  const projects = useMemo(() => recentProjects(props.projects, LIMIT), [props.projects]);
  const chats = useMemo(() => recentConversations(props.conversations, LIMIT), [props.conversations]);

  return (
    <HomeBlock
      title="Continue"
      icon={History}
      className="home-continue"
      loading={(tab === "projects" && props.loadingProjects) || (tab === "chats" && props.loadingConversations)}
      error={tab === "projects" ? props.projectsError : tab === "chats" ? props.conversationsError : null}
      controls={
        <SegmentedControl
          size="sm"
          aria-label="Continue with"
          value={tab}
          onChange={setTab}
          options={[
            { value: "notes", label: "Notes" },
            { value: "projects", label: "Projects" },
            { value: "chats", label: "Chats" },
          ]}
        />
      }
      actionLabel={SEE_ALL[tab]}
      onAction={() => props.onSeeAll(tab)}
    >
      {tab === "notes" &&
        (notes.length === 0 ? (
          props.vaultPath ? (
            <EmptyState
              size="sm"
              icon={FileText}
              title="No notes yet"
              description="Notes you edit show up here, newest first."
              action={
                <Button size="sm" variant="secondary" onClick={props.onNewNote}>
                  New note
                </Button>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              icon={FileText}
              title="No vault connected"
              description="Connect a vault to pick up where you left off."
              action={
                <Button size="sm" variant="secondary" onClick={props.onChooseVault}>
                  Choose vault
                </Button>
              }
            />
          )
        ) : (
          <div className="home-list" role="list" aria-label="Recent notes">
            {notes.map((n) => {
              const folder = relativeFolder(n.path, props.vaultPath);
              return (
                <div role="listitem" key={n.path}>
                  <ListRow
                    icon={<FileText size={14} />}
                    title={n.name}
                    description={folder || "Vault root"}
                    meta={relativeTime(n.mtime * 1000, now)}
                    actions={<PinButton kind="note" target={n.path} label={n.name} />}
                    onClick={() => props.onOpenNote(n.path)}
                  />
                </div>
              );
            })}
          </div>
        ))}

      {tab === "projects" &&
        (projects.length === 0 ? (
          <EmptyState
            size="sm"
            icon={FolderGit2}
            title={props.loadingProjects ? "Scanning projects…" : "No projects found"}
            description="Add a folder in Projects to see your repositories here."
            action={
              <Button size="sm" variant="secondary" onClick={() => props.onSeeAll("projects")}>
                Open Projects
              </Button>
            }
          />
        ) : (
          <div className="home-list" role="list" aria-label="Recent projects">
            {projects.map((p) => (
              <div role="listitem" key={p.path}>
                <ListRow
                  icon={<FolderGit2 size={14} />}
                  title={p.name}
                  description={
                    <span className="home-project-line">
                      {p.git_branch && (
                        <span className="home-project-branch">
                          <GitBranch size={11} aria-hidden="true" />
                          {p.git_branch}
                        </span>
                      )}
                      <span>{p.last_commit_msg ?? p.language}</span>
                    </span>
                  }
                  meta={
                    <span className="home-project-meta">
                      <Badge variant={gitStatusTone(p.git_status)}>{gitStatusLabel(p.git_status)}</Badge>
                      {p.last_commit_date ? relativeTime(p.last_commit_date * 1000, now) : null}
                    </span>
                  }
                  actions={<PinButton kind="project" target={p.path} label={p.name} />}
                  onClick={() => props.onOpenProject(p)}
                />
              </div>
            ))}
          </div>
        ))}

      {tab === "chats" &&
        (chats.length === 0 ? (
          <EmptyState
            size="sm"
            icon={MessagesSquare}
            title="No conversations yet"
            description="Chats with the AI agent are saved here."
            action={
              <Button size="sm" variant="secondary" onClick={() => props.onSeeAll("chats")}>
                Open chat
              </Button>
            }
          />
        ) : (
          <div className="home-list" role="list" aria-label="Recent conversations">
            {chats.map((c) => {
              const title = conversationTitle(c);
              return (
                <div role="listitem" key={c.id}>
                  <ListRow
                    icon={<MessagesSquare size={14} />}
                    title={title}
                    description={`${c.messages.length} message${c.messages.length === 1 ? "" : "s"}${
                      c.context_notes.length ? ` · ${c.context_notes.length} note${c.context_notes.length === 1 ? "" : "s"} in context` : ""
                    }`}
                    meta={relativeTime(c.timestamp * 1000, now)}
                    actions={<PinButton kind="conversation" target={c.id} label={title} />}
                    onClick={() => props.onOpenConversation(c)}
                  />
                </div>
              );
            })}
          </div>
        ))}
    </HomeBlock>
  );
}

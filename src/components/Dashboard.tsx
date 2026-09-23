import { useEffect, useState } from "react";
import { CalendarPlus, Command as CommandIcon, FilePlus2, ListPlus, Pin, Zap } from "lucide-react";
import type { CalendarEvent, Conversation, Project, TaskItem } from "../types";
import type { ViewMode } from "../views/modes";
import { useAetherStore } from "../lib/store";
import { useShellStore } from "../shell/shellStore";
import { useIdeStore } from "../lib/ideStore";
import { useHomeStore } from "../lib/homeStore";
import { useFocusStore } from "../lib/focusStore";
import { useVaultTasksStore } from "../lib/vaultTasksStore";
import { openConversation as openAgentConversation } from "../lib/agentChatBus";
import { countPins, usePinsStore } from "../lib/pinsStore";
import { appendDaily, dailyNote } from "../lib/ipc";
import { dateKey } from "../lib/home/focusStats";
import { formatLongDate, greetingFor } from "../lib/home/format";
import { HOME_SETTINGS_ID } from "../lib/home/commands";
import type { HomeNoteTask } from "../lib/home/dueTasks";
import { vaultName } from "../shell/statusbar/items";
import { Button, Tooltip, ViewHeader, toast } from "../ui";
import { HomeBlock } from "./home/HomeBlock";
import { TodayBlock } from "./home/TodayBlock";
import { ContinueBlock, type ContinueTab } from "./home/ContinueBlock";
import { FocusBlock } from "./home/FocusBlock";
import { VaultBlock } from "./home/VaultBlock";
import { PinsPanel } from "./home/PinsPanel";
import { useNow } from "./home/hooks";
import { TaskDetailModal } from "./TaskDetailModal";
import { EventEditorModal } from "./EventEditorModal";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Which editor modal Home has open. */
type HomeModal =
  | { kind: "task"; task: TaskItem | null }
  | { kind: "event"; event: CalendarEvent | null; date: string }
  | null;

/**
 * Home — the first screen of the day: greeting and quick actions, today's
 * note, schedule and due tasks, where to continue, pins, the Pomodoro timer
 * with focus statistics, and vault health. Asymmetric 65/35 grid on wide
 * containers, one column below 1100 px.
 */
export function Dashboard() {
  const now = useNow(30_000);
  const today = dateKey(new Date(now));
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const vaultNotes = useAetherStore((s) => s.vaultNotes);
  const vaultStats = useAetherStore((s) => s.vaultStats);
  const projects = useAetherStore((s) => s.projects);
  const events = useAetherStore((s) => s.calendarEvents);
  const indexing = useAetherStore((s) => s.indexing);
  const home = useHomeStore();
  const statsVersion = useFocusStore((s) => s.statsVersion);
  const pinTotal = usePinsStore((s) => countPins(s.groups));
  const [modal, setModal] = useState<HomeModal>(null);

  useEffect(() => {
    void useHomeStore.getState().refresh();
  }, []);

  useEffect(() => {
    if (statsVersion > 0) void useHomeStore.getState().refreshFocus();
  }, [statsVersion]);

  const aether = () => useAetherStore.getState();
  const setView = (mode: ViewMode) => aether().setView(mode);

  const openNote = (path: string) => {
    aether().selectNote(path);
    setView("editor");
  };

  const openDailyNote = async () => {
    try {
      const path = await dailyNote();
      if (!aether().vaultNotes.some((n) => n.path === path)) {
        await home.refreshVault().catch(() => undefined);
      }
      openNote(path);
    } catch (e) {
      toast.error("Could not open today's note", { description: errorMessage(e) });
    }
  };

  const appendToDaily = async (text: string) => {
    try {
      await appendDaily(text);
      toast.success("Added to today's note", { description: text });
      await home.refreshVault().catch(() => undefined);
    } catch (e) {
      toast.error("Could not add to today's note", { description: errorMessage(e) });
      throw e;
    }
  };

  const newTask = () => {
    if (home.taskProjects.length === 0) {
      toast.info("Create a project first", { description: "Tasks live in projects on the task board." });
      setView("tasks");
      return;
    }
    setModal({ kind: "task", task: null });
  };

  const openNoteTask = (t: HomeNoteTask) => {
    // The editor scrolls to (and highlights) this line once the note loads.
    useVaultTasksStore.setState({ pendingLine: { notePath: t.notePath, line: t.line } });
    openNote(t.notePath);
  };

  const openProject = (p: Project) => {
    useIdeStore.getState().setRoot(p.path);
    setView("ide");
  };

  // Loads that conversation into the agent panel (intel's chat bus).
  const openConversation = (c: Conversation) => {
    openAgentConversation(c.id).catch((e: unknown) =>
      toast.error("Could not open the conversation", { description: errorMessage(e) })
    );
  };

  const seeAll = (tab: ContinueTab) => {
    if (tab === "notes") setView("search");
    else if (tab === "projects") setView("projects");
    else aether().setChatOpen(true);
  };

  const openCalendarOn = (day: string) => {
    aether().setCalendarDate(day);
    setView("calendar");
  };

  const shell = useShellStore.getState();
  const quickActions = (
    <div className="home-quick-actions" role="toolbar" aria-label="Quick actions">
      <Tooltip content="New note" shortcut="mod+n" placement="bottom">
        <Button variant="primary" size="sm" aria-label="New note" iconLeft={<FilePlus2 size={14} />} onClick={() => shell.setNewNoteOpen(true)}>
          <span className="home-qa-label">New note</span>
        </Button>
      </Tooltip>
      <Tooltip content="Quick capture to daily note" shortcut="mod+shift+n" placement="bottom">
        <Button size="sm" aria-label="Quick capture" iconLeft={<Zap size={14} />} onClick={() => aether().setShowQuickCapture(true)}>
          <span className="home-qa-label">Capture</span>
        </Button>
      </Tooltip>
      <Tooltip content="New task" placement="bottom">
        <Button size="sm" aria-label="New task" iconLeft={<ListPlus size={14} />} onClick={newTask}>
          <span className="home-qa-label">Task</span>
        </Button>
      </Tooltip>
      <Tooltip content="New event" placement="bottom">
        <Button size="sm" aria-label="New event" iconLeft={<CalendarPlus size={14} />} onClick={() => setModal({ kind: "event", event: null, date: today })}>
          <span className="home-qa-label">Event</span>
        </Button>
      </Tooltip>
      <Tooltip content="Open launcher" shortcut="mod+k" placement="bottom">
        <Button variant="ghost" size="sm" aria-label="Open launcher" iconLeft={<CommandIcon size={14} />} onClick={() => shell.toggleLauncher()}>
          <span className="home-qa-label">Launcher</span>
        </Button>
      </Tooltip>
    </div>
  );

  return (
    <div className="view home">
      <ViewHeader
        className="home-header"
        title={greetingFor(new Date(now))}
        subtitle={
          <>
            {formatLongDate(new Date(now))}
            <span className="home-header-sep" aria-hidden="true">
              ·
            </span>
            {vaultName(vaultPath)}
          </>
        }
        actions={quickActions}
      />
      <div className="view-body home-body">
        <div className="home-grid">
          <div className="home-col-main">
            <div className="home-area-today">
              <TodayBlock
                now={now}
                today={today}
                vaultPath={vaultPath}
                notes={vaultNotes}
                events={events}
                boardTasks={home.boardTasks}
                taskProjects={home.taskProjects}
                noteTasks={home.noteTasks}
                loadingEvents={home.loading.events}
                loadingTasks={home.loading.tasks}
                eventsError={home.errors.events}
                tasksError={home.errors.tasks}
                onOpenDailyNote={openDailyNote}
                onAppendDaily={appendToDaily}
                onOpenEvent={(event, day) => setModal({ kind: "event", event, date: day })}
                onNewEvent={() => setModal({ kind: "event", event: null, date: today })}
                onOpenCalendar={() => openCalendarOn(today)}
                onOpenTask={(task) => setModal({ kind: "task", task })}
                onCompleteTask={(id) => void home.completeBoardTask(id)}
                onOpenNoteTask={openNoteTask}
                onNewTask={newTask}
                onOpenTasks={() => setView("tasks")}
              />
            </div>
            <div className="home-area-continue">
              <ContinueBlock
                now={now}
                vaultPath={vaultPath}
                notes={vaultNotes}
                projects={projects}
                conversations={home.conversations}
                loadingProjects={home.loading.projects}
                loadingConversations={home.loading.conversations}
                projectsError={home.errors.projects}
                conversationsError={home.errors.conversations}
                onOpenNote={openNote}
                onOpenProject={openProject}
                onOpenConversation={openConversation}
                onSeeAll={seeAll}
                onNewNote={() => shell.setNewNoteOpen(true)}
                onChooseVault={() => shell.openSettings("vault")}
              />
            </div>
          </div>
          <div className="home-col-side">
            <div className="home-area-focus">
              <FocusBlock
                stats={home.focusStats}
                today={today}
                loading={home.loading.focus && !home.focusStats}
                error={home.errors.focus}
                onOpenSettings={() => shell.openSettings(HOME_SETTINGS_ID)}
              />
            </div>
            <div className="home-area-pinned">
              <HomeBlock
                title="Pinned"
                icon={Pin}
                count={pinTotal}
                className="home-pinned"
                actionLabel="Manage"
                onAction={() => home.setPinsDrawerOpen(true)}
              >
                <PinsPanel variant="compact" />
              </HomeBlock>
            </div>
            <div className="home-area-vault">
              <VaultBlock
                vaultPath={vaultPath}
                stats={vaultStats}
                noteCount={vaultNotes.length}
                indexing={indexing}
                lastIndex={home.lastIndex}
                now={now}
                onIndex={() => void home.runIndex()}
                onOpenGraph={() => setView("graph")}
                onChooseVault={() => shell.openSettings("vault")}
              />
            </div>
          </div>
        </div>
      </div>

      {modal?.kind === "task" && (
        <TaskDetailModal
          task={modal.task}
          defaultStatus="todo"
          onClose={() => {
            setModal(null);
            void useHomeStore.getState().refreshTasks();
          }}
        />
      )}
      {modal?.kind === "event" && (
        <EventEditorModal
          event={modal.event}
          prefilledDate={modal.event ? null : modal.date}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

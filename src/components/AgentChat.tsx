import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Archive,
  ArrowUp,
  Bot,
  Check,
  Cloud,
  FileText,
  FoldVertical,
  HardDrive,
  History,
  Layers,
  RotateCcw,
  Save,
  SquarePen,
  User,
  X,
  Zap,
} from "lucide-react";
import { IconButton, Select, Spinner, cx, useToast } from "../ui";
import { useAetherStore, type AiProvider } from "../lib/store";
import {
  agentQueryWithConversation,
  createAetherNote,
  deleteConversation,
  getAetherNotes,
  getRecentConversations,
  isDesktopRuntime,
  listCloudModels,
  listLocalModels,
  onStreamChunk,
} from "../lib/ipc";
import { parseAgentActions, stripActionBlocks } from "../lib/agentActions";
import { supportsAgentActions } from "../lib/agentModelSupport";
import { filterModels, parseSlashInput } from "../lib/slash";
import { activeMessages, useIntelStore, type ChatMessage } from "../lib/intelStore";
import { persistSession, processAgentActions, shouldAutoCompact } from "../lib/intel/pipeline";
import { compactNow } from "../lib/intel/commands";
import { conversationTitle, isCompactionSummary } from "../lib/intel/summary";
import { estimateConversationTokens } from "../lib/intel/tokens";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ActionRunList } from "./intel/ActionRunList";
import { ApprovalModal } from "./intel/ApprovalModal";
import { CompactionCard } from "./intel/CompactionCard";
import { RelatedContextChip } from "./intel/RelatedContextChip";
import { TokenMeter } from "./intel/TokenMeter";

/** Memoized so streaming updates never re-render the whole history. The
 *  ```action blocks are hidden — the "Tools used" panel shows them. */
const ChatMessageRow = React.memo(function ChatMessageRow({ role, content }: ChatMessage) {
  return (
    <div className={`chat-msg chat-msg-${role}`}>
      <div className="chat-msg-icon">{role === "user" ? <User size={14} /> : <Bot size={14} />}</div>
      <div className="chat-msg-content">
        {role === "assistant" ? <MarkdownRenderer content={stripActionBlocks(content) || content} /> : content}
      </div>
    </div>
  );
});

export function AgentChat({ width = 340 }: { width?: number }) {
  const toast = useToast();
  const {
    agentOutput,
    appendAgentOutput,
    clearAgentOutput,
    setAgentContext,
    setAetherNotes,
    busy,
    setBusy,
    vaultNotes,
    contextNotes,
    allNotesInContext,
    toggleContextNote,
    resetContextToAll,
    conversations,
    setConversations,
    provider,
    setProvider,
    modelByProvider,
    setModelForProvider,
    health,
    setChatOpen,
  } = useAetherStore();

  const session = useIntelStore((s) => s.session);
  const runs = useIntelStore((s) => s.runs);
  const settings = useIntelStore((s) => s.settings);
  const settingsLoaded = useIntelStore((s) => s.settingsLoaded);
  const compacting = useIntelStore((s) => s.compacting);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingUserMsg = useRef<string | null>(null);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextSearch, setContextSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const currentModel = modelByProvider[provider];
  const compactedCount = session.compaction?.compactedCount ?? 0;
  const windowMessages = useMemo(() => activeMessages(session), [session]);
  const earlierMessages = useMemo(() => session.messages.slice(0, compactedCount), [session.messages, compactedCount]);
  const windowTokens = useMemo(
    () => estimateConversationTokens(session.compaction?.summary, windowMessages),
    [session.compaction?.summary, windowMessages]
  );
  const compactable = !busy && !compacting && windowMessages.length > Math.max(1, settings.keep_recent_messages);

  const providerModels = useMemo(
    () =>
      provider === "ollama"
        ? localModels.length > 0
          ? localModels
          : [currentModel]
        : cloudModels.length > 0
          ? cloudModels
          : [currentModel],
    [provider, localModels, cloudModels, currentModel]
  );

  const slash = parseSlashInput(input);
  const slashMatches = useMemo(() => (slash ? filterModels(providerModels, slash.query) : []), [slash, providerModels]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slash?.query, provider]);

  useEffect(() => {
    void getRecentConversations(20).then(setConversations).catch(() => {});
  }, [setConversations]);

  useEffect(() => {
    if (!settingsLoaded && isDesktopRuntime()) void useIntelStore.getState().loadSettings().catch(() => {});
  }, [settingsLoaded]);

  useEffect(() => {
    if (provider !== "ollama" || localModels.length > 0) return;
    void listLocalModels().then(setLocalModels).catch(() => {});
  }, [provider, localModels.length]);

  useEffect(() => {
    if (provider !== "openrouter" || cloudModels.length > 0 || !health?.openrouter_configured) return;
    void listCloudModels().then(setCloudModels).catch(() => {});
  }, [provider, cloudModels.length, health?.openrouter_configured]);

  const handleModelChange = useCallback(
    (model: string) => setModelForProvider(provider, model),
    [provider, setModelForProvider]
  );

  const applySlashModel = useCallback(
    (model: string) => {
      handleModelChange(model);
      setInput("");
    },
    [handleModelChange]
  );

  const activeContextPaths = useMemo(() => {
    if (allNotesInContext) return vaultNotes.map((n) => n.path);
    return vaultNotes.filter((n) => contextNotes.has(n.path)).map((n) => n.path);
  }, [allNotesInContext, contextNotes, vaultNotes]);

  const filteredContextNotes = useMemo(() => {
    if (!contextSearch.trim()) return vaultNotes;
    const q = contextSearch.toLowerCase();
    return vaultNotes.filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
  }, [vaultNotes, contextSearch]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onStreamChunk(appendAgentOutput)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appendAgentOutput]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [agentOutput, session.messages.length, runs.length]);

  const runCompaction = useCallback(
    async (auto: boolean) => {
      try {
        await compactNow();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (auto) toast.error("Automatic compaction failed", { description: message });
        else toast.error("Could not compact the conversation", { description: message });
      }
    },
    [toast]
  );

  /** Save the session and compact it when auto mode says so. */
  const afterTurn = useCallback(async () => {
    const context = useAetherStore.getState().agentContext;
    try {
      await persistSession(context);
    } catch (e) {
      toast.error("The conversation could not be saved", { description: e instanceof Error ? e.message : String(e) });
    }
    if (shouldAutoCompact()) await runCompaction(true);
  }, [runCompaction, toast]);

  // A reply finished streaming: add the turn, run its actions, save.
  useEffect(() => {
    if (!busy && agentOutput && pendingUserMsg.current) {
      const userMsg = pendingUserMsg.current;
      const aiMsg = agentOutput;
      pendingUserMsg.current = null;
      clearAgentOutput();
      useIntelStore.getState().appendTurn(userMsg, aiMsg);
      const actions = parseAgentActions(aiMsg);
      if (actions.length > 0) void processAgentActions(actions);
      void afterTurn();
    }
  }, [busy, agentOutput, clearAgentOutput, afterTurn]);

  const loadConversation = (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv || busy) return;
    useIntelStore.getState().loadConversation(conv);
    clearAgentOutput();
    setShowEarlier(false);
    setShowHistory(false);
  };

  const handleDeleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteConversation(id);
      setConversations(conversations.filter((c) => c.id !== id));
      if (useIntelStore.getState().session.conversationId === id) useIntelStore.getState().setConversationId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startNewChat = () => {
    if (busy) return;
    useIntelStore.getState().resetSession();
    clearAgentOutput();
    setShowEarlier(false);
    setShowHistory(false);
  };

  const handleSubmit = async () => {
    if (!input.trim() || busy) return;
    setError(null);
    const prompt = input.trim();
    pendingUserMsg.current = prompt;
    clearAgentOutput();
    setBusy(true);
    setInput("");

    try {
      const notePaths = activeContextPaths.length > 0 ? activeContextPaths : vaultNotes.map((n) => n.path);
      setAgentContext(notePaths);
      const current = useIntelStore.getState().session;
      await agentQueryWithConversation(prompt, notePaths, currentModel, provider, {
        id: current.conversationId,
        summary: current.compaction?.summary ?? null,
        history: activeMessages(current),
      });
    } catch (e) {
      // Nothing was answered: give the prompt back so it can be retried.
      if (!useAetherStore.getState().agentOutput) {
        pendingUserMsg.current = null;
        setInput(prompt);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const lastAssistantMsg = useMemo(
    () => [...session.messages].reverse().find((m) => m.role === "assistant"),
    [session.messages]
  );
  const savableContent = agentOutput.trim() || lastAssistantMsg?.content.trim() || "";

  const handleSave = async () => {
    if (!savableContent) return;
    try {
      const title = `AI Response — ${new Date().toLocaleString()}`;
      const lastUserMsg = [...session.messages].reverse().find((m) => m.role === "user")?.content || "";
      await createAetherNote(title, savableContent, lastUserMsg, useAetherStore.getState().agentContext);
      setAetherNotes(await getAetherNotes());
      toast.success("Saved to AETHER Notes");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const showPlaceholder = session.messages.length === 0 && !agentOutput && !busy;

  return (
    <div className="agent-chat" style={{ width, minWidth: width }}>
      <div className="agent-header">
        <span className="agent-avatar" aria-hidden="true">
          <Bot size={15} />
        </span>
        <span className="agent-title">AETHER Agent</span>
        <span className={cx("agent-status", (busy || compacting) && "agent-busy")} role="status">
          <span className="agent-status-dot" aria-hidden="true" />
          {busy ? "Thinking..." : compacting ? "Compacting..." : "Ready"}
        </span>
        <span className="agent-header-actions">
          <IconButton
            label="Compact conversation now"
            size="sm"
            icon={compacting ? <Spinner size={12} /> : <FoldVertical size={14} />}
            onClick={() => void runCompaction(false)}
            disabled={!compactable}
            tooltipPlacement="bottom"
          />
          <IconButton
            label="Conversation history"
            size="sm"
            active={showHistory}
            icon={<History size={14} />}
            onClick={() => setShowHistory((v) => !v)}
            tooltipPlacement="bottom"
          />
          <IconButton
            label="New chat"
            size="sm"
            icon={<SquarePen size={14} />}
            onClick={startNewChat}
            disabled={busy}
            tooltipPlacement="bottom"
          />
          <IconButton
            label="Close panel"
            shortcut="mod+j"
            size="sm"
            icon={<X size={14} />}
            onClick={() => setChatOpen(false)}
            tooltipPlacement="bottom"
          />
        </span>
      </div>

      <div className="agent-engine-bar">
        <Select
          size="sm"
          className="agent-provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AiProvider)}
          title="AI provider"
          aria-label="AI provider"
          iconLeft={provider === "ollama" ? <HardDrive size={12} /> : <Cloud size={12} />}
        >
          <option value="ollama">Ollama · Local</option>
          <option value="openrouter">OpenRouter · Cloud</option>
        </Select>
        <Select
          size="sm"
          className="agent-model-select"
          value={currentModel}
          onChange={(e) => handleModelChange(e.target.value)}
          title="Model"
          aria-label="Model"
        >
          {providerModels.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </Select>
        <TokenMeter
          tokens={windowTokens}
          threshold={settings.compact_threshold_tokens}
          autoCompact={settings.auto_compact}
          compacting={compacting}
          onCompact={compactable ? () => void runCompaction(false) : undefined}
        />
        {provider === "ollama" ? (
          <span
            className={`engine-badge ${health?.ollama_online ? "engine-online" : "engine-offline"}`}
            title={health?.ollama_online ? "Ollama is running locally" : "Ollama is offline"}
          >
            <span className="engine-dot" aria-hidden="true" />
            {health?.ollama_online ? "connected" : "offline"}
          </span>
        ) : (
          <span
            className={`engine-badge ${health?.openrouter_configured ? "engine-online" : "engine-offline"}`}
            title={health?.openrouter_configured ? "OpenRouter API key configured" : "Add your OpenRouter key in Settings"}
          >
            <span className="engine-dot" aria-hidden="true" />
            {health?.openrouter_configured ? "connected" : "no key"}
          </span>
        )}
      </div>
      {!supportsAgentActions(currentModel, provider) && (
        <div
          className="agent-engine-warning"
          title="This model may not emit tool calls reliably. Actions will still be parsed from the reply if present."
        >
          <Zap size={11} />
          <span>tools: unreliable — this model may not emit tool calls</span>
        </div>
      )}

      {showHistory && (
        <div className="agent-history">
          {conversations.length === 0 ? (
            <div className="agent-history-empty">No past conversations</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={cx("agent-history-item", c.id === session.conversationId && "is-active")}
                onClick={() => loadConversation(c.id)}
                title={isCompactionSummary(c.summary) ? "Compacted conversation" : undefined}
              >
                {isCompactionSummary(c.summary) && <Archive size={11} className="context-note-icon" aria-hidden="true" />}
                <span className="agent-history-summary">{conversationTitle(c.summary)}</span>
                <span className="agent-history-time">{new Date(c.timestamp * 1000).toLocaleDateString()}</span>
                <button
                  type="button"
                  className="agent-history-delete"
                  aria-label="Delete conversation"
                  onClick={(e) => void handleDeleteConversation(c.id, e)}
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="agent-context-bar">
        <button
          type="button"
          className={cx("agent-context-toggle", showContextPicker && "is-active")}
          onClick={() => setShowContextPicker((v) => !v)}
          title="Select context notes"
          aria-expanded={showContextPicker}
        >
          <Layers size={13} />
          <span className="agent-context-label">
            {allNotesInContext
              ? `All notes (${vaultNotes.length})`
              : `${activeContextPaths.length} of ${vaultNotes.length} notes`}
          </span>
        </button>
        {!allNotesInContext && (
          <IconButton
            label="Reset to all notes"
            size="sm"
            className="agent-context-reset"
            icon={<RotateCcw size={12} />}
            onClick={resetContextToAll}
          />
        )}
        <RelatedContextChip />
      </div>

      {showContextPicker && (
        <div className="context-picker">
          <div className="context-picker-header">
            <span className="context-picker-title">Context Notes</span>
            <IconButton
              label="Close"
              size="sm"
              icon={<X size={14} />}
              onClick={() => setShowContextPicker(false)}
              tooltip={false}
            />
          </div>
          <div className="context-picker-search">
            <input
              type="text"
              placeholder="Filter notes..."
              value={contextSearch}
              onChange={(e) => setContextSearch(e.target.value)}
              className="settings-input context-picker-filter"
              autoFocus
            />
          </div>
          <div className="context-picker-list">
            <div
              className={`context-picker-row ${allNotesInContext ? "context-picker-selected" : ""}`}
              onClick={resetContextToAll}
            >
              <Check size={14} className="context-check" />
              <span className="context-picker-all-label">All notes ({vaultNotes.length})</span>
            </div>
            {filteredContextNotes.map((note) => {
              const isSelected = allNotesInContext || contextNotes.has(note.path);
              return (
                <div
                  key={note.path}
                  className={`context-picker-row ${isSelected ? "context-picker-selected" : ""}`}
                  onClick={() => toggleContextNote(note.path)}
                >
                  <span className="context-check-wrapper">
                    {isSelected && <Check size={14} className="context-check" />}
                  </span>
                  <FileText size={12} className="context-note-icon" />
                  <span className="context-note-name">{note.name.replace(/\.md$/i, "")}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="agent-output" ref={scrollRef}>
        {showPlaceholder && (
          <div className="agent-placeholder">
            <span className="agent-placeholder-icon">
              <Bot size={18} />
            </span>
            <p className="agent-placeholder-title">Ask AETHER anything about your vault</p>
            <p className="agent-placeholder-hint">Answers use your notes as context. Type /model to switch models.</p>
          </div>
        )}
        {session.compaction && (
          <CompactionCard
            compaction={session.compaction}
            showEarlier={showEarlier}
            onToggleEarlier={() => setShowEarlier((v) => !v)}
          />
        )}
        {showEarlier && earlierMessages.length > 0 && (
          <div className="intel-earlier" aria-label="Summarised messages">
            {earlierMessages.map((msg, i) => (
              <ChatMessageRow key={`e${i}`} role={msg.role} content={msg.content} />
            ))}
          </div>
        )}
        {windowMessages.map((msg, i) => (
          <ChatMessageRow key={compactedCount + i} role={msg.role} content={msg.content} />
        ))}
        {busy && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-icon">
              <Bot size={14} />
            </div>
            <div className="chat-msg-content">
              {agentOutput ? (
                <span className="agent-stream">
                  {agentOutput}
                  <span className="stream-cursor" />
                </span>
              ) : (
                <span className="chat-typing" aria-label="Assistant is typing">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <ActionRunList runs={runs} onClear={() => useIntelStore.getState().clearRuns()} />

      {error && <div className="agent-error ui-notice ui-notice-danger">{error}</div>}

      {slash && (
        <div className="slash-menu" role="listbox" aria-label="Model picker">
          <div className="slash-menu-header">
            Models · {provider === "ollama" ? "Ollama" : "OpenRouter"}
            {health?.openrouter_configured === false && provider === "openrouter" && " (no key)"}
          </div>
          <div className="slash-menu-list">
            {slashMatches.length === 0 && <div className="slash-menu-empty">No matching models</div>}
            {slashMatches.map((model, i) => (
              <div
                key={model}
                role="option"
                aria-selected={i === slashIndex}
                className={`slash-menu-item${i === slashIndex ? " slash-menu-active" : ""}${
                  model === currentModel ? " slash-menu-current" : ""
                }`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => applySlashModel(model)}
              >
                {model}
                {model === currentModel && <span className="slash-menu-check">current</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="agent-input-row">
        <textarea
          className="agent-input"
          placeholder="Ask about your notes... (/model to switch)"
          aria-label="Message the agent"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (slash && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                applySlashModel(slashMatches[slashIndex] ?? currentModel);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setInput("");
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          rows={2}
        />
        <div className="agent-actions">
          <IconButton
            label="Save as AETHER Note"
            size="sm"
            icon={<Save size={14} />}
            onClick={() => void handleSave()}
            disabled={!savableContent || busy}
          />
          <button
            type="button"
            className="agent-send"
            onClick={() => void handleSubmit()}
            disabled={!input.trim() || busy}
            aria-label="Send"
            title="Send (Enter)"
          >
            {busy ? <Spinner size={14} /> : <ArrowUp size={15} strokeWidth={2.4} />}
          </button>
        </div>
      </div>

      <ApprovalModal />
    </div>
  );
}

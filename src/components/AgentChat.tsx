import React, { useState, useEffect, useRef, useMemo } from "react";
import { Send, Bot, Loader, FileText, Sparkles, Save, User, X, Check, Layers, History, Plus } from "lucide-react";
import { useAetherStore } from "../lib/store";
import {
  agentQuery, agentQueryWithNotes, onStreamChunk, createAetherNote, getAetherNotes,
  saveConversation, getRecentConversations, deleteConversation,
} from "../lib/ipc";

const DEFAULT_MODEL = "gemma2:2b";

type ChatMessage = { role: "user" | "assistant"; content: string };

export function AgentChat({ width = 340 }: { width?: number }) {
  const {
    agentOutput,
    appendAgentOutput,
    clearAgentOutput,
    agentContext,
    setAgentContext,
    setAetherNotes,
    busy,
    setBusy,
    selectedNotePath,
    vaultNotes,
    contextNotes,
    allNotesInContext,
    toggleContextNote,
    resetContextToAll,
    conversations,
    setConversations,
  } = useAetherStore();

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const pendingUserMsg = useRef<string | null>(null);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextSearch, setContextSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    void getRecentConversations(20).then(setConversations).catch(() => {});
  }, [setConversations]);

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
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [agentOutput, messages]);

  useEffect(() => {
    if (!busy && agentOutput && pendingUserMsg.current) {
      const userMsg = pendingUserMsg.current;
      const aiMsg = agentOutput;
      setMessages((prev) => [...prev, { role: "user", content: userMsg }, { role: "assistant", content: aiMsg }]);
      pendingUserMsg.current = null;
      clearAgentOutput();
      void saveConversation(
        [{ role: "user", content: userMsg }, { role: "assistant", content: aiMsg }],
        agentContext
      ).then((conv) => {
        setConversations([conv, ...useAetherStore.getState().conversations].slice(0, 20));
      }).catch(() => {});
    }
  }, [busy, agentOutput, clearAgentOutput, agentContext, setConversations]);

  const loadConversation = (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    setMessages(
      conv.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    );
    setShowHistory(false);
  };

  const handleDeleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteConversation(id);
      setConversations(conversations.filter((c) => c.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startNewChat = () => {
    setMessages([]);
    clearAgentOutput();
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
      await agentQueryWithNotes(prompt, notePaths, DEFAULT_MODEL);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const lastAssistantMsg = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant"),
    [messages]
  );
  const savableContent = agentOutput.trim() || lastAssistantMsg?.content.trim() || "";

  const handleSave = async () => {
    if (!savableContent) return;
    try {
      const title = `AI Response — ${new Date().toLocaleString()}`;
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      await createAetherNote(title, savableContent, lastUserMsg, agentContext);
      const notes = await getAetherNotes();
      setAetherNotes(notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="agent-chat" style={{ width, minWidth: width }}>
      <div className="agent-header">
        <Bot size={18} />
        <span className="agent-title">AETHER Agent</span>
        <span className={`agent-status ${busy ? "agent-busy" : ""}`}>
          {busy ? "Thinking..." : "Ready"}
        </span>
        <button
          className="btn btn-icon agent-header-btn"
          onClick={() => setShowHistory((v) => !v)}
          title="Conversation history"
        >
          <History size={14} />
        </button>
        <button
          className="btn btn-icon agent-header-btn"
          onClick={startNewChat}
          title="New chat"
        >
          <Plus size={14} />
        </button>
      </div>

      {showHistory && (
        <div className="agent-history">
          {conversations.length === 0 ? (
            <div className="agent-history-empty">No past conversations</div>
          ) : (
            conversations.map((c) => (
              <div key={c.id} className="agent-history-item" onClick={() => loadConversation(c.id)}>
                <span className="agent-history-summary">{c.summary || "Conversation"}</span>
                <span className="agent-history-time">
                  {new Date(c.timestamp * 1000).toLocaleDateString()}
                </span>
                <button
                  className="agent-history-delete"
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
          className="btn btn-icon agent-context-toggle"
          onClick={() => setShowContextPicker((v) => !v)}
          title="Select context notes"
        >
          <Layers size={14} />
        </button>
        <span className="agent-context-label">
          {allNotesInContext
            ? `All notes (${vaultNotes.length})`
            : `${activeContextPaths.length} of ${vaultNotes.length} notes`}
        </span>
        {!allNotesInContext && (
          <button
            className="btn btn-icon agent-context-reset"
            onClick={resetContextToAll}
            title="Reset to all notes"
          >
            <Check size={12} />
          </button>
        )}
      </div>

      {showContextPicker && (
        <div className="context-picker">
          <div className="context-picker-header">
            <span className="context-picker-title">Context Notes</span>
            <button className="btn btn-icon" onClick={() => setShowContextPicker(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="context-picker-search">
            <input
              type="text"
              placeholder="Filter notes..."
              value={contextSearch}
              onChange={(e) => setContextSearch(e.target.value)}
              className="sidebar-search-input"
              style={{ paddingLeft: "10px" }}
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
        {messages.length === 0 && !agentOutput && !busy && (
          <div className="agent-placeholder">
            <Bot size={32} />
            <p>Ask AETHER anything about your vault</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
            <div className="chat-msg-icon">
              {msg.role === "user" ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className="chat-msg-content">{msg.content}</div>
          </div>
        ))}
        {busy && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-icon"><Bot size={14} /></div>
            <div className="chat-msg-content">
              {agentOutput ? (
                <pre className="agent-output-text">{agentOutput}</pre>
              ) : (
                <span className="chat-typing">Thinking...</span>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <div className="agent-error">{error}</div>}

      <div className="agent-input-row">
        <textarea
          className="agent-input"
          placeholder="Ask about your notes..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          rows={2}
        />
        <div className="agent-actions">
          <button
            className="btn btn-icon"
            onClick={handleSave}
            disabled={!savableContent || busy}
            title="Save as AETHER Note"
          >
            <Save size={16} />
          </button>
          <button
            className="btn btn-primary btn-send"
            onClick={handleSubmit}
            disabled={!input.trim() || busy}
          >
            {busy ? <Loader size={16} className="spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

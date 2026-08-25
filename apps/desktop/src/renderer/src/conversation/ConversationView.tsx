import { useEffect, useState } from "react";

import { applyConversationEvent, applyConversationSnapshot, emptyConversationSnapshot, isConversationSnapshot } from "./conversation-state.js";
import type { ConversationActionStatus, ConversationEvent, ConversationSnapshot } from "./conversation-types.js";

type ConversationApi = {
  getConversationSnapshot(): Promise<unknown>;
  sendConversationMessage(text: string): Promise<unknown>;
  cancelConversationTurn(): Promise<{ cancelled: boolean }>;
  onConversationEvent(callback: (event: ConversationEvent) => void): () => void;
};

export function ConversationView({ api }: { api: ConversationApi }) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>(() => emptyConversationSnapshot());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function loadSnapshot(): Promise<void> {
    setLoading(true);
    try {
      const next = await api.getConversationSnapshot();
      if (!isConversationSnapshot(next)) throw new Error("Conversation snapshot was malformed.");
      setSnapshot((current) => applyConversationSnapshot(current, next));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Conversation is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const unsubscribe = api.onConversationEvent((event) => {
      setSnapshot((current) => applyConversationEvent(current, event));
    });
    void loadSnapshot();
    return unsubscribe;
  }, []);

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || snapshot.activeTurnId) return;
    setSending(true);
    setError("");
    setDraft("");
    try {
      await api.sendConversationMessage(text);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The message could not be sent.");
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  async function cancelTurn(): Promise<void> {
    try {
      await api.cancelConversationTurn();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The active turn could not be cancelled.");
    }
  }

  const statusLabel = snapshot.activity === "thinking"
    ? "Thinking"
    : snapshot.activity === "acting"
      ? `Using ${snapshot.activeToolName ?? "a capability"}`
      : snapshot.activity === "responding"
        ? "Responding"
        : snapshot.activity === "cancelled"
          ? "Turn cancelled"
          : snapshot.activity === "failed"
            ? "Turn failed"
            : "Ready for a message";

  return (
    <div className="conversation-layout">
      <section className="conversation-shell glass" aria-label="Pet Assistant conversation">
        <div className="conversation-header">
          <div>
            <p className="eyebrow">Shared session</p>
            <h2>Talk with your pet</h2>
            <p className="conversation-subtitle">Typed messages and future voice transcripts share one host-owned conversation.</p>
          </div>
          <div className={`conversation-status conversation-status-${snapshot.activity}`} role="status">
            <span className="conversation-status-dot" aria-hidden="true" />
            {statusLabel}
          </div>
        </div>

        {error && <div className="error conversation-error" role="alert">{error}<button className="conversation-retry" type="button" onClick={() => void loadSnapshot()}>Retry</button></div>}

        <div className="conversation-transcript" aria-live="polite">
          {loading && snapshot.items.length === 0 ? <div className="conversation-empty">Loading the current session...</div> : snapshot.items.length === 0 ? (
            <div className="conversation-empty">
              <strong>Start a conversation</strong>
              <span>Ask your pet to use an enabled capability or simply say hello.</span>
            </div>
          ) : snapshot.items.map((item) => item.kind === "message" ? (
            <article className={`conversation-message conversation-message-${item.role} ${item.source === "voice" ? "conversation-message-voice" : ""}`} key={item.id}>
              <div className="conversation-message-meta">{item.role === "user" ? "You" : "Pet Assistant"}{item.source === "voice" ? " · voice" : ""}{item.partial ? " · live" : ""}</div>
              <p>{item.text}</p>
            </article>
          ) : (
            <article className={`conversation-action conversation-action-${item.status}`} key={item.id}>
              <div className="conversation-action-mark" aria-hidden="true">{item.status === "completed" ? "✓" : item.status === "running" || item.status === "pending" ? "•" : "!"}</div>
              <div><strong>{item.toolName}</strong><span>{actionLabel(item.status, item.reason)}</span></div>
            </article>
          ))}
        </div>

        {snapshot.terminal?.status === "failed" && snapshot.terminal.error && <div className="conversation-terminal conversation-terminal-failed">{snapshot.terminal.error}</div>}
        {snapshot.terminal?.status === "cancelled" && <div className="conversation-terminal conversation-terminal-cancelled">The turn was cancelled. Any capability already invoked is shown as indeterminate.</div>}

        <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message your pet..."
            aria-label="Message your pet"
            rows={2}
            maxLength={64 * 1024}
            disabled={sending || Boolean(snapshot.activeTurnId)}
          />
          <div className="conversation-composer-footer">
            <span>Voice transcript integration will appear here when #147 publishes its normalized events.</span>
            {snapshot.activeTurnId ? <button className="btn btn-danger" type="button" onClick={() => void cancelTurn()}>Stop</button> : <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()}>{sending ? "Sending..." : "Send"}</button>}
          </div>
        </form>
      </section>
    </div>
  );
}

function actionLabel(status: ConversationActionStatus, reason?: string): string {
  if (status === "pending") return "Queued";
  if (status === "running") return "Working now";
  if (status === "completed") return "Completed";
  return reason ? `${status} · ${reason}` : status;
}

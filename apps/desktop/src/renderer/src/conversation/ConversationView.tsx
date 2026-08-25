import { useEffect, useRef, useState } from "react";

import { applyConversationEvent, applyConversationSnapshot, emptyConversationSnapshot, isConversationSnapshot } from "./conversation-state.js";
import { createVoiceSnapshotOrdering, voiceBadgeClass, voiceStatusLabel } from "./conversation-types.js";
import type {
  ConversationActionStatus,
  ConversationEvent,
  ConversationSnapshot,
  VoiceAssistantErrorScope,
  VoiceAssistantTalkEvent,
  VoiceAssistantSessionSnapshot,
  VoiceAssistantShortcutStatus,
} from "./conversation-types.js";

type ConversationApi = {
  getConversationSnapshot(): Promise<unknown>;
  sendConversationMessage(text: string): Promise<unknown>;
  cancelConversationTurn(): Promise<{ cancelled: boolean }>;
  onConversationEvent(callback: (event: ConversationEvent) => void): () => void;

  getVoiceAssistantSnapshot?(): Promise<unknown>;
  startVoiceAssistant?(): Promise<unknown>;
  muteVoiceAssistant?(): Promise<unknown>;
  unmuteVoiceAssistant?(): Promise<unknown>;
  interruptVoiceAssistant?(): Promise<unknown>;
  endVoiceAssistant?(): Promise<unknown>;
  onVoiceAssistantEvent?(callback: (event: VoiceAssistantTalkEvent) => void): () => void;
  getSettingsState?(): Promise<unknown>;
};

export function ConversationView({ api }: { api: ConversationApi }) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>(() => emptyConversationSnapshot());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const [voiceSnapshot, setVoiceSnapshot] = useState<VoiceAssistantSessionSnapshot>(() => normalizeVoiceSnapshot(null));
  const [shortcutInfo, setShortcutInfo] = useState<{ accelerator?: string; status?: VoiceAssistantShortcutStatus; reason?: string } | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceActionError, setVoiceActionError] = useState("");
  const voiceSnapshotOrdering = useRef(createVoiceSnapshotOrdering()).current;

  async function loadSnapshot(): Promise<void> {
    setLoading(true);
    try {
      const next = await api.getConversationSnapshot();
      if (!isConversationSnapshot(next)) throw new Error("Conversation snapshot was malformed.");
      setSnapshot((current: ConversationSnapshot) => applyConversationSnapshot(current, next));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Conversation is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;

    const unsubscribeConv = api.onConversationEvent((event) => {
      if (isMounted) setSnapshot((current: ConversationSnapshot) => applyConversationEvent(current, event));
    });

    const unsubscribeVoice = api.onVoiceAssistantEvent?.((event) => {
      if (!isMounted) return;
      if (!voiceSnapshotOrdering.noteEvent(event.sessionId, event.sequence)) return;
      if (event.type === "snapshot") {
        setVoiceSnapshot(normalizeVoiceSnapshot(event.snapshot));
      } else if (event.type === "error") {
        setVoiceSnapshot((current: VoiceAssistantSessionSnapshot) => ({
          ...current,
          error: { scope: event.scope, message: event.message },
        }));
      } else if (event.type === "ended") {
        setVoiceSnapshot((current: VoiceAssistantSessionSnapshot) => ({ ...current, status: "ended", activity: null }));
      } else if (event.type === "interrupted") {
        setVoiceSnapshot((current: VoiceAssistantSessionSnapshot) => ({
          ...current,
          activity: null,
        }));
      } else if (event.type === "turn-settled") {
        // The authoritative terminal state arrives in the session snapshot;
        // this event only marks playback settlement for host consumers.
      } else if (event.type === "transcript") {
        if (event.speaker === "user") {
          setVoiceSnapshot((current: VoiceAssistantSessionSnapshot) => ({ ...current, userTranscript: event.text }));
        } else if (event.speaker === "assistant") {
          setVoiceSnapshot((current: VoiceAssistantSessionSnapshot) => ({ ...current, assistantTranscript: event.text }));
        }
      }
    });

    if (api.getVoiceAssistantSnapshot) {
      const requestVersion = voiceSnapshotOrdering.beginInitialRequest();
      api.getVoiceAssistantSnapshot()
        .then((snap) => {
          if (isMounted && voiceSnapshotOrdering.shouldApplyInitialSnapshot(requestVersion)) setVoiceSnapshot(normalizeVoiceSnapshot(snap));
        })
        .catch((err) => {
          if (isMounted) setVoiceActionError(err instanceof Error ? err.message : "Voice status unavailable.");
        });
    }

    if (api.getSettingsState) {
      api.getSettingsState()
        .then((res: any) => {
          if (!isMounted) return;
          if (res?.voiceAssistantShortcutStatus) {
            setShortcutInfo({
              accelerator: res.voiceAssistantShortcutStatus.accelerator,
              status: res.voiceAssistantShortcutStatus.status,
              reason: res.voiceAssistantShortcutStatus.reason,
            });
          } else if (res?.preferences?.voiceAssistantShortcut) {
            setShortcutInfo({
              accelerator: res.preferences.voiceAssistantShortcut,
              status: "registered",
            });
          }
        })
        .catch(() => { /* ignore */ });
    }

    void loadSnapshot();

    return () => {
      isMounted = false;
      unsubscribeConv();
      unsubscribeVoice?.();
    };
  }, [api]);

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (talkModalityBusy) {
      setError("Talk is active. End Talk before sending a typed message.");
      return;
    }
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

  async function startVoice(): Promise<void> {
    if (typedModalityBusy) {
      setVoiceActionError("A typed Pet Assistant turn is active. Wait for it to finish before starting Talk.");
      return;
    }
    if (!api.startVoiceAssistant) {
      setVoiceActionError("Voice assistant bridge API is not available.");
      return;
    }
    setVoiceBusy(true);
    setVoiceActionError("");
    const requestVersion = voiceSnapshotOrdering.beginRequest();
    try {
      const result = await api.startVoiceAssistant();
      if (voiceSnapshotOrdering.shouldApplyResponse(requestVersion)) setVoiceSnapshot(normalizeVoiceSnapshot(result));
    } catch (err) {
      setVoiceActionError(err instanceof Error ? err.message : "Failed to start voice assistant.");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function toggleMute(): Promise<void> {
    const fn = voiceSnapshot.muted ? api.unmuteVoiceAssistant : api.muteVoiceAssistant;
    if (!fn) {
      setVoiceActionError("Voice mute bridge API is not available.");
      return;
    }
    setVoiceBusy(true);
    setVoiceActionError("");
    const requestVersion = voiceSnapshotOrdering.beginRequest();
    try {
      const result = await fn();
      if (voiceSnapshotOrdering.shouldApplyResponse(requestVersion)) setVoiceSnapshot(normalizeVoiceSnapshot(result));
    } catch (err) {
      setVoiceActionError(err instanceof Error ? err.message : "Failed to update mute state.");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function interruptVoice(): Promise<void> {
    if (!api.interruptVoiceAssistant) {
      setVoiceActionError("Voice interrupt bridge API is not available.");
      return;
    }
    setVoiceBusy(true);
    setVoiceActionError("");
    const requestVersion = voiceSnapshotOrdering.beginRequest();
    try {
      const result = await api.interruptVoiceAssistant();
      if (voiceSnapshotOrdering.shouldApplyResponse(requestVersion)) setVoiceSnapshot(normalizeVoiceSnapshot(result));
    } catch (err) {
      setVoiceActionError(err instanceof Error ? err.message : "Failed to interrupt voice assistant.");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function endVoice(): Promise<void> {
    if (!api.endVoiceAssistant) {
      setVoiceActionError("Voice end bridge API is not available.");
      return;
    }
    setVoiceBusy(true);
    setVoiceActionError("");
    const requestVersion = voiceSnapshotOrdering.beginRequest();
    try {
      const result = await api.endVoiceAssistant();
      if (voiceSnapshotOrdering.shouldApplyResponse(requestVersion)) setVoiceSnapshot(normalizeVoiceSnapshot(result));
    } catch (err) {
      setVoiceActionError(err instanceof Error ? err.message : "Failed to end voice assistant session.");
    } finally {
      setVoiceBusy(false);
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

  const isVoiceActive = voiceSnapshot.status === "active" || voiceSnapshot.status === "muted" || voiceSnapshot.status === "paused" || voiceSnapshot.status === "ending";
  const talkModalityBusy = voiceSnapshot.status === "active" || voiceSnapshot.status === "muted" || voiceSnapshot.status === "ending";
  const typedModalityBusy = sending || Boolean(snapshot.activeTurnId);
  const talkControlsDisabled = voiceBusy || voiceSnapshot.status === "ending";
  const canInterrupt = isVoiceActive && voiceSnapshot.status !== "ending" && (voiceSnapshot.activity === "thinking" || voiceSnapshot.activity === "acting" || voiceSnapshot.activity === "speaking");

  const currentAccelerator = voiceSnapshot.shortcut ?? shortcutInfo?.accelerator;
  const currentShortcutStatus = voiceSnapshot.shortcutStatus ?? shortcutInfo?.status;
  const currentShortcutReason = voiceSnapshot.shortcutReason ?? shortcutInfo?.reason;

  return (
    <div className="conversation-layout">
      <section className="conversation-shell glass" aria-label="Pet Assistant conversation">
        <div className="conversation-header">
          <div>
            <p className="eyebrow">Shared session</p>
            <h2>Talk with your pet</h2>
            <p className="conversation-subtitle">Typed messages and voice transcripts share one host-owned conversation.</p>
          </div>
          <div className={`conversation-status conversation-status-${snapshot.activity}`} role="status">
            <span className="conversation-status-dot" aria-hidden="true" />
            {statusLabel}
          </div>
        </div>

        {/* Voice Assistant Controls Card */}
        <div className="conversation-voice-card">
          <div className="conversation-voice-header">
            <div className="conversation-voice-badges">
              <span className={`voice-badge ${voiceBadgeClass(voiceSnapshot.status, voiceSnapshot.activity, voiceSnapshot.muted)}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                {voiceStatusLabel(voiceSnapshot.status, voiceSnapshot.activity, voiceSnapshot.muted)}
              </span>

              <span className={`voice-badge ${shortcutBadgeClass(currentShortcutStatus)}`}>
                <KeyboardIcon />
                {currentAccelerator ? <kbd className="shortcut-kbd">{currentAccelerator}</kbd> : null}
                <span>{shortcutStatusLabel(currentShortcutStatus)}</span>
              </span>
            </div>

            <div className="conversation-voice-controls">
              {!isVoiceActive ? (
                <button
                  type="button"
                  className="btn btn-primary min-w-[100px]"
                  disabled={voiceBusy || typedModalityBusy}
                  onClick={() => void startVoice()}
                >
                  <MicIcon />
                  <span>Start Talk</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={`btn ${voiceSnapshot.muted ? "btn-secondary" : "btn-warning"}`}
                    disabled={talkControlsDisabled}
                    onClick={() => void toggleMute()}
                  >
                    {voiceSnapshot.muted ? <MicIcon /> : <MicOffIcon />}
                    <span>{voiceSnapshot.muted ? "Unmute Mic" : "Mute Mic"}</span>
                  </button>

                  {canInterrupt && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={talkControlsDisabled}
                      onClick={() => void interruptVoice()}
                    >
                      <StopIcon />
                      <span>Interrupt</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={talkControlsDisabled}
                    onClick={() => void endVoice()}
                  >
                    <PhoneOffIcon />
                    <span>End Talk</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Feedback & Error Banners */}
          {currentShortcutStatus === "conflict" && (
            <div className="voice-banner voice-banner-conflict" role="alert">
              <AlertIcon />
              <span>
                Shortcut <strong>{currentAccelerator ?? "..."}</strong> conflicts with another application hotkey. Change it in Settings.{currentShortcutReason ? ` (${currentShortcutReason})` : ""}
              </span>
            </div>
          )}

          {currentShortcutStatus === "unavailable" && (
            <div className="voice-banner voice-banner-warning" role="alert">
              <AlertIcon />
              <span>
                Shortcut <strong>{currentAccelerator ?? "..."}</strong> is unavailable on this OS platform.{currentShortcutReason ? ` (${currentShortcutReason})` : ""}
              </span>
            </div>
          )}

          {currentShortcutStatus === "invalid" && (
            <div className="voice-banner voice-banner-error" role="alert">
              <AlertIcon />
              <span>
                Shortcut <strong>{currentAccelerator ?? "..."}</strong> is invalid. Change it in Settings.{currentShortcutReason ? ` (${currentShortcutReason})` : ""}
              </span>
            </div>
          )}

          {typedModalityBusy && !isVoiceActive && (
            <div className="voice-banner voice-banner-warning" role="status">
              A typed Pet Assistant turn is active. Talk will be available when it finishes.
            </div>
          )}

          {voiceSnapshot.error && (
            <div className="voice-banner voice-banner-error" role="alert">
              <span>[{voiceSnapshot.error.scope}] {voiceSnapshot.error.message}</span>
              <button className="conversation-retry" type="button" onClick={() => setVoiceSnapshot((curr) => ({ ...curr, error: null }))}>
                Dismiss
              </button>
            </div>
          )}

          {voiceActionError && (
            <div className="voice-banner voice-banner-error" role="alert">
              <span>{voiceActionError}</span>
              <button className="conversation-retry" type="button" onClick={() => setVoiceActionError("")}>
                Dismiss
              </button>
            </div>
          )}

          {/* Live Transcript / Interruption Indicator */}
          {(voiceSnapshot.userTranscript || voiceSnapshot.assistantTranscript || (voiceSnapshot.interruptionCount ?? 0) > 0) && (
            <div className="voice-transcript-preview">
              {voiceSnapshot.userTranscript && (
                <div><strong>You (voice):</strong> {voiceSnapshot.userTranscript}</div>
              )}
              {voiceSnapshot.assistantTranscript && (
                <div><strong>Pet (voice):</strong> {voiceSnapshot.assistantTranscript}</div>
              )}
              {(voiceSnapshot.interruptionCount ?? 0) > 0 && (
                <div className="mt-1 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                  Interrupted {voiceSnapshot.interruptionCount} time{(voiceSnapshot.interruptionCount ?? 0) > 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="error conversation-error" role="alert">
            {error}
            <button className="conversation-retry" type="button" onClick={() => void loadSnapshot()}>
              Retry
            </button>
          </div>
        )}

        {talkModalityBusy && (
          <div className="error conversation-error" role="status">
            Talk is active. Typed messages are available when Talk ends.
          </div>
        )}

        <div className="conversation-transcript" aria-live="polite">
          {loading && snapshot.items.length === 0 ? (
            <div className="conversation-empty">Loading the current session...</div>
          ) : snapshot.items.length === 0 ? (
            <div className="conversation-empty">
              <strong>Start a conversation</strong>
              <span>Ask your pet to use an enabled capability or simply say hello.</span>
            </div>
          ) : (
            snapshot.items.map((item) =>
              item.kind === "message" ? (
                <article
                  className={`conversation-message conversation-message-${item.role} ${item.source === "voice" ? "conversation-message-voice" : ""}`}
                  key={item.id}
                >
                  <div className="conversation-message-meta">
                    {item.role === "user" ? "You" : "Pet Assistant"}
                    {item.source === "voice" ? " · voice" : ""}
                    {item.partial ? " · live" : ""}
                  </div>
                  <p>{item.text}</p>
                </article>
              ) : (
                <article className={`conversation-action conversation-action-${item.status}`} key={item.id}>
                  <div className="conversation-action-mark" aria-hidden="true">
                    {item.status === "completed" ? "✓" : item.status === "running" || item.status === "pending" ? "•" : "!"}
                  </div>
                  <div>
                    <strong>{item.toolName}</strong>
                    <span>{actionLabel(item.status, item.reason)}</span>
                  </div>
                </article>
              ),
            )
          )}
        </div>

        {snapshot.terminal?.status === "failed" && snapshot.terminal.error && (
          <div className="conversation-terminal conversation-terminal-failed">{snapshot.terminal.error}</div>
        )}
        {snapshot.terminal?.status === "cancelled" && (
          <div className="conversation-terminal conversation-terminal-cancelled">
            The turn was cancelled. Any capability already invoked is shown as indeterminate.
          </div>
        )}

        <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message your pet..."
            aria-label="Message your pet"
            rows={2}
            maxLength={64 * 1024}
            disabled={typedModalityBusy || talkModalityBusy}
          />
          <div className="conversation-composer-footer">
            <span>
              Press {currentAccelerator ? <kbd className="shortcut-kbd">{currentAccelerator}</kbd> : "shortcut"} or use the Talk controls to speak with your pet.
            </span>
            {snapshot.activeTurnId ? (
              <button className="btn btn-danger" type="button" onClick={() => void cancelTurn()}>
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" type="submit" disabled={typedModalityBusy || talkModalityBusy || !draft.trim()}>
                {sending ? "Sending..." : "Send"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function normalizeVoiceSnapshot(raw: unknown): VoiceAssistantSessionSnapshot {
  if (!raw || typeof raw !== "object") {
    return {
      sessionId: 0,
      status: "ended",
      activity: null,
      muted: false,
      conversationId: "openpets-control-center-current",
      generation: 0,
      turnId: null,
      userTranscript: null,
      assistantTranscript: null,
      interruptionCount: 0,
      error: null,
      shortcut: "CommandOrControl+Shift+Space",
      shortcutStatus: "unavailable",
      shortcutReason: null,
    };
  }
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === "string" && ["idle", "active", "muted", "paused", "ending", "ended"].includes(r.status)
    ? (r.status as VoiceAssistantSessionSnapshot["status"])
    : "idle";
  const activity = typeof r.activity === "string" && ["listening", "thinking", "acting", "speaking"].includes(r.activity)
    ? (r.activity as VoiceAssistantSessionSnapshot["activity"])
    : null;
  const shortcutStatus = typeof r.shortcutStatus === "string" && ["registered", "conflict", "unavailable", "invalid"].includes(r.shortcutStatus)
    ? (r.shortcutStatus as VoiceAssistantShortcutStatus)
    : "unavailable";

  let errObj: VoiceAssistantSessionSnapshot["error"] = null;
  if (r.error && typeof r.error === "object") {
    const e = r.error as Record<string, unknown>;
    errObj = {
      scope: isVoiceErrorScope(e.scope) ? e.scope : "session",
      message: typeof e.message === "string" ? e.message : "Voice assistant error occurred.",
    };
  }

  return {
    sessionId: typeof r.sessionId === "number" && Number.isSafeInteger(r.sessionId) && r.sessionId >= 0 ? r.sessionId : 0,
    status,
    activity,
    muted: Boolean(r.muted),
    conversationId: typeof r.conversationId === "string" ? r.conversationId : "openpets-control-center-current",
    generation: typeof r.generation === "number" ? r.generation : 0,
    turnId: typeof r.turnId === "string" ? r.turnId : null,
    userTranscript: typeof r.userTranscript === "string" ? r.userTranscript : null,
    assistantTranscript: typeof r.assistantTranscript === "string" ? r.assistantTranscript : null,
    interruptionCount: typeof r.interruptionCount === "number" ? r.interruptionCount : 0,
    error: errObj,
    shortcut: typeof r.shortcut === "string" ? r.shortcut : "CommandOrControl+Shift+Space",
    shortcutStatus,
    shortcutReason: typeof r.shortcutReason === "string" ? r.shortcutReason : null,
  };
}

function isVoiceErrorScope(value: unknown): value is VoiceAssistantErrorScope {
  return value === "input" || value === "assistant" || value === "synthesis" || value === "playback" || value === "session";
}

function shortcutStatusLabel(status?: VoiceAssistantShortcutStatus): string {
  if (status === "registered") return "Active";
  if (status === "conflict") return "Conflict";
  if (status === "unavailable") return "Unavailable";
  if (status === "invalid") return "Invalid";
  return "Pending...";
}

function shortcutBadgeClass(status?: VoiceAssistantShortcutStatus): string {
  if (status === "registered") return "voice-badge-active";
  if (status === "conflict") return "voice-badge-conflict";
  if (status === "unavailable" || status === "invalid") return "voice-badge-error";
  return "voice-badge-neutral";
}

function actionLabel(status: ConversationActionStatus, reason?: string): string {
  if (status === "pending") return "Queued";
  if (status === "running") return "Working now";
  if (status === "completed") return "Completed";
  return reason ? `${status} · ${reason}` : status;
}

const MicIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

const MicOffIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

const StopIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const PhoneOffIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.33A19.79 19.79 0 0 1 2 4.18 2 2 0 0 1 4.18 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
  </svg>
);

const AlertIcon = () => (
  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const KeyboardIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4" />
  </svg>
);

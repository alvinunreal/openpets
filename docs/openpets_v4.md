---
description: "Product direction and delivery goal for OpenPets v4: a conversational pet that can use enabled companion capabilities."
---

# OpenPets v4 — Pet Assistant

## Delivery goal

OpenPets v4 makes the desktop pet a personal assistant, not only a visual
reactor to coding-agent activity. A person can talk to or chat with the pet in
normal language; the pet understands requests, uses the capabilities of enabled
companion plugins, performs the requested work, and responds with the result in
the same conversation.

This is a v4 delivery commitment. It is not a speculative post-v4 direction.

Issue #138 supplies the host-owned provider adapter, canonical in-memory
conversation/tool loop, generation-pinned capability routing, and bounded
turn/lifecycle behavior. Issue #146 adds the persisted, owner-editable
personality profile and deterministic prompt composition on that same host
foundation. The Control Center now has a current-session Conversation surface;
persisted/recent history and sensitive-action confirmation UI remain separate
work. Provider profiles/settings are implemented as a host-owned Control Center
surface; chat and voice product surfaces consume those integrations.

## The product experience

The intended voice product experience is described here for v4 planning. The
#150 delivery adds the pet-owned Talk control, Control Center/tray controls, and
a conservative keyboard shortcut. The host contract supports the flow: one
activation owns one bounded session,
the pet enters listening, the person speaks, the canonical assistant may invoke
an enabled capability, and authoritative output is spoken before the session
can accept another turn.

Chat is another v4 conversation surface, not a separate assistant product. It
uses the same conversation, capabilities, execution results, and pet behavior;
it only changes the input and output modality.

The generic #147 session emits final user and assistant transcript events only;
#150 adapts those events into the shared current-session Conversation surface;
it does not retain transcript/history. Bounded recent-history management remains
deferred to #149. The
provider-neutral host contract does not infer or retain long-term semantic
memory.

OpenPets connects the experience to configured AI, speech-to-text, and
text-to-speech providers through host-owned integrations. The product contract
must not depend on one provider or on whether a provider runs locally or
remotely.

The pet must remain visibly involved. Listening, thinking, acting, speaking,
success, and failure use the existing pet reactions, bubbles, alerts, menus, and
status surfaces rather than becoming an invisible AI feature.

## Plugin-powered capabilities

Plugins are the source of what the pet can do. An enabled plugin may expose
clear, typed capabilities that the Pet Assistant can discover and invoke.

Examples:

- Focus Buddy exposes starting a focus session with a requested duration,
  reporting its status, pausing, resuming, and ending it.
- Quick Reminders exposes creating, listing, completing, snoozing, and removing
  reminders.
- Future companions may expose their own bounded actions without OpenPets adding
  hard-coded intent parsers for each product area.

The Pet Assistant selects from only the capabilities currently available to the
user. The main process supplies validated inputs, invokes the owning plugin,
receives a structured outcome, and turns that outcome into a conversational
response. The owning plugin remains responsible for its domain state, scheduled
work, notifications, and visible companion behavior.

Existing right-click plugin commands remain valuable direct controls. They are
not the long-term AI contract: a command designed for a menu may have no inputs,
while a conversational capability must describe what it does, the arguments it
accepts, and the result it returns.

## Directional boundaries

- The **host** owns the conversation lifecycle, voice/chat surfaces, provider
  integration, microphone reservation lifecycle, capability discovery, execution
  routing, and user-facing conversation feedback. It reports only microphone or
  session facts it can observe; it does not invent device metadata.
- A **plugin** owns its bounded domain operations and declares the capabilities
  it chooses to make available to the Pet Assistant.
- The AI may request a declared capability; it must not receive unrestricted
  plugin APIs, filesystem access, shell access, or arbitrary command execution.
- A capability result is authoritative. The pet must not claim an action
  succeeded when the responsible plugin reports failure or needs more input.
- Realtime voice transport is infrastructure, not the product by itself. The
  product is a pet that can converse and act.

The current #138/#146/#145/#148 implementation has a typed current-session
Conversation surface but no transcript/history persistence or editable
sensitive-action confirmation surface. The Control Center already provides
editable provider profiles and communication preferences on the host. Later v4
issues add retained history on top of the host contract
rather than moving provider or capability authority into plugins.
### #147 generic voice contract

The desktop host composes final-only bounded STT capture, the canonical
generation-pinned Pet Assistant capability runtime, and provider-backed TTS.
Text, STT, and TTS profiles are selected independently; the STT selection is
snapshotted before capture and remains fixed through transcription. Assistant
capability results remain authoritative, and the terminal assistant response is
the exact text handed to TTS. TTS playback is request-scoped with duration-aware
bounded deadlines and settles replacement, stop, renderer loss, navigation, and
timeout paths exactly once. Voice activity renders through a dedicated composable
pet slot so cleanup does not erase unrelated plugin display state.

An activation owns one session and its microphone reservation. Ending releases
that reservation; a later activation creates a fresh session. Assistant,
plugin one-shot, and private Realtime lanes release only their own work. A
shared host resource owner destroys the privacy indicator only after all lanes
have stopped. #150 adds activation controls and the shared Conversation
projection hookup without adding provider protocol, retained history, or
Realtime behavior; those remain separate work.

The current #138/#146/#145 implementation has no chat surface,
transcript/history persistence, or editable sensitive-action confirmation
surface. The Control Center already provides editable provider profiles and
communication preferences on the host. Later v4 issues add conversation
surfaces on top of the host contract rather than moving provider or capability
authority into plugins.

## v4 outcomes

v4 is complete only when:

1. A person can start and end a voice conversation with the pet through a clear
   pet-owned control.
2. The pet can reliably use enabled companion capabilities in natural-language
   conversations, beginning with core Focus Buddy and Quick Reminders skills,
   then expanding through plugins such as calendar scheduling.
3. The same capability system powers text chat as well as voice.
4. Voice conversations start from both the pet control and a keyboard shortcut,
   and show live transcription.
5. The pet visibly communicates listening, processing, action success, action
   failure, and requests for missing information in voice and chat. Unavailable,
   rejected, and indeterminate outcomes are not called missing information
   unless the canonical outcome explicitly marks that condition; cancellation is
   not failure.
6. New plugins can add assistant capabilities through the defined plugin
   contract rather than changes to a central list of supported spoken phrases.

## Delivery tracker

The [v4 epic](https://github.com/alvinunreal/openpets/issues/142) is the
implementation tracker. It turns this product direction into independently
verifiable delivery work:

- [#137](https://github.com/alvinunreal/openpets/issues/137) — plugin assistant
  capability SDK/runtime (complete).
- [#138](https://github.com/alvinunreal/openpets/issues/138) — provider-neutral
  Pet Assistant conversation and tool loop (complete; no user surface yet).
- [#143](https://github.com/alvinunreal/openpets/issues/143) and
  [#144](https://github.com/alvinunreal/openpets/issues/144) — Focus Buddy and
  Quick Reminders assistant capabilities (complete).
- [#145](https://github.com/alvinunreal/openpets/issues/145) — independent text,
  speech-to-text, and text-to-speech provider profiles.
- [#146](https://github.com/alvinunreal/openpets/issues/146) — editable pet
  personality and layered prompt composition.
- [#147](https://github.com/alvinunreal/openpets/issues/147) — composable
  speech-to-text → Pet Assistant → text-to-speech conversations.
- [#139](https://github.com/alvinunreal/openpets/issues/139) — optional OpenAI
  Realtime adapter for the same assistant contract.
- [#148](https://github.com/alvinunreal/openpets/issues/148) — shared
  chat/transcript UI (current-session projection delivered).
- [#149](https://github.com/alvinunreal/openpets/issues/149) — recent-history
  management.
- [#150](https://github.com/alvinunreal/openpets/issues/150) — pet Talk controls,
  shortcut lifecycle, and voice projection hookup.

With #137, #138, #143, #144, and the current host/UI work complete, remaining
v4 work includes provider adapters and retained history. OpenAI Realtime is an
optimized optional adapter, not the provider-neutral basis for voice.

## Two-developer GitHub workflow

The [v4 epic](https://github.com/alvinunreal/openpets/issues/142) is the shared
coordination point for v4 work.

1. Before coding, claim one unclaimed child issue: comment on the epic with the
   issue number and intended scope, assign the child issue to yourself, and ask
   for a handoff if another developer has already claimed it.
2. Work on a branch named for that issue. Keep the PR focused, link it to the
   child issue, run the relevant checks and review, then commit and push it.
3. Merge only after the PR is ready. The PR closes its child issue; then comment
   on the epic with the merged PR link, delivered behavior, and validation.
4. Update the epic checklist and this delivery tracker only for merged work.
   Claim the next issue through the epic before starting it.

## Decisions made for v4

- Exactly three provider roles are selected independently: one text/reasoning
  profile, one speech-to-text profile, and one text-to-speech profile, allowing
  local and remote combinations.
- Pet personality is owner-editable, but only affects communication style; it
  cannot bypass host rules, permissions, or authoritative capability outcomes.
- Focus and Reminder actions execute without a confirmation step in v4.
- Calendar, wake words, long-term semantic memory, unrestricted machine access,
  and a universal confirmation framework are outside v4.

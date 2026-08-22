---
description: Product direction and delivery goal for OpenPets v4: a conversational pet that can use enabled companion capabilities.
---

# OpenPets v4 — Pet Assistant

## Delivery goal

OpenPets v4 makes the desktop pet a personal assistant, not only a visual
reactor to coding-agent activity. A person can talk to or chat with the pet in
normal language; the pet understands requests, uses the capabilities of enabled
companion plugins, performs the requested work, and responds with the result in
the same conversation.

This is a v4 delivery commitment. It is not a speculative post-v4 direction.

## The product experience

Voice is the first conversation surface:

1. The person clicks the pet's Talk control or uses its keyboard shortcut.
2. The pet visibly enters a listening state and OpenPets shows its microphone
   indicator.
3. The person speaks naturally: “Set a focus timer for 25 minutes,” “Remind me
   tomorrow at 9,” or “What focus session is running?”
4. The pet understands the request, invokes an available capability, reflects
   its state while working, and answers plainly: “Focus started for 25 minutes.”
5. The person can continue the conversation, interrupt the pet, mute it, or end
   the session explicitly.

Chat is another v4 conversation surface, not a separate assistant product. It
uses the same conversation, capabilities, execution results, and pet behavior;
it only changes the input and output modality.

Voice conversations include live transcription, so spoken requests and the
pet's responses are available in the conversation UI as text. The persistence
policy is bounded, recent local history that the owner can inspect and delete;
v4 does not infer or retain long-term semantic memory.

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
  integration, microphone state, capability discovery, execution routing, and
  user-facing conversation feedback.
- A **plugin** owns its bounded domain operations and declares the capabilities
  it chooses to make available to the Pet Assistant.
- The AI may request a declared capability; it must not receive unrestricted
  plugin APIs, filesystem access, shell access, or arbitrary command execution.
- A capability result is authoritative. The pet must not claim an action
  succeeded when the responsible plugin reports failure or needs more input.
- Realtime voice transport is infrastructure, not the product by itself. The
  product is a pet that can converse and act.

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
   failure, and requests for missing information in voice and chat.
6. New plugins can add assistant capabilities through the defined plugin
   contract rather than changes to a central list of supported spoken phrases.

## Delivery tracker

The [v4 epic](https://github.com/alvinunreal/openpets/issues/142) is the
implementation tracker. It turns this product direction into independently
verifiable delivery work:

- [#137](https://github.com/alvinunreal/openpets/issues/137) — plugin assistant
  capability SDK/runtime (complete).
- [#138](https://github.com/alvinunreal/openpets/issues/138) — provider-neutral
  Pet Assistant conversation and tool loop.
- [#143](https://github.com/alvinunreal/openpets/issues/143) and
  [#144](https://github.com/alvinunreal/openpets/issues/144) — Focus Buddy and
  Quick Reminders assistant capabilities.
- [#145](https://github.com/alvinunreal/openpets/issues/145) — independent text,
  speech-to-text, and text-to-speech provider profiles.
- [#146](https://github.com/alvinunreal/openpets/issues/146) — editable pet
  personality and layered prompt composition.
- [#147](https://github.com/alvinunreal/openpets/issues/147) — composable
  speech-to-text → Pet Assistant → text-to-speech conversations.
- [#139](https://github.com/alvinunreal/openpets/issues/139) — optional OpenAI
  Realtime adapter for the same assistant contract.
- [#148](https://github.com/alvinunreal/openpets/issues/148),
  [#149](https://github.com/alvinunreal/openpets/issues/149), and
  [#150](https://github.com/alvinunreal/openpets/issues/150) — shared
  chat/transcript UI, recent-history management, and pet Talk controls.

The initial implementation order is #138 alongside #143 and #144; then #145
and #146; then the voice adapters and chat UI; finally history management and
the pet-owned Talk controls. OpenAI Realtime is an optimized optional adapter,
not the provider-neutral basis for voice.

## Decisions made for v4

- Text/reasoning, speech-to-text, and text-to-speech providers are selected
  independently, allowing local and remote combinations.
- Pet personality is owner-editable, but only affects communication style; it
  cannot bypass host rules, permissions, or authoritative capability outcomes.
- Focus and Reminder actions execute without a confirmation step in v4.
- Calendar, wake words, long-term semantic memory, unrestricted machine access,
  and a universal confirmation framework are outside v4.

# pi-esc-send-queued

Press Esc while the model is streaming and pi aborts the run, then dumps the
whole follow-up queue back into the editor. Nothing runs until you press Enter.

This sends the **first** queued message to the model as soon as the interrupt
settles and leaves the rest in the editor for review.

```
model: streaming...
> queue: "actually, run the tests instead"   (ctrl+q / alt+enter)
> queue: "and report failures"
<Esc>
→ model: runs the tests
  editor still holds: "and report failures"
```

## Install

```sh
gh repo clone hakergeniusz/pi-esc-send-queued
ln -s ~/projects/pi-esc-send-queued ~/.pi/agent/extensions/pi-esc-send-queued
```

Or add to `packages` in `~/.pi/agent/settings.json`:

```json
"packages": ["git:github.com/hakergeniusz/pi-esc-send-queued"]
```

## How it works

The extension API exposes `hasPendingMessages()` but not the queued text, so
this mirrors it:

1. The `input` event fires for every follow-up submission with
   `streamingBehavior: "followUp"`. Those texts are recorded in queue order.
   Nothing is swallowed — pi keeps owning the queue and the transcript.
2. `onTerminalInput` sees the raw Esc **before** the editor handles it, so the
   editor snapshot still holds only the user's unsent text and pi's queue is
   intact.
3. On `agent_end` with `stopReason: "aborted"`, the queue is checked. If Esc
   caused the interrupt, delivery is deferred to `agent_settled`, where the
   session is idle and pi queues the prompt safely.
4. The head of the mirror goes out via `sendUserMessage`, and the editor is
   rewritten with the remaining queued texts in front of what the user had
   typed — exactly what pi's own Esc handler left, minus the message now
   running.

### Not sent twice

A queued message pi already delivered during that run is in the transcript.
Before sending, mirrored entries matching the newest user message entry are
dropped, so an interrupted run cannot resend a message the model already saw.

## Commands

- `/sendqueued` — send the first queued message without interrupting. While
  streaming it is delivered as a steer; while idle it starts a new run.

## Switches

- `ESC_SEND_QUEUED=off` — disable entirely, restoring stock Esc behavior. Handy
  for A/B comparison.

## Failure mode

Fail-open. If the transcript cannot be read, the editor cannot be restored, or
nothing was queued, nothing is sent and the queue stays in the editor where pi
put it.

## Tests

```sh
bun install
bun test.ts      # fake ExtensionAPI, no network, no pi, no provider
bunx tsc --noEmit
```
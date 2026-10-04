// pi-esc-send-queued: Esc while the model streams aborts the run and hands the
// queued follow-up messages back to the editor. This sends the first one
// straight to the model once the abort settles and leaves the rest in the
// editor for review, so "stop, then say this instead" stays one keypress.
//
// How it sees the queue: the extension API exposes hasPendingMessages() but not
// the queued text. The `input` event fires for every follow-up submission with
// streamingBehavior "followUp", so this mirrors those texts. It never swallows
// them — pi keeps owning the queue and the transcript. On Esc, pi's own handler
// moves the queue into the editor and aborts; this then rewrites that editor
// text without the message it just sent, so the text is never in two places.
//
// Drift guard: a queued message pi delivered before the Esc is already in the
// transcript. Mirrored entries matching the newest user message entry are
// dropped before sending, so nothing is sent twice.
//
// Fail-open: on any surprise nothing is sent and the queue stays in the editor.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** An Esc seen this recently still counts as the interrupt that ended the run. */
const ESC_GRACE_MS = 10_000;

type ImagePart = { type: "image"; [key: string]: unknown };
type UserContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

interface Queued {
	text: string;
	images?: ImagePart[];
}

interface Mirrored {
	/** Follow-up texts queued during the current run, in queue order. */
	queue: Queued[];
	/** Epoch ms of the last Esc seen while streaming, or null. */
	escAt: number | null;
	/** Editor contents at Esc time: the user's unsent text, queue not yet merged. */
	editorAtEsc: string;
	/** Whether pi reported pending messages when Esc arrived. */
	hadQueueAtEsc: boolean;
	/** Set once an interrupt qualifies and the send is waiting for the settle. */
	deliveryPending: boolean;
}

const state: Mirrored = { queue: [], escAt: null, editorAtEsc: "", hadQueueAtEsc: false, deliveryPending: false };

// The TUI input listener has no context of its own; every event handler
// refreshes this, and Esc only matters while a run is active.
let currentCtx: ExtensionContext | undefined;
let unsubscribeInput: (() => void) | undefined;

function resetRun(): void {
	state.queue = [];
	state.escAt = null;
	state.editorAtEsc = "";
	state.hadQueueAtEsc = false;
	state.deliveryPending = false;
}

/** True when the run ended in an interrupt rather than a finished answer. */
function endedAborted(event: { messages?: unknown[] }): boolean {
	const messages = event.messages;
	if (!Array.isArray(messages)) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string };
		if (m?.role !== "assistant") continue;
		return m.stopReason === "aborted";
	}
	return false;
}

/** Text of the newest user message already in the transcript, or null. */
function lastDeliveredUserText(ctx: ExtensionContext): string | null {
	try {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const content = entry.message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((b) => (b as { type?: string })?.type === "text")
					.map((b) => (b as { text: string }).text)
					.join("\n");
			}
			return null;
		}
	} catch {
		// transcript unreadable — keep the mirror as is
	}
	return null;
}

/** Drop mirrored messages pi already delivered during this run. */
function dropDelivered(ctx: ExtensionContext): void {
	for (;;) {
		const head = state.queue[0];
		if (!head || head.images?.length) return;
		const delivered = lastDeliveredUserText(ctx);
		if (delivered === null || delivered !== head.text) return;
		state.queue.shift();
	}
}

function content(q: Queued): UserContent {
	if (!q.images?.length) return q.text;
	return [{ type: "text", text: q.text }, ...q.images] as UserContent;
}

/**
 * Send the head of the mirrored queue and put the rest back in the editor.
 * Returns the sent text, or null when there was nothing to send.
 */
function sendFirst(ctx: ExtensionContext, pi: ExtensionAPI): string | null {
	if (state.queue.length === 0) return null;
	const [first, ...rest] = state.queue;
	// pi merged the whole queue in front of the typed text on Esc. Put it back
	// without the message that is now on its way to the model.
	const editor = [...rest.map((q) => q.text), state.editorAtEsc].filter((t) => t.trim().length > 0).join("\n\n");
	state.editorAtEsc = "";
	try {
		ctx.ui.setEditorText(editor);
	} catch {
		// no editor to restore (non-TUI); the send below still runs
	}
	pi.sendUserMessage(content(first));
	return first.text;
}

export default function (pi: ExtensionAPI) {
	// ESC_SEND_QUEUED=off: A/B switch — Esc keeps pi's stock behavior.
	if (process.env.ESC_SEND_QUEUED === "off") return;

	pi.registerCommand("sendqueued", {
		description: "Send the first queued message now (Esc without interrupting)",
		handler: async (_args, ctx) => {
			dropDelivered(ctx);
			if (state.queue.length === 0) {
				ctx.ui.notify("No queued messages", "info");
				return;
			}
			if (ctx.isIdle()) {
				sendFirst(ctx, pi);
				return;
			}
			// Still streaming: steer it in, which is what an Esc + send amounts to.
			const [first, ...rest] = state.queue;
			state.queue = rest;
			pi.sendUserMessage(content(first), { deliverAs: "steer" });
		},
	});

	// Mirror every follow-up submission so the queued text is known later.
	pi.on("input", (event) => {
		if (event.streamingBehavior !== "followUp") return;
		state.queue.push({ text: event.text, images: event.images as ImagePart[] | undefined });
	});

	// Raw terminal input fires before the editor handles the key, so this sees
	// Esc while pi's queue is still intact and the editor holds only what the
	// user typed. pi rebinds these listeners across /reload.
	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		resetRun();
		if (ctx.mode !== "tui" || typeof ctx.ui?.onTerminalInput !== "function") return;
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x1b") return undefined;
			if (!currentCtx || currentCtx.isIdle()) return undefined;
			state.escAt = Date.now();
			state.editorAtEsc = currentCtx.ui.getEditorText();
			state.hadQueueAtEsc = currentCtx.hasPendingMessages();
			return undefined;
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		currentCtx = ctx;
		resetRun();
	});

	pi.on("agent_end", (event, ctx) => {
		currentCtx = ctx;
		if (!endedAborted(event)) {
			// A finished run drains pi's queue on its own; the mirror is stale.
			state.queue = [];
			state.escAt = null;
			return;
		}
		const fresh = state.escAt !== null && Date.now() - state.escAt < ESC_GRACE_MS;
		if (!fresh || !state.hadQueueAtEsc) {
			state.escAt = null;
			return;
		}
		dropDelivered(ctx);
		if (state.queue.length === 0) {
			state.escAt = null;
			return;
		}
		state.deliveryPending = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.deliveryPending) return;
		state.deliveryPending = false;
		state.escAt = null;
		state.hadQueueAtEsc = false;
		const sent = sendFirst(ctx, pi);
		if (sent) ctx.ui.notify(`Sent queued message: ${sent.slice(0, 80)}`, "info");
	});
}
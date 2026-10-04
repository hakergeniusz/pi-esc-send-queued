/**
 * Smoke test: drives index.ts against a fake ExtensionAPI. No network, no real
 * pi, no provider. `bun test.ts`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const activate = (await import("./index.ts")).default as (pi: ExtensionAPI) => void;

type Handler = (event: never, ctx: never) => unknown;

interface Fake {
	pi: ExtensionAPI;
	handlers: Record<string, Handler[]>;
	terminal: ((data: string) => unknown)[];
	commands: Record<string, (args: string, ctx: unknown) => unknown>;
	sent: { content: unknown; deliverAs?: string }[];
	notifications: string[];
	editor: string[];
}

function fakePi(): Fake {
	const handlers: Record<string, Handler[]> = {};
	const terminal: ((data: string) => unknown)[] = [];
	const fake: Fake = {
		handlers,
		terminal,
		commands: {},
		sent: [],
		notifications: [],
		editor: [],
		pi: {
			on(event: string, handler: Handler) {
				(handlers[event] ??= []).push(handler);
				return () => {};
			},
			registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
				fake.commands[name] = options.handler;
			},
			sendUserMessage(content: unknown, options?: { deliverAs?: string }) {
				fake.sent.push({ content, deliverAs: options?.deliverAs });
			},
			ui: {},
		} as unknown as ExtensionAPI,
	};
	return fake;
}

interface CtxOpts {
	idle?: boolean;
	pending?: boolean;
	entries?: unknown[];
}

function fakeCtx(fake: Fake, opts: CtxOpts = {}): ExtensionContext {
	let idle = opts.idle ?? true;
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		hasPendingMessages: () => opts.pending ?? false,
		ui: {
			getEditorText: () => fake.editor[fake.editor.length - 1] ?? "",
			setEditorText: (text: string) => {
				fake.editor.push(text);
			},
			notify: (message: string) => {
				fake.notifications.push(message);
			},
			onTerminalInput: (handler: (data: string) => unknown) => {
				fake.terminal.push(handler);
				return () => {};
			},
		},
		sessionManager: { getEntries: () => opts.entries ?? [] },
	} as unknown as ExtensionContext;
	return ctx;
}

function emit(fake: Fake, event: string, payload: unknown, ctx: ExtensionContext): void {
	for (const h of fake.handlers[event] ?? []) (h as (e: unknown, c: unknown) => unknown)(payload, ctx);
}

function userEntry(text: string): unknown {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	if (cond) {
		console.log(`  ok  ${name}`);
		return;
	}
	failures++;
	console.log(`FAIL  ${name}`, detail ?? "");
}

const ESC = "\x1b";

async function scenarioEscSendsFirst() {
	console.log("Esc interrupts and sends the first queued message");
	const fake = fakePi();
	activate(fake.pi);

	const idleCtx = fakeCtx(fake, { idle: false, pending: true });
	emit(fake, "session_start", {}, idleCtx);
	emit(fake, "agent_start", {}, idleCtx);

	// User queues two follow-ups while the model streams.
	fake.editor.push("");
	emit(fake, "input", { type: "input", text: "first queued", source: "interactive", streamingBehavior: "followUp" }, idleCtx);
	emit(fake, "input", { type: "input", text: "second queued", source: "interactive", streamingBehavior: "followUp" }, idleCtx);

	// Esc: raw input first, then pi restores the queue into the editor and aborts.
	fake.editor.push("typed by hand");
	fake.terminal[0](ESC);
	check("Esc is not consumed", fake.terminal[0](ESC) === undefined);
	fake.editor.push("first queued\n\nsecond queued\n\ntyped by hand");

	// The run ends in an interrupt.
	emit(fake, "agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, idleCtx);
	check("nothing sent before the run settles", fake.sent.length === 0);

	const settled = fakeCtx(fake, { idle: true, pending: false });
	emit(fake, "agent_settled", { type: "agent_settled" }, settled);
	check("first queued message sent", fake.sent.length === 1 && fake.sent[0].content === "first queued", fake.sent);
	check("rest left in the editor", fake.editor[fake.editor.length - 1] === "second queued\n\ntyped by hand", fake.editor);
	check("user is told what went out", fake.notifications.length === 1, fake.notifications);
}

async function scenarioNoQueue() {
	console.log("Esc with nothing queued leaves pi's behavior alone");
	const fake = fakePi();
	activate(fake.pi);

	const ctx = fakeCtx(fake, { idle: false, pending: false });
	emit(fake, "session_start", {}, ctx);
	emit(fake, "agent_start", {}, ctx);
	fake.editor.push("");
	fake.terminal[0](ESC);
	emit(fake, "agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
	emit(fake, "agent_settled", { type: "agent_settled" }, fakeCtx(fake));

	check("nothing sent", fake.sent.length === 0);
	check("editor untouched", fake.editor.length === 1);
}

async function scenarioDeliveredMessageNotResent() {
	console.log("A message pi already delivered is not sent twice");
	const fake = fakePi();
	activate(fake.pi);

	const ctx = fakeCtx(fake, { idle: false, pending: true, entries: [userEntry("already delivered")] });
	emit(fake, "session_start", {}, ctx);
	emit(fake, "agent_start", {}, ctx);

	emit(fake, "input", { type: "input", text: "already delivered", source: "interactive", streamingBehavior: "followUp" }, ctx);
	emit(fake, "input", { type: "input", text: "still waiting", source: "interactive", streamingBehavior: "followUp" }, ctx);

	fake.editor.push("");
	fake.terminal[0](ESC);
	fake.editor.push("already delivered\n\nstill waiting");

	emit(fake, "agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
	emit(fake, "agent_settled", { type: "agent_settled" }, fakeCtx(fake));

	check("only the undelivered message is sent", fake.sent.length === 1 && fake.sent[0].content === "still waiting", fake.sent);
}

async function scenarioFinishedRunDoesNotSend() {
	console.log("A run that finished on its own sends nothing");
	const fake = fakePi();
	activate(fake.pi);

	const ctx = fakeCtx(fake, { idle: false, pending: true });
	emit(fake, "session_start", {}, ctx);
	emit(fake, "agent_start", {}, ctx);
	emit(fake, "input", { type: "input", text: "queued", source: "interactive", streamingBehavior: "followUp" }, ctx);
	fake.editor.push("");
	fake.terminal[0](ESC);
	emit(fake, "agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	emit(fake, "agent_settled", { type: "agent_settled" }, fakeCtx(fake));

	check("nothing sent", fake.sent.length === 0);
}

async function scenarioCommandSteers() {
	console.log("/sendqueued steers while streaming");
	const fake = fakePi();
	activate(fake.pi);

	const ctx = fakeCtx(fake, { idle: false, pending: true });
	emit(fake, "session_start", {}, ctx);
	emit(fake, "agent_start", {}, ctx);
	emit(fake, "input", { type: "input", text: "queued now", source: "interactive", streamingBehavior: "followUp" }, ctx);

	fake.commands.sendqueued("", ctx);
	check("sent as a steer", fake.sent.length === 1 && fake.sent[0].deliverAs === "steer", fake.sent);
}

await scenarioEscSendsFirst();
await scenarioNoQueue();
await scenarioDeliveredMessageNotResent();
await scenarioFinishedRunDoesNotSend();
await scenarioCommandSteers();

console.log(failures === 0 ? "\nall scenarios passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
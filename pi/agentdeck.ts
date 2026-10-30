/**
 * Connects this pi to Agentdeck, which polls ~/.cache/agentdeck/pi/<pid>.json while the session is open:
 * - status: idle, busy, or waiting on a dialog (any extension's select/confirm/input/editor), and the session's spend.
 *   Pi closes its session file between writes and several pi can share a folder, so nothing outside the process can
 *   tell which session file belongs to which pid.
 * - inbox: `ag send` drops <pid>.inbox; it becomes a user message (queued as a follow-up while pi works), so a reply
 *   never goes through the terminal and never touches a draft in the editor. `ag rename` uses it to name the session.
 *   The outcome goes to <pid>.result.
 * - ask_user: a tool for the model to ask you a question with options. The session shows as blocked on it, the deck
 *   shows its options, and a reply from the deck answers it (closing the dialog in the terminal).
 * install.sh links this into ~/.pi/agent/extensions/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const folder = join(homedir(), ".cache", "agentdeck", "pi");
const statusFile = join(folder, `${process.pid}.json`);
const inbox = join(folder, `${process.pid}.inbox`);
const startedAt = Date.now();
const wrapped = Symbol.for("agentdeck.dialogs");
// The UI object outlives a /reload, but this module's closures do not: wrappers call whichever instance is current.
const hooks = globalThis as { agentdeckDialog?: (title: string, open: boolean) => void };

function atomically(path: string, data: unknown) {
	writeFileSync(`${path}.tmp`, JSON.stringify(data));
	renameSync(`${path}.tmp`, path); // a reader polling every 2 s must never see half a file
}

export default function (pi: ExtensionAPI) {
	let status: "idle" | "busy" = "idle";
	let statusUpdatedAt = Date.now();
	const dialogs: string[] = []; // titles of dialogs open right now, newest last
	let cost = 0;
	let poll: ReturnType<typeof setInterval> | undefined;
	let question: { prompt: string; options: { label: string; description?: string }[]; answer: (text: string) => void } | undefined;

	function write(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return; // print/json/rpc runs have no terminal to show or reply to
		try {
			mkdirSync(folder, { recursive: true });
			atomically(statusFile, {
				pid: process.pid,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? "",
				cwd: ctx.cwd,
				name: pi.getSessionName() ?? "",
				status: dialogs.length || question ? "waiting" : status,
				waitingFor: question?.prompt ?? dialogs.at(-1) ?? "",
				question: question ? { prompt: question.prompt, options: question.options } : null,
				statusUpdatedAt,
				startedAt,
				cost,
			});
		} catch {
			// A status file is a convenience; never let it break the session.
		}
	}

	function become(next: "idle" | "busy", ctx: ExtensionContext) {
		if (next !== status) statusUpdatedAt = Date.now();
		status = next;
		write(ctx);
	}

	function tally(ctx: ExtensionContext) {
		cost = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message") cost += (entry.message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0;
		}
	}

	function watchDialogs(ctx: ExtensionContext) {
		const ui = ctx.ui as unknown as Record<string | symbol, unknown>;
		if (ui[wrapped]) return;
		ui[wrapped] = true;
		for (const method of ["select", "confirm", "input", "editor"]) {
			const original = ui[method] as (...args: unknown[]) => Promise<unknown>;
			ui[method] = async (...args: unknown[]) => {
				const title = typeof args[0] === "string" ? args[0] : "a question";
				hooks.agentdeckDialog?.(title, true);
				try {
					return await original.apply(ui, args);
				} finally {
					hooks.agentdeckDialog?.(title, false);
				}
			};
		}
	}

	function answer(result: { ok: boolean; why?: string }) {
		atomically(join(folder, `${process.pid}.result`), result);
	}

	function deliver(ctx: ExtensionContext) {
		const taken = `${inbox}.taken`;
		try {
			renameSync(inbox, taken); // claims it: `ag send` gives up on a reply only if it can still delete the inbox
		} catch {
			return;
		}
		try {
			const request = JSON.parse(readFileSync(taken, "utf8")) as { text: string; submit: boolean; sid?: string; rename?: string; question?: string };
			const { text, submit, sid, rename } = request;
			if (sid && sid !== ctx.sessionManager.getSessionId()) return answer({ ok: false, why: "that is a different session now; nothing was sent" });
			if (rename) {
				pi.setSessionName(rename); // autoname treats it like a /name of yours and keeps it
				return answer({ ok: true });
			}
			// the question the reply was written for, "" for none: never answer a different one than the sender saw
			if ((request.question ?? "") !== (question?.prompt ?? "")) {
				return answer({ ok: false, why: question ? "it has asked you a question since; answer that instead" : "that question is no longer open; nothing was sent" });
			}
			if (question) {
				if (!submit) return answer({ ok: false, why: "it is asking you a question; send your answer instead" });
				question.answer(text);
				return answer({ ok: true });
			}
			if (dialogs.length) return answer({ ok: false, why: "it is waiting on a dialog; drop in and answer it there" });
			if (!submit) ctx.ui.pasteToEditor(text);
			else if (ctx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
			answer({ ok: true });
		} catch (error) {
			answer({ ok: false, why: `pi could not take it: ${error instanceof Error ? error.message : error}` });
		} finally {
			rmSync(taken, { force: true });
		}
	}

	pi.registerTool({
		name: "ask_user",
		label: "Question",
		description:
			"Ask the user a question you need answered to continue, with 2-4 options to pick from; they can also answer in their own words. Waits for the answer.",
		promptSnippet: "Ask the user a multiple-choice question and wait for the answer",
		promptGuidelines: [
			"Use ask_user when you need the user's decision to continue, instead of asking in your reply and ending your turn: ask_user shows the session as waiting on them, and they can answer it from Agentdeck without opening the terminal.",
			"Use ask_user for one real decision at a time, with concrete options and your recommendation first; do not use ask_user for status updates, or to ask permission for what you were already asked to do.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question, with enough context to answer it without scrolling back" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "A short answer, a few words" }),
					description: Type.Optional(Type.String({ description: "What picking it means, or its tradeoff, in one sentence" })),
				}),
				{ minItems: 2, maxItems: 4 },
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("ask_user needs the interactive terminal; ask in your reply instead");
			if (question) throw new Error("another ask_user question is still open; ask one at a time");
			const fromDeck = new AbortController();
			const dismiss = signal ? AbortSignal.any([signal, fromDeck.signal]) : fromDeck.signal;
			let deckAnswer: string | undefined;
			const details = { question: params.question, options: params.options.map((option) => option.label), answer: null as string | null };
			const answered = (text: string) => {
				const picked = details.options.includes(text);
				details.answer = text;
				return { content: [{ type: "text" as const, text: picked ? `The user picked: ${text}` : `The user answered: ${text}` }], details };
			};
			question = {
				prompt: params.question,
				options: params.options,
				answer: (text) => {
					deckAnswer = text;
					fromDeck.abort(); // closes whichever dialog is open in the terminal
				},
			};
			statusUpdatedAt = Date.now();
			write(ctx);
			try {
				const shown = params.options.map((option) => (option.description ? `${option.label}: ${option.description}` : option.label));
				const other = "Something else (type it)";
				for (;;) {
					const picked = await ctx.ui.select(params.question, [...shown, other], { signal: dismiss });
					if (deckAnswer !== undefined || picked === undefined) break;
					if (picked !== other) return answered(params.options[shown.indexOf(picked)].label);
					const typed = (await ctx.ui.input(params.question, "Your answer (Esc goes back to the options)", { signal: dismiss }))?.trim();
					if (deckAnswer !== undefined) break;
					if (typed) return answered(typed);
				}
				if (deckAnswer !== undefined) return answered(deckAnswer);
				// Esc on the options: end the turn so the user can say what they want instead
				return {
					content: [{ type: "text", text: "The user dismissed the question without answering. Stop and wait for their next message." }],
					details,
					terminate: true,
				};
			} finally {
				question = undefined;
				write(ctx);
			}
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", String(args.question ?? "")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { answer: string | null } | undefined;
			const first = result.content[0];
			if (!details) return new Text(first?.type === "text" ? first.text : "", 0, 0); // an error
			return new Text(details.answer ? theme.fg("success", "✓ ") + theme.fg("accent", details.answer) : theme.fg("warning", "Dismissed"), 0, 0);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// print/json/rpc runs (e.g. `pi -p`) have nobody to ask
		if (ctx.mode !== "tui") return pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user"));
		watchDialogs(ctx);
		hooks.agentdeckDialog = (title, open) => {
			if (open) dialogs.push(title);
			else dialogs.splice(dialogs.lastIndexOf(title), 1);
			// each new dialog is a new hand-back, so marking one as seen never hides the next; a question's own dialogs are one
			if (!question) statusUpdatedAt = Date.now();
			write(ctx);
		};
		tally(ctx);
		become("idle", ctx);
		rmSync(inbox, { force: true }); // left by a pi that died before reading it
		poll = setInterval(() => existsSync(inbox) && deliver(ctx), 250);
		poll.unref();
	});
	pi.on("session_info_changed", (_event, ctx) => write(ctx));
	pi.on("agent_start", (_event, ctx) => become("busy", ctx));
	pi.on("turn_end", (_event, ctx) => {
		tally(ctx);
		write(ctx);
	});
	// agent_end can still be followed by a retry, a compaction or a queued follow-up; settled means it is your turn.
	pi.on("agent_settled", (_event, ctx) => become("idle", ctx));
	pi.on("session_shutdown", (event) => {
		clearInterval(poll);
		hooks.agentdeckDialog = undefined;
		if (event.reason === "quit") rmSync(statusFile, { force: true }); // otherwise session_start rewrites it at once
	});
}

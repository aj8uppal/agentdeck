/**
 * Connects this pi to Agentdeck, and gives the model a way to put decisions to you that you can see and talk through.
 * Agentdeck polls ~/.cache/agentdeck/pi/<pid>.json while the session is open:
 * - status: idle, busy, or waiting on you (an open question, or any extension's select/confirm/input/editor), and the
 *   session's spend. Pi closes its session file between writes and several pi can share a folder, so nothing outside
 *   the process can tell which session file belongs to which pid.
 * - inbox: `ag send` drops <pid>.inbox; it becomes a user message (queued as a follow-up while pi works), so a reply
 *   never goes through the terminal and never touches a draft in the editor. `ag rename` uses it to name the session.
 *   The outcome goes to <pid>.result.
 * - ask_user: the model explains a decision in its reply, then asks it with options and ends its turn. Nothing blocks:
 *   you reply in the editor (a bare number picks that option) or with the deck's buttons, or ask why or push back first.
 *   While it is open the session shows as waiting on you, with the options in the deck.
 * - brief: what the task is for, what you decided, what the model is assuming, what is still open and what is parked.
 *   The model keeps it with the `brief` tool. It shows above the editor (all of it with /brief), and goes to the model
 *   before every call, so it survives compaction.
 * install.sh links this into ~/.pi/agent/extensions/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const folder = join(homedir(), ".cache", "agentdeck", "pi");
const statusFile = join(folder, `${process.pid}.json`);
const inbox = join(folder, `${process.pid}.inbox`);
const startedAt = Date.now();
const wrapped = Symbol.for("agentdeck.dialogs");
// The UI object outlives a /reload, but this module's closures do not: wrappers call whichever instance is current.
const hooks = globalThis as { agentdeckDialog?: (title: string, open: boolean) => void };

type Question = { prompt: string; options: { label: string; description?: string }[] };
const kinds = ["decided", "assumed", "open", "parked"] as const;
type Kind = (typeof kinds)[number];
// at: when the model last changed it, so it can tell whether you have replied since
type Item = { kind: Kind; text: string; why?: string; recommend?: string; at: number };
type Brief = { goal: string; goalConfirmed: boolean; goalAt: number; items: Item[] };
const headings: Record<Kind, string> = { decided: "Decided", assumed: "Assuming", open: "Open", parked: "Parked" };
const whyLabels: Record<Kind, string> = { decided: "why", assumed: "based on", open: "why it matters", parked: "why it waits" };
const itemText = Type.String({ description: "The item's current text, or a part of it that no other item contains" });
const briefChange = Type.Object({
	goal: Type.Optional(Type.String({ description: "What the task is for and what is in scope, in the user's words. Changing it marks it unconfirmed" })),
	goalConfirmed: Type.Optional(Type.Boolean({ description: "true once the user has agreed to the goal" })),
	add: Type.Optional(
		Type.Array(
			Type.Object({
				kind: StringEnum(kinds),
				text: Type.String({ description: "The item in plain words, one line" }),
				why: Type.Optional(Type.String({ description: "decided: why; assumed: what it rests on; open: why it matters now; parked: why it waits" })),
				recommend: Type.Optional(Type.String({ description: "open only: the option you recommend" })),
			}),
		),
	),
	update: Type.Optional(
		Type.Array(
			Type.Object({
				item: itemText,
				kind: Type.Optional(StringEnum(kinds)),
				text: Type.Optional(Type.String()),
				why: Type.Optional(Type.String()),
				recommend: Type.Optional(Type.String()),
			}),
		),
	),
	remove: Type.Optional(Type.Array(itemText)),
});

function atomically(path: string, data: unknown) {
	writeFileSync(`${path}.tmp`, JSON.stringify(data));
	renameSync(`${path}.tmp`, path); // a reader polling every 2 s must never see half a file
}

function emptyBrief(): Brief {
	return { goal: "", goalConfirmed: false, goalAt: 0, items: [] };
}

function briefMarkdown(brief: Brief) {
	const lines = [`**Goal**${brief.goal && !brief.goalConfirmed ? " (not confirmed yet)" : ""}: ${brief.goal || "not set"}`];
	for (const kind of kinds) {
		const items = brief.items.filter((item) => item.kind === kind);
		if (!items.length) continue;
		lines.push("", `**${headings[kind]}**`);
		for (const item of items) {
			lines.push(`- ${item.text}`);
			if (item.why) lines.push(`  - ${whyLabels[kind]}: ${item.why}`);
			if (item.recommend) lines.push(`  - recommended: ${item.recommend}`);
		}
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	let status: "idle" | "busy" = "idle";
	let statusUpdatedAt = Date.now();
	const dialogs: string[] = []; // titles of dialogs open right now, newest last
	let cost = 0;
	let poll: ReturnType<typeof setInterval> | undefined;
	let question: Question | undefined; // asked, and no reply yet
	let brief = emptyBrief();

	// You see the question as soon as the turn that asked it is over.
	const asking = () => (status === "idle" ? question : undefined);

	function write(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return; // print/json/rpc runs have no terminal to show or reply to
		const open = asking();
		try {
			mkdirSync(folder, { recursive: true });
			atomically(statusFile, {
				pid: process.pid,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? "",
				cwd: ctx.cwd,
				name: pi.getSessionName() ?? "",
				status: dialogs.length || open ? "waiting" : status,
				waitingFor: open?.prompt ?? dialogs.at(-1) ?? "",
				question: open ?? null,
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

	// The brief and the open question as of the current branch, so a restart, /tree or /fork shows the right ones.
	function restore(ctx: ExtensionContext) {
		brief = emptyBrief();
		question = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role: string; toolName?: string; isError?: boolean; details?: { asked?: Question; brief?: Brief } };
			if (message.role === "user") question = undefined;
			if (message.role !== "toolResult" || message.isError) continue;
			// `asked` tells these apart from the answered results of the old, blocking ask_user
			if (message.toolName === "ask_user" && message.details?.asked) question = message.details.asked;
			if (message.toolName === "brief" && message.details?.brief) brief = message.details.brief;
		}
	}

	function lastReply(ctx: ExtensionContext) {
		let at = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") at = entry.message.timestamp;
		}
		return at;
	}

	// The batch runs in order (ask_user is sequential), so the assistant message being executed is the newest one.
	function asksInThisTurn(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			return entry.message.content.some((block) => block.type === "toolCall" && block.name === "ask_user");
		}
		return false;
	}

	function showBrief(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (!brief.goal && !brief.items.length) return ctx.ui.setWidget("brief", undefined);
		const shown = brief;
		ctx.ui.setWidget("brief", (_tui, theme) => ({
			render(width: number) {
				const counts = kinds.flatMap((kind) => {
					const n = shown.items.filter((item) => item.kind === kind).length;
					return n ? [`${n} ${kind}`] : [];
				});
				const open = shown.items.filter((item) => item.kind === "open").map((item) => item.text);
				const lines = [
					theme.fg("accent", theme.bold("Brief  ")) +
						(shown.goal || theme.fg("dim", "no goal yet")) +
						(shown.goal && !shown.goalConfirmed ? theme.fg("warning", "  (not confirmed)") : ""),
					theme.fg("muted", counts.join(" · ") || "nothing recorded yet") + theme.fg("dim", "  ·  /brief shows all of it"),
				];
				if (open.length) lines.push(theme.fg("muted", "Still open: ") + open.join(theme.fg("dim", " · ")));
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
		}));
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
			const open = asking();
			if ((request.question ?? "") !== (open?.prompt ?? "")) {
				return answer({ ok: false, why: open ? "it has asked you a question since; answer that instead" : "that question is no longer open; nothing was sent" });
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
			"Put a decision to the user, with 2-4 options; they can also answer in their own words, ask why, or push back. Explain the decision in your reply before calling it. It ends your turn: the user's next message is their reply.",
		promptSnippet: "Put a decision to the user with options; ends your turn",
		promptGuidelines: [
			"Use ask_user for a decision only the user can make, instead of asking in prose: the session then shows as waiting on them in Agentdeck, with the options as buttons. Look facts up instead of asking them, and never use ask_user for status updates or to ask permission for what you were already asked to do.",
			"Before calling ask_user, explain the decision in your reply, in plain words: what it is, why it matters now, what each option means, and which you recommend and why. Spell everything out; never lean on labels or shorthand coined earlier in the conversation.",
			"Call ask_user alone, as the last thing in your reply, with one decision and your recommendation as the first option. Your turn ends there.",
			"When the user's reply to an ask_user question is a plain pick, say in a line or two what you recorded and what it changes, then carry on (that may be the next question). When it has a question, a caveat or pushback, answer that first and put the same decision back with ask_user; ask nothing new until they have settled it.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The decision, in one plain sentence; the context goes in your reply above it" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "A short answer, a few words" }),
					description: Type.Optional(Type.String({ description: "What picking it means, or its tradeoff, in one sentence" })),
				}),
				{ minItems: 2, maxItems: 4 },
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("ask_user needs the interactive terminal; ask in your reply instead");
			question = { prompt: params.question, options: params.options };
			return {
				content: [
					{
						type: "text",
						text: "Asked. Your turn ends here: write nothing more. The user's next message is their reply: an option, their own answer, a question, or pushback.",
					},
				],
				details: { asked: question },
				terminate: true,
			};
		},

		renderCall(args, theme) {
			const options = (args.options ?? []).map(
				(option, i) => `${theme.fg("accent", ` ${i + 1}`)}  ${option?.label ?? ""}${option?.description ? theme.fg("muted", `  ${option.description}`) : ""}`,
			);
			const lines = [theme.fg("toolTitle", theme.bold("? ")) + theme.bold(args.question ?? ""), ...options, theme.fg("dim", "Reply with a number, or in your own words: ask why, push back, add a caveat.")];
			return new Text(lines.join("\n"), 0, 0);
		},
		renderResult(result) {
			const details = result.details as { asked?: Question } | undefined;
			const first = result.content[0];
			return details?.asked ? new Container() : new Text(first?.type === "text" ? first.text : "", 0, 0); // only an error has more to say
		},
	});

	// All or nothing: a change the model sees as rejected must not be half applied.
	function record(params: Static<typeof briefChange>, ctx: ExtensionContext) {
		const next = structuredClone(brief);
		const now = Date.now();
		const replied = lastReply(ctx);
		const changes: string[] = [];
		const find = (wanted: string) => {
			const needle = wanted.trim().toLowerCase();
			const exact = next.items.filter((item) => item.text.toLowerCase() === needle);
			const hits = exact.length ? exact : next.items.filter((item) => item.text.toLowerCase().includes(needle));
			if (hits.length === 1) return hits[0];
			throw new Error(`${hits.length ? "more than one item matches" : "no item matches"} "${wanted}"`);
		};

		if (params.goal !== undefined && params.goal.trim() !== next.goal) {
			Object.assign(next, { goal: params.goal.trim(), goalConfirmed: false, goalAt: now });
			changes.push(`goal: ${next.goal}`);
		}
		if (params.goalConfirmed && !next.goalConfirmed) {
			if (replied <= next.goalAt) throw new Error("the user has not replied since the goal was set; ask them to confirm it first");
			next.goalConfirmed = true;
			changes.push("goal confirmed");
		}
		for (const change of params.update ?? []) {
			const item = find(change.item);
			const was = item.kind;
			// a recommendation the user never answered is not their decision
			if (change.kind === "decided" && was !== "decided" && replied <= item.at) {
				throw new Error(`"${item.text}" can become decided only once the user has replied since you last raised it; until then it stays ${was}`);
			}
			for (const key of ["kind", "text", "why", "recommend"] as const) if (change[key] !== undefined) Object.assign(item, { [key]: change[key] });
			if (item.kind !== "open") delete item.recommend;
			item.at = now;
			const why = change.why ? ` - ${change.why}` : "";
			changes.push(was === item.kind ? `~ ${item.kind}: ${item.text}${why}` : `${was} → ${item.kind}: ${item.text}${why}`);
		}
		for (const wanted of params.remove ?? []) {
			const item = find(wanted);
			next.items.splice(next.items.indexOf(item), 1);
			changes.push(`- ${item.kind}: ${item.text}`);
		}
		for (const item of params.add ?? []) {
			next.items.push({ ...item, at: now });
			changes.push(`+ ${item.kind}: ${item.text}${item.why ? ` - ${item.why}` : ""}${item.recommend ? ` (recommended: ${item.recommend})` : ""}`);
		}
		if (!changes.length) throw new Error("nothing to change");

		brief = next;
		showBrief(ctx);
		return {
			content: [{ type: "text" as const, text: `Recorded:\n${changes.join("\n")}` }],
			details: { brief, changes },
			// otherwise a brief update next to ask_user costs one more model call, after the question
			terminate: asksInThisTurn(ctx) || undefined,
		};
	}

	pi.registerTool({
		name: "brief",
		label: "Brief",
		description:
			"Keep the brief of this task that the user sees above their editor: the goal, what is decided, what you are assuming, what is still open (with your recommendation) and what is parked. Pass only what changes.",
		promptSnippet: "Record the goal, decisions, assumptions, open questions and parked items the user sees",
		promptGuidelines: [
			"Use brief when a task needs more than one decision from the user, or rests on assumptions they should see. Before the first question: set the goal and scope in their words and add every open decision with why it matters and your recommendation (the user sees each brief change as you make it), then ask them in your reply to confirm the goal and say which recommendations they accept; take the rest one at a time.",
			"Record each answer with brief before going on. An item is decided only when the user chose it, explicitly or by accepting your recommendation; anything you take as true without asking them is assumed; deferred or out of scope is parked.",
			"Refer to brief items by what they say, never by number or position.",
		],
		parameters: briefChange,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return record(params, ctx);
			} catch (error) {
				const items = brief.items.map((item) => `- ${item.kind}: ${item.text}`).join("\n") || "(no items)";
				throw new Error(`Nothing was recorded: ${error instanceof Error ? error.message : error}. Fix it and send the whole change again. The brief is still:\n${items}`);
			}
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("brief")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { changes?: string[] } | undefined;
			const first = result.content[0];
			if (!details?.changes) return new Text(theme.fg("error", first?.type === "text" ? first.text : ""), 0, 0);
			const colour = (change: string) => (change.startsWith("+") ? "success" : change.startsWith("-") ? "error" : change.startsWith("~") ? "muted" : "accent");
			return new Text(details.changes.map((change) => theme.fg(colour(change), change)).join("\n"), 0, 0);
		},
	});

	pi.registerCommand("brief", {
		description: "Show the whole brief: goal, decided, assuming, open and parked",
		handler: async (_args, ctx) => {
			if (!brief.goal && !brief.items.length) return ctx.ui.notify("No brief in this session yet", "info");
			pi.appendEntry<Brief>("brief-view", brief); // shown in the transcript, never sent to the model
		},
	});
	pi.registerEntryRenderer<Brief>("brief-view", (entry, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Markdown(`### Brief\n\n${briefMarkdown(entry.data ?? emptyBrief())}`, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.on("input", (event, ctx) => {
		const asked = question;
		if (!asked) return;
		question = undefined; // answered, or under discussion: the model asks again if it still needs it
		write(ctx);
		const picked = event.source === "interactive" && !event.streamingBehavior && /^\s*\d\s*$/.test(event.text) ? asked.options[Number(event.text) - 1] : undefined;
		if (picked) return { action: "transform", text: picked.label };
	});

	// Before every model call, just ahead of your latest message, so it survives compaction and stays in cache within a turn.
	pi.on("context", (event) => {
		if (!brief.goal && !brief.items.length) return;
		const reminder = {
			role: "custom" as const,
			customType: "brief",
			display: false,
			timestamp: 0,
			content: `The brief for this task, as the user sees it above their editor (you keep it with the brief tool; this is not a message from the user):\n\n${briefMarkdown(brief)}`,
		};
		const messages = [...event.messages];
		const at = messages.findLastIndex((message) => message.role === "user");
		messages.splice(at < 0 ? messages.length : at, 0, reminder);
		return { messages };
	});

	pi.on("session_start", (_event, ctx) => {
		// print/json/rpc runs (e.g. `pi -p`) have nobody to ask or show a brief to
		if (ctx.mode !== "tui") return pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user" && name !== "brief"));
		watchDialogs(ctx);
		hooks.agentdeckDialog = (title, open) => {
			if (open) dialogs.push(title);
			else dialogs.splice(dialogs.lastIndexOf(title), 1);
			statusUpdatedAt = Date.now(); // each new dialog is a new hand-back, so marking one as seen never hides the next
			write(ctx);
		};
		restore(ctx);
		showBrief(ctx);
		tally(ctx);
		become("idle", ctx);
		rmSync(inbox, { force: true }); // left by a pi that died before reading it
		poll = setInterval(() => existsSync(inbox) && deliver(ctx), 250);
		poll.unref();
	});
	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
		showBrief(ctx);
		write(ctx);
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

/**
 * Connects this pi to Agentdeck, which polls ~/.cache/agentdeck/pi/<pid>.json while the session is open:
 * - status: idle, busy, or waiting on a dialog (any extension's select/confirm/input/editor), and the session's spend.
 *   Pi closes its session file between writes and several pi can share a folder, so nothing outside the process can
 *   tell which session file belongs to which pid.
 * - inbox: `ag send` drops <pid>.inbox; it becomes a user message (queued as a follow-up while pi works), so a reply
 *   never goes through the terminal and never touches a draft in the editor. `ag rename` uses it to name the session.
 *   The outcome goes to <pid>.result.
 * install.sh links this into ~/.pi/agent/extensions/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
				status: dialogs.length ? "waiting" : status,
				waitingFor: dialogs.at(-1) ?? "",
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
			const { text, submit, sid, rename } = JSON.parse(readFileSync(taken, "utf8")) as { text: string; submit: boolean; sid?: string; rename?: string };
			if (sid && sid !== ctx.sessionManager.getSessionId()) return answer({ ok: false, why: "that is a different session now; nothing was sent" });
			if (rename) {
				pi.setSessionName(rename); // autoname treats it like a /name of yours and keeps it
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

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		watchDialogs(ctx);
		hooks.agentdeckDialog = (title, open) => {
			if (open) dialogs.push(title);
			else dialogs.splice(dialogs.lastIndexOf(title), 1);
			statusUpdatedAt = Date.now(); // each new dialog is a new hand-back, so marking one as seen never hides the next
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

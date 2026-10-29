/**
 * Tells Agentdeck about this pi: writes ~/.cache/agentdeck/pi/<pid>.json while the session is open, the way
 * Claude Code keeps ~/.claude/sessions/<pid>.json. Pi closes its session file between writes and several pi can share
 * a folder, so nothing outside the process can tell which session file belongs to which pid.
 * install.sh links this into ~/.pi/agent/extensions/.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const folder = join(homedir(), ".cache", "agentdeck", "pi");
const statusFile = join(folder, `${process.pid}.json`);
const startedAt = Date.now();

export default function (pi: ExtensionAPI) {
	let status: "idle" | "busy" = "idle";
	let statusUpdatedAt = Date.now();

	function write(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return; // print/json/rpc runs have no terminal to show or reply to
		try {
			mkdirSync(folder, { recursive: true });
			writeFileSync(
				`${statusFile}.tmp`,
				JSON.stringify({
					pid: process.pid,
					sessionId: ctx.sessionManager.getSessionId(),
					sessionFile: ctx.sessionManager.getSessionFile() ?? "",
					cwd: ctx.cwd,
					name: pi.getSessionName() ?? "",
					status,
					statusUpdatedAt,
					startedAt,
				}),
			);
			renameSync(`${statusFile}.tmp`, statusFile); // the feed polls every 2 s and must never read half a file
		} catch {
			// A status file is a convenience; never let it break the session.
		}
	}

	function become(next: "idle" | "busy", ctx: ExtensionContext) {
		if (next !== status) statusUpdatedAt = Date.now();
		status = next;
		write(ctx);
	}

	pi.on("session_start", (_event, ctx) => become("idle", ctx));
	pi.on("session_info_changed", (_event, ctx) => write(ctx));
	pi.on("agent_start", (_event, ctx) => become("busy", ctx));
	// agent_end can still be followed by a retry, a compaction or a queued follow-up; settled means it is your turn.
	pi.on("agent_settled", (_event, ctx) => become("idle", ctx));
	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") rmSync(statusFile, { force: true }); // otherwise session_start rewrites it at once
	});
}

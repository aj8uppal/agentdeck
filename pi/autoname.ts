/**
 * Names each pi session from what it is about ("Address Copilot on #85241"), and puts the name in the terminal tab.
 * A small model from the session's own provider writes it after the first answer, again after a compaction (the work may
 * have moved on), and on /autoname. A name you set with /name is never replaced.
 * install.sh links this into ~/.pi/agent/extensions/.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You name coding-agent sessions so a person can tell a row of terminal tabs apart at a glance.
Reply with the name only: 2 to 6 words, sentence case, no quotes, no trailing period.
Lead with what is being done ("Fix", "Add", "Review", "Debug", "Research") when that reads naturally.
Keep a PR, ticket or issue number (#85241, UX-8) if the work is about it. Name the current focus, not the history.`;

type Text = { type?: string; text?: string };

function said(content: unknown) {
	const text = typeof content === "string" ? content : ((content as Text[]) ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
	return text.replace(/^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/, "/skill:$1 ").trim(); // an expanded skill, as typed
}

export default function (pi: ExtensionAPI) {
	let mine = ""; // the last name this extension set: any other name came from you
	let naming = false;
	const refused = new Set<string>(); // models that failed here (no quota, no access): not asked again this session

	function title(ctx: ExtensionContext) {
		const name = pi.getSessionName();
		if (name && ctx.hasUI) ctx.ui.setTitle(`π ${name}`);
	}

	async function rename(ctx: ExtensionContext, force = false) {
		const current = pi.getSessionName() ?? "";
		if (naming || ctx.mode !== "tui" || (current && current !== mine && !force)) return;
		const messages = ctx.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" ? [entry.message as { role: string; content: unknown }] : []));
		const asks = messages.filter((message) => message.role === "user").map((message) => said(message.content)).filter(Boolean);
		const answer = messages.filter((message) => message.role === "assistant").map((message) => said(message.content)).filter(Boolean).at(-1);
		if (!asks.length || !answer || !ctx.model) return;
		// Smallest first, from the session's own provider so the conversation goes nowhere new; the session's model last.
		const ownProvider = ctx.modelRegistry.getAvailable().filter((candidate) => candidate.provider === ctx.model?.provider);
		const models = [/haiku|mini|flash/i, /sonnet/i]
			.map((size) => ownProvider.find((candidate) => size.test(candidate.id)))
			.concat(ctx.model)
			.filter((model, index, all) => model && all.indexOf(model) === index && !refused.has(model.id));
		let branch = "";
		try {
			branch = execFileSync("git", ["branch", "--show-current"], { cwd: ctx.cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			// not a repo
		}
		const brief = [
			`Folder: ${basename(ctx.cwd)}${branch ? `, git branch ${branch}` : ""}`,
			`First request:\n${asks[0].slice(0, 2000)}`,
			asks.length > 1 ? `Latest request:\n${asks.at(-1)?.slice(0, 1000)}` : "",
			`Latest answer:\n${answer.slice(0, 2000)}`,
			current ? `Current name: ${current}. Keep it unless the focus has clearly moved.` : "",
		].filter(Boolean).join("\n\n");
		naming = true;
		try {
			let reply = "";
			let failure = "no model to ask";
			for (const model of models) {
				if (!model) continue;
				const response = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: brief }], timestamp: Date.now() }] },
					{ cacheRetention: "none", sessionId: uuidv7() },
				);
				reply = response.stopReason === "error" ? "" : said(response.content);
				if (reply) break;
				refused.add(model.id);
				failure = `${model.id}: ${response.errorMessage?.slice(0, 160) ?? "empty reply"}`;
			}
			if (!reply) throw new Error(failure);
			const name = reply.split("\n")[0].replace(/^["'`]+|["'`.]+$/g, "").trim().slice(0, 60);
			if (!name || (pi.getSessionName() ?? "") !== current) return; // you named it while this was running
			mine = name;
			pi.setSessionName(name);
			title(ctx);
		} catch (error) {
			if (force) ctx.ui.notify(`Could not name this session: ${error instanceof Error ? error.message : error}`, "error");
		} finally {
			naming = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// Remember which name was ours across a /reload or a resume, so a later rename knows it may replace it.
		const ours = ctx.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "autoname") as
			| { data?: { name?: string } }
			| undefined;
		mine = ours?.data?.name ?? "";
		title(ctx);
		if (!pi.getSessionName()) void rename(ctx); // a session opened before this extension existed gets its name now
	});
	pi.on("session_info_changed", (event, ctx) => {
		if (event.name && event.name === mine) pi.appendEntry("autoname", { name: mine });
		title(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!pi.getSessionName()) void rename(ctx);
	});
	pi.on("session_compact", (_event, ctx) => void rename(ctx));
	pi.registerCommand("autoname", {
		description: "Name this session from what it is about (replaces a name you set)",
		handler: async (_args, ctx) => {
			await rename(ctx, true);
			ctx.ui.notify(`Session: ${pi.getSessionName() ?? "(no name)"}`, "info");
		},
	});
}

/**
 * jev-bash-gate: a System One check on commands the model asks to run.
 *
 * This is a hook on the bash tool, not a tool. Nothing calls it directly; it
 * assesses each command the model requests and then decides whether to let it
 * run, ask you, or refuse. Commands you type yourself are untouched.
 *
 * Two questions per command, in one request:
 *
 *   does   what it primarily does (read, build, install, delete, network, vcs,
 *          process, permissions, other)
 *   risk   how bad it is if it does something unintended (none, low, medium, high)
 *
 * The risk answer is a distribution over four levels, and the decision reads that
 * distribution rather than its mean: the model's "high" comes back as 2.998, so a
 * mean comparison against 3.0 never fires. Three bands:
 *
 *   level is high, or P(high) >= blockAt        refuse, with the reason
 *   level is none/low and P(medium)+P(high) < askAt   run it silently
 *   in between                                  ask you, if you can be asked
 *
 * Below `minConfidence` (0.6 by default) a command that is not plainly read-only
 * lands in the ask band whatever the level says: an unsure "low" on `rm -rf` is
 * exactly the case worth a question. Read-only and build commands are exempt, since
 * `grep -rn TODO src` scores 0.54 confidence for reasons that have nothing to do with
 * safety. With no interactive terminal (RPC or print) the ask band follows
 * `nonInteractive`: run it with a warning, or refuse it.
 *
 * A separate "is this safe" question looked redundant, and measuring 18 commands
 * showed why: it never vetoed where risk did not, and it cleared four commands risk
 * flagged, including `git push origin main` at safe 0.92 against risk 1.9.
 *
 * Allowlists: `allow` in settings applies everywhere, `/jev-allow <prefix>` adds a
 * prefix for this session only. A prefix match skips the request entirely.
 *
 * Settings: overrides["jev-bash-gate"] = {
 *   askAt, blockAt, minConfidence, nonInteractive, allow, timeoutMs }
 *
 * Toggle: "+extensions/bash-gate.ts" in the package's extension list.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { listOption, numberOption } from "../src/shared.ts";

const EXTENSION = "jev-bash-gate";
const ALLOW_ENTRY = "jev-bash-gate.allowed";

interface Verdict {
	/** The level with the highest probability: 0 none, 1 low, 2 medium, 3 high. */
	level: number;
	levelLabel: string;
	/** Probability mass on medium and high, and on high alone. */
	elevated: number;
	severe: number;
	confidence: number;
	mean: number;
	does: string;
}

interface Bands {
	/** P(medium) + P(high) above which the command is worth a question. */
	askAt: number;
	/** P(high) at or above which the command is refused. */
	blockAt: number;
	minConfidence: number;
	nonInteractive: "run" | "block";
}

export default function (pi: ExtensionAPI) {
	/** One verdict per command, so a command seen twice costs one request. */
	const cache = new Map<string, { at: number; verdict: Verdict }>();
	const cacheTtlMs = 60_000;

	function settings(cwd: string, ctx: ExtensionContext) {
		const { endpoint, options } = resolve(cwd, EXTENSION, ctx.isProjectTrusted());
		const timeoutOverride = numberOption(options, "timeoutMs", 0);
		if (timeoutOverride > 0) endpoint.timeoutMs = timeoutOverride;
		const bands: Bands = {
			askAt: numberOption(options, "askAt", 0.25),
			blockAt: numberOption(options, "blockAt", 0.5),
			minConfidence: numberOption(options, "minConfidence", 0.6),
			nonInteractive: options.nonInteractive === "block" ? "block" : "run",
		};
		const allow = listOption(options, "allow", []);
		return { endpoint, options, bands, allow };
	}

	/** Prefixes allowed for this session by `/jev-allow`, recorded on the branch. */
	function sessionAllow(ctx: ExtensionContext): string[] {
		const prefixes: string[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			const custom = entry as { type?: string; customType?: string; data?: unknown };
			if (custom?.type !== "custom" || custom.customType !== ALLOW_ENTRY) continue;
			const data = custom.data as { prefixes?: string[] } | undefined;
			for (const prefix of data?.prefixes ?? []) if (typeof prefix === "string") prefixes.push(prefix);
		}
		return prefixes;
	}

	async function assess(
		endpoint: ReturnType<typeof settings>["endpoint"],
		command: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<Verdict> {
		const result = await systemOne(
			endpoint,
			`Working directory: ${cwd}\nCommand: ${command}`,
			{
				does: {
					type: "choice",
					instructions: "What does this command primarily do?",
					criteria: {
						read: "read or inspect state (ls, cat, grep, git status, tests)",
						build: "build or compile",
						install: "install packages or dependencies",
						delete: "delete, move or overwrite data",
						network: "access the network or call remote services",
						vcs: "change version control state (commit, push, branch, reset)",
						process: "start, stop or signal processes",
						permissions: "change permissions or ownership",
						other: "something else",
					},
				},
				risk: {
					type: "score",
					instructions: "How bad is it if this command does something unintended?",
					criteria: ["none", "low", "medium", "high"],
				},
			},
			{ signal },
		);
		const riskAnswer = result.answers.risk;
		const doesAnswer = result.answers.does;
		if (riskAnswer.type !== "score") {
			return { level: 3, levelLabel: "high", elevated: 1, severe: 1, confidence: 0, mean: 3, does: "unknown" };
		}
		const levels = ["none", "low", "medium", "high"];
		const entries = Object.entries(riskAnswer.probabilities).map(([label, probability]) => [Number(label), probability] as const);
		const level = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best), entries[0])[0];
		const probabilityAt = (index: number) => Number(riskAnswer.probabilities[String(index)] ?? 0);
		return {
			level,
			levelLabel: levels[level] ?? String(level),
			elevated: probabilityAt(2) + probabilityAt(3),
			severe: probabilityAt(3),
			confidence: riskAnswer.confidence,
			mean: riskAnswer.score,
			does: doesAnswer.type === "choice" ? doesAnswer.choice : "unknown",
		};
	}

	function describe(verdict: Verdict): string {
		return (
			`does: ${verdict.does}\n` +
			`risk: ${verdict.levelLabel} (P(medium)+P(high) ${verdict.elevated.toFixed(2)}, P(high) ${verdict.severe.toFixed(2)}, confidence ${verdict.confidence.toFixed(2)})`
		);
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || !command) return undefined;

		const { endpoint, bands, allow } = settings(ctx.cwd, ctx);
		const allowed = [...allow, ...sessionAllow(ctx)];
		if (allowed.some((prefix) => command.startsWith(prefix))) return undefined;

		const key = `${ctx.cwd} :: ${command}`;
		const hit = cache.get(key);
		let verdict = hit && Date.now() - hit.at < cacheTtlMs ? hit.verdict : undefined;
		if (!verdict) {
			try {
				verdict = await assess(endpoint, command, ctx.cwd, ctx.signal);
				cache.set(key, { at: Date.now(), verdict });
			} catch (error) {
				ctx.ui.notify(`jev bash gate: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		}

		if (verdict.level >= 3 || verdict.severe >= bands.blockAt) {
			return { block: true, reason: `jev bash gate: refused\n${describe(verdict)}\ncommand: ${command}` };
		}

		const harmless = verdict.does === "read" || verdict.does === "build";
		const unsure = verdict.confidence < bands.minConfidence && !harmless;
		if (verdict.level <= 1 && verdict.elevated < bands.askAt && !unsure) return undefined;

		if (ctx.mode !== "tui") {
			if (bands.nonInteractive === "block") {
				return { block: true, reason: `jev bash gate: no interactive terminal to confirm\n${describe(verdict)}\ncommand: ${command}` };
			}
			ctx.ui.notify(`jev bash gate: ${command}\n${describe(verdict)}`, "warn");
			return undefined;
		}

		const why = unsure
			? `low confidence (${verdict.confidence.toFixed(2)} < ${bands.minConfidence})`
			: `risk ${verdict.levelLabel}`;
		const confirmed = await ctx.ui.confirm("Run this command?", `Command: ${command}\n\n${why}\n${describe(verdict)}`);
		if (confirmed) return undefined;
		return {
			block: true,
			reason: `Rejected at the prompt: ${command}\n${describe(verdict)}`,
		};
	});

	pi.registerCommand("jev-allow", {
		description: "Let the model run commands starting with a prefix this session: /jev-allow <prefix>",
		handler: async (args, ctx) => {
			const prefix = args.trim();
			if (!prefix) {
				const current = settings(ctx.cwd, ctx);
				const session = sessionAllow(ctx);
				ctx.ui.notify(
					[
						"usage: /jev-allow <command prefix>",
						"",
						"Adds the prefix for this session only, and the gate stops asking about those commands.",
						`session: ${session.length ? session.join(", ") : "none"}`,
						`always (settings): ${current.allow.length ? current.allow.join(", ") : "none"}`,
						"",
						`bands: silent while P(medium)+P(high) < ${current.bands.askAt}, refused at P(high) >= ${current.bands.blockAt} or level high, asked in between`,
						`minimum confidence to run silently: ${current.bands.minConfidence}`,
					].join("\n"),
					"info",
				);
				return;
			}
			pi.appendEntry(ALLOW_ENTRY, { prefixes: [prefix] });
			ctx.ui.notify(`jev bash gate: ${prefix} is allowed for this session`, "info");
		},
	});
}
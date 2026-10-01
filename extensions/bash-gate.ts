/**
 * jev-bash-gate: a System One check on commands the model asks to run.
 *
 * Only model-requested commands are gated. Commands you type yourself are left
 * alone: you are the one invoking them.
 *
 * Two questions per command, in one request:
 *
 *   does   what it primarily does (read, build, install, delete, network, vcs,
 *          process, permissions, other)
 *   risk   how bad it is if it does something unintended (none, low, medium, high)
 *
 * Risk is the decision variable. A separate "is this safe" question looked
 * redundant, and measuring 18 commands showed why: it is risk with a looser
 * threshold. It never vetoed where risk did not (nothing scored unsafe with low
 * risk), and it cleared four commands risk flagged, including `git push origin
 * main` at safe 0.92 against risk 1.9. `does` is kept because it makes the
 * confirmation prompt say something useful.
 *
 * Modes: `notify` (default) shows the verdict and runs it anyway, `block` refuses
 * anything risk is at or above `blockAt`, `off` never interferes. Verdict per
 * command: risk below `clearAt` is "cleared" and passes without a word.
 *
 * Settings: overrides["jev-bash-gate"] = { mode, clearAt, blockAt, timeoutMs,
 * allowlist }
 *
 * Toggle: "+extensions/bash-gate.ts" in the package's extension list.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { numberOption, stringOption, text } from "../src/shared.ts";

const EXTENSION = "jev-bash-gate";

type Mode = "notify" | "block" | "off";
const MODES: Mode[] = ["notify", "block", "off"];

const AssessParams = Type.Object({
	command: Type.String({ description: "The command to assess" }),
	cwd: Type.Optional(Type.String({ description: "Working directory it would run in (default: pi's cwd)" })),
});

interface Verdict {
	risk: number;
	riskLabel: string;
	does: string;
	text: string;
	cleared: boolean;
}

function modeOption(options: Record<string, unknown>, fallback: Mode): Mode {
	const value = stringOption(options, "mode", fallback);
	return MODES.includes(value as Mode) ? (value as Mode) : fallback;
}

export default function (pi: ExtensionAPI) {
	/** One verdict per command, cached so a command assessed twice costs one request. */
	const cache = new Map<string, { at: number; verdict: Verdict }>();
	const cacheTtlMs = 60_000;

	function settings(cwd: string, ctx: ExtensionContext) {
		const { endpoint, options } = resolve(cwd, EXTENSION, ctx.isProjectTrusted());
		const timeoutOverride = numberOption(options, "timeoutMs", 0);
		if (timeoutOverride > 0) endpoint.timeoutMs = timeoutOverride;
		return { endpoint, options };
	}

	async function assess(
		endpoint: ReturnType<typeof settings>["endpoint"],
		command: string,
		cwd: string,
		options: Record<string, unknown>,
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
		const risk = riskAnswer.type === "score" ? riskAnswer.score : 3;
		const doesAnswer = result.answers.does;
		const labels = riskAnswer.type === "score" ? riskAnswer.legend : {};
		const riskLabel = riskAnswer.type === "score" ? String(labels[String(Math.round(risk))] ?? risk) : "high";
		const does = doesAnswer.type === "choice" ? doesAnswer.choice : "unknown";
		return {
			risk,
			riskLabel,
			does,
			text: `does: ${does}\nrisk: ${riskLabel} (${risk.toFixed(2)} of 3)`,
			cleared: risk < numberOption(options, "clearAt", 1.0),
		};
	}

	pi.registerTool({
		name: "jev_gate_bash",
		label: "Jev Bash Gate",
		description:
			"Assess a shell command for risk and side effects with System One, without running it. Returns what it " +
			"primarily does and a 0-3 risk score. Use before running a command the user did not write.",
		promptSnippet: "Assess a shell command's risk with System One, without running it",
		parameters: AssessParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const { endpoint, options } = settings(cwd, ctx);
			try {
				const verdict = await assess(endpoint, params.command, cwd, options, signal);
				return {
					...text(`[jev ${endpoint.name}]\ncommand: ${params.command}\n${verdict.text}`),
					details: {
						command: params.command,
						cwd,
						risk: verdict.risk,
						riskLabel: verdict.riskLabel,
						does: verdict.does,
						cleared: verdict.cleared,
					},
				};
			} catch (error) {
				return {
					...text(`Jev request failed via ${endpoint.name} (${endpoint.url}).\n${error instanceof Error ? error.message : String(error)}`),
					details: { command: params.command, error: true },
				};
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const { options } = settings(ctx.cwd, ctx);
		const mode = modeOption(options, "notify");
		if (mode === "off") return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || !command) return undefined;

		const allowlist = Array.isArray(options.allowlist) ? (options.allowlist as string[]) : [];
		if (allowlist.some((prefix) => command.startsWith(prefix))) return undefined;

		const key = `${ctx.cwd} :: ${command}`;
		const hit = cache.get(key);
		let verdict = hit && Date.now() - hit.at < cacheTtlMs ? hit.verdict : undefined;
		if (!verdict) {
			const { endpoint } = settings(ctx.cwd, ctx);
			try {
				verdict = await assess(endpoint, command, ctx.cwd, options, ctx.signal);
				cache.set(key, { at: Date.now(), verdict });
			} catch (error) {
				ctx.ui.notify(`jev bash gate: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		}
		if (verdict.cleared) return undefined;

		if (mode === "notify") {
			ctx.ui.notify(`jev bash gate: ${command}\n${verdict.text}`, "warn");
			return undefined;
		}
		return {
			block: true,
			reason: `jev bash gate: risk ${verdict.riskLabel} (${verdict.risk.toFixed(2)}), does ${verdict.does}\ncommand: ${command}`,
		};
	});
}

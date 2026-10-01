/**
 * jev-bash-gate: a System One check on bash commands before they run.
 *
 * Both entry points are covered: commands typed by the user (`!cmd`, via user_bash)
 * and commands the model asks for (via tool_call on the bash tool). The gate asks
 * three questions about the command in its working directory and then acts on the
 * answer according to `mode`:
 *
 *   allow  auto-run only what the gate clears, never interrupt
 *   ask    auto-run what the gate clears, otherwise confirm interactively
 *   block  run nothing the gate has not cleared
 *   off    never interfere
 *   notify carry on but show the verdict (model commands only)
 *
 * "Cleared" means P(safe) >= autoAllowAt and mean risk <= maxRiskAt.
 *
 * Defaults are mode "ask" for user commands and "notify" for model commands: a
 * wrong block stops work mid-task, while a wrong allow is visible in the log. A
 * local open-jev scores about 0.73 on typed yes/no questions, not 1.0, so the
 * thresholds are deliberately conservative and every verdict is shown.
 *
 * Settings: overrides["jev-bash-gate"] = {
 *   mode, modelMode, autoAllowAt, maxRiskAt, timeoutMs, blockWhenUncertain, allowlist }
 *
 * Toggle: "+extensions/bash-gate.ts" in the package's extension list.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { assessCommand, numberOption, stringOption, text } from "../src/shared.ts";

const EXTENSION = "jev-bash-gate";

type Mode = "allow" | "ask" | "block" | "notify" | "off";
const MODES: Mode[] = ["allow", "ask", "block", "notify", "off"];

const AssessParams = Type.Object({
	command: Type.String({ description: "The command to assess" }),
	cwd: Type.Optional(Type.String({ description: "Working directory it would run in (default: pi's cwd)" })),
});

interface Verdict {
	safe: number;
	risk: number;
	does: string;
	text: string;
	cleared: boolean;
}

function modeOption(options: Record<string, unknown>, key: string, fallback: Mode): Mode {
	const value = stringOption(options, key, fallback);
	return MODES.includes(value as Mode) ? (value as Mode) : fallback;
}

export default function (pi: ExtensionAPI) {
	/** One verdict per command, cached so a command asked about twice costs one request. */
	const cache = new Map<string, { at: number; verdict: Verdict }>();
	const cacheTtlMs = 60_000;

	function settings(cwd: string, ctx: ExtensionContext) {
		const { endpoint, options } = resolve(cwd, EXTENSION, ctx.isProjectTrusted());
		const timeoutOverride = numberOption(options, "timeoutMs", 0);
		if (timeoutOverride > 0) endpoint.timeoutMs = timeoutOverride;
		return { endpoint, options };
	}

	async function check(command: string, cwd: string, ctx: ExtensionContext): Promise<Verdict | undefined> {
		const key = `${cwd} :: ${command}`;
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < cacheTtlMs) return hit.verdict;

		const { endpoint, options } = settings(cwd, ctx);
		const allowlist = Array.isArray(options.allowlist) ? (options.allowlist as string[]) : [];
		if (allowlist.some((prefix) => command.startsWith(prefix))) {
			const verdict: Verdict = { safe: 1, risk: 0, does: "allowlisted", text: "allowlisted", cleared: true };
			cache.set(key, { at: Date.now(), verdict });
			return verdict;
		}

		try {
			const assessment = await assessCommand(endpoint, command, cwd, ctx.signal);
			const verdict: Verdict = {
				safe: assessment.safe,
				risk: assessment.risk,
				does: assessment.does,
				text: assessment.text,
				cleared:
					assessment.safe >= numberOption(options, "autoAllowAt", 0.9) &&
					assessment.risk <= numberOption(options, "maxRiskAt", 0.5),
			};
			cache.set(key, { at: Date.now(), verdict });
			return verdict;
		} catch (error) {
			ctx.ui.notify(`jev bash gate: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	}

	function blocked(message: string) {
		return { result: { output: message, exitCode: 1, cancelled: false, truncated: false } };
	}

	pi.registerTool({
		name: "jev_gate_bash",
		label: "Jev Bash Gate",
		description:
			"Assess a shell command for safety and side effects with System One, without running it. Returns P(safe), " +
			"what it primarily does, and a risk level. Use before running a command the user did not write.",
		promptSnippet: "Assess a shell command's safety with System One, without running it",
		parameters: AssessParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const { endpoint } = settings(cwd, ctx);
			try {
				const assessment = await assessCommand(endpoint, params.command, cwd, ctx.signal);
				return {
					...text(`[jev ${endpoint.name} ${assessment.result.elapsedMs}ms]\n${assessment.text}`),
					details: {
						command: params.command,
						cwd,
						safe: assessment.safe,
						risk: assessment.risk,
						does: assessment.does,
						answers: assessment.result.answers,
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

	pi.on("user_bash", async (event, ctx) => {
		const { options } = settings(event.cwd, ctx);
		const mode = modeOption(options, "mode", "ask");
		if (mode === "off") return undefined;

		const verdict = await check(event.command, event.cwd, ctx);
		if (!verdict) return undefined;
		if (verdict.cleared) return undefined;

		// Only the interactive terminal can answer a prompt. RPC reports hasUI, but
		// a client that never replies would leave the command waiting forever.
		const interactive = ctx.mode === "tui";
		if (mode === "allow" || (mode !== "block" && !interactive)) {
			if (!numberOption(options, "blockWhenUncertain", false)) {
				ctx.ui.notify(`jev bash gate (${mode}): not auto-cleared\n${verdict.text}`, "warn");
				return undefined;
			}
			return blocked(`Blocked by jev bash gate.\n${verdict.text}`);
		}
		if (mode === "block") return blocked(`Blocked by jev bash gate.\n${verdict.text}`);

		const confirmed = await ctx.ui.confirm("Run this command?", `Command: ${event.command}\n\n${verdict.text}`);
		if (confirmed) return undefined;
		return blocked(`Rejected by jev bash gate.\n${verdict.text}`);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const { options } = settings(ctx.cwd, ctx);
		const mode = modeOption(options, "modelMode", "notify");
		if (mode === "off" || mode === "ask") return undefined;

		if (event.toolName !== "bash") return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || !command) return undefined;

		const verdict = await check(command, ctx.cwd, ctx);
		if (!verdict) return undefined;
		if (verdict.cleared) return undefined;

		if (mode === "notify") {
			ctx.ui.notify(`jev bash gate: not auto-cleared\n${verdict.text}`, "warn");
			return undefined;
		}
		return { block: true, reason: `jev bash gate did not clear this command.\n${verdict.text}` };
	});
}
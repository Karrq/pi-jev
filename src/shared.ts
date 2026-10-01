/**
 * Shared plumbing for the pi-jev extensions: option reading, error text and the
 * `/jev` status line every extension can register.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedEndpoint } from "./config.ts";

/**
 * Whether a command matches any allowlist pattern.
 *
 * A pattern with no wildcard is a prefix, so `npm test` keeps working as it did.
 * A pattern with `*`, `?` or a character class is matched as a glob against the whole
 * command: `git *`, `*rm -rf /*`, `npm run (build|test)`.
 */
export function matchesAny(command: string, patterns: readonly string[]): string | undefined {
	for (const pattern of patterns) {
		if (!pattern) continue;
		if (!/[*?[\]{}]/.test(pattern)) {
			if (command.startsWith(pattern)) return pattern;
			continue;
		}
		let regex = "";
		for (const char of pattern) {
			if (char === "*") regex += ".*";
			else if (char === "?") regex += ".";
			else if ("\\^$.|+()".includes(char)) regex += `\\${char}`;
			else regex += char;
		}
		try {
			if (new RegExp(`^${regex}$`).test(command)) return pattern;
		} catch {
			// A pattern that is not a valid regex is treated as a literal prefix.
			if (command.startsWith(pattern)) return pattern;
		}
	}
	return undefined;
}

/** Read a numeric option with a default, from `overrides[<extension>]` in settings.json. */
export function numberOption(options: Record<string, unknown>, key: string, fallback: number): number {
	const value = options[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Read a string option with a default. */
export function stringOption(options: Record<string, unknown>, key: string, fallback: string): string {
	const value = options[key];
	return typeof value === "string" && value ? value : fallback;
}

/** Read a string-array option with a default. */
export function listOption(options: Record<string, unknown>, key: string, fallback: string[]): string[] {
	const value = options[key];
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : fallback;
}

export function text(content: string): { content: [{ type: "text"; text: string }] } {
	return { content: [{ type: "text", text: content }] };
}

/** Uniform failure text for a tool result, including which endpoint was tried. */
export function failure(endpoint: ResolvedEndpoint, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const help = `${endpoint.name} (${endpoint.url})`;
	return text(`Jev request failed via ${help}.\n${message}`);
}

export function endpointLine(endpoint: ResolvedEndpoint, sources: string[]): string {
	const auth = endpoint.apiKey ? "bearer token set" : "no api key";
	return `endpoint ${endpoint.name} -> ${endpoint.url} (${auth}${endpoint.model ? `, model ${endpoint.model}` : ""})\nsettings: ${sources.join(", ") || "none found"}`;
}

/** Ask the endpoint whether one command is safe, and what it does. */
export async function assessCommand(
	endpoint: ResolvedEndpoint,
	command: string,
	cwd: string,
	signal?: AbortSignal,
) {
	const { systemOne } = await import("./client.ts");
	const { choice, score, noul, formatAnswer } = await import("./types.ts");
	const state = `Working directory: ${cwd}\nCommand: ${command}`;
	const questions = {
		safe: noul(
			"Is this command safe to run right now, with no destructive, irreversible or unexpected side effects?",
			"Safe: read-only, reversible, or exactly what the work calls for.",
			"Not safe: deletes or overwrites data, touches paths outside the project, sends data out, or does something the current work does not call for.",
		),
		does: choice("What does this command primarily do?", {
			read: "read or inspect state (ls, cat, grep, git status, tests)",
			build: "build or compile",
			install: "install packages or dependencies",
			delete: "delete, move or overwrite data",
			network: "access the network or call remote services",
			vcs: "change version control state (commit, push, branch, reset)",
			process: "start, stop or signal processes",
			permissions: "change permissions or ownership",
			other: "something else",
		}),
		risk: score("How bad is it if this command does something unintended?", ["none", "low", "medium", "high"]),
	};
	const result = await systemOne(endpoint, state, questions, { signal });
	const lines = Object.entries(result.answers).map(([id, answer]) => `${id}: ${formatAnswer(answer)}`);
	return {
		result,
		text: lines.join("\n"),
		safe: result.answers.safe.type === "noul" ? result.answers.safe.noul : 0,
		risk: result.answers.risk.type === "score" ? result.answers.risk.score : 0,
		riskConfidence: result.answers.risk.type === "score" ? result.answers.risk.confidence : 0,
		does: result.answers.does.type === "choice" ? result.answers.does.choice : "unknown",
	};
}

/** Human-readable label for the pi-jev status line. */
export function statusLine(endpoint: ResolvedEndpoint, sources: string[], cwd: string): string {
	return `jev ${endpoint.name} ${endpoint.url} [${sources.length} settings file(s)] cwd ${cwd}`;
}

export type { ExtensionContext };
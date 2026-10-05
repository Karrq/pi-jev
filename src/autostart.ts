/**
 * Bringing the local open-jev service up when it is not answering.
 *
 * The classifier provider points at a local endpoint by default, and a fresh login
 * leaves that launchd agent stopped. When `pi-jev.autostart` is exactly true and the
 * endpoint is local, `ensureLocalService` probes `/health`, starts the service (a
 * `server.command`, or launchd on macOS), and polls until it answers.
 *
 * Nothing here touches the network or launchd unless autostart is true and the
 * endpoint is local: with the flag off, `ensureLocalService` returns "skipped"
 * immediately.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_LABEL = "local.openjev.server";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_POLL_MS = 2_000;

/** Strip trailing slashes, then a trailing `/v1`, from an endpoint URL. */
export function rootUrlOf(url: string): string {
	const trimmed = url.replace(/\/+$/, "");
	if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3).replace(/\/+$/, "");
	return trimmed;
}

/** True when the URL host is loopback: 127.0.0.1, localhost or ::1. */
export function isLocalEndpoint(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return false;
	}
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export type StartOutcome = "skipped" | "healthy" | "started" | "timeout" | "failed";

export interface StartServiceOptions {
	rootUrl: string;
	autostart: boolean;
	label?: string;
	command?: string;
	cwd?: string;
	timeoutMs?: number;
	probeTimeoutMs?: number;
	pollMs?: number;
	notify?: (message: string, level: "info" | "warning" | "error") => void;
}

interface StartAttempt {
	ok: boolean;
	/** Human description of what was run, for the failure notification. */
	tried: string;
}

/** `<rootUrl>/health` answers 2xx with a JSON body when the service is up. */
async function healthOk(rootUrl: string, probeTimeoutMs: number): Promise<boolean> {
	try {
		const response = await fetch(`${rootUrl}/health`, { signal: AbortSignal.timeout(probeTimeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a command to completion; true on exit code 0. Never throws. */
function run(command: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => resolve(false));
		child.on("exit", (code) => resolve(code === 0));
	});
}

/** Spawn `server.command` detached and let it keep running after pi exits. */
function spawnCommand(command: string, cwd: string | undefined): StartAttempt {
	try {
		const child = spawn(command, {
			cwd: cwd ?? process.cwd(),
			shell: true,
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		// A spawn failure must not become an unhandled "error" event.
		child.on("error", () => {});
		child.unref();
		return { ok: true, tried: `server.command \`${command}\`` };
	} catch {
		return { ok: false, tried: `server.command \`${command}\`` };
	}
}

/**
 * Start the service. Uses `server.command` when set, otherwise launchd on macOS.
 * A label's agent may already be loaded but stopped, or not loaded at all, so
 * kickstart falls back to bootstrap and then to load. No `-k`: kickstarting a
 * service that is mid-start must not kill it.
 */
async function startService(options: StartServiceOptions): Promise<StartAttempt> {
	if (options.command) return spawnCommand(options.command, options.cwd);

	const label = options.label ?? DEFAULT_LABEL;
	if (process.platform !== "darwin") {
		return { ok: false, tried: "server.command (unset); launchd is macOS-only" };
	}

	const uid = process.getuid?.() ?? 0;
	const domain = `gui/${uid}/${label}`;
	if (await run("launchctl", ["kickstart", domain])) return { ok: true, tried: `launchctl kickstart ${domain}` };

	const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
	if (!existsSync(plist)) return { ok: false, tried: `launchctl kickstart ${domain}` };

	if (await run("launchctl", ["bootstrap", `gui/${uid}`, plist])) {
		return { ok: true, tried: `launchctl bootstrap gui/${uid} ${plist}` };
	}
	if (await run("launchctl", ["load", "-w", plist])) {
		return { ok: true, tried: `launchctl load -w ${plist}` };
	}
	return { ok: false, tried: `launchctl kickstart ${domain}, bootstrap and load ${plist}` };
}

/**
 * Ensure a local open-jev service is up.
 *
 * Returns without touching anything unless `autostart` is true and `rootUrl` is a
 * loopback endpoint. Otherwise probe `/health`, start the service if needed, then
 * poll until it answers or `timeoutMs` elapses. Never throws.
 */
export async function ensureLocalService(options: StartServiceOptions): Promise<StartOutcome> {
	if (!options.autostart) return "skipped";
	if (!isLocalEndpoint(options.rootUrl)) return "skipped";

	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const notify = options.notify;

	try {
		if (await healthOk(options.rootUrl, probeTimeoutMs)) return "healthy";

		notify?.("local-jev: starting the local Jev service...", "info");
		const attempt = await startService(options);
		if (!attempt.ok) {
			notify?.(`local-jev: could not start the local Jev service (tried ${attempt.tried}).`, "error");
			return "failed";
		}

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await sleep(pollMs);
			if (await healthOk(options.rootUrl, probeTimeoutMs)) {
				notify?.("local-jev: the local Jev service is up.", "info");
				return "started";
			}
		}

		notify?.(
			`local-jev: the local Jev service did not answer /health within ${timeoutMs}ms (tried ${attempt.tried}).`,
			"warning",
		);
		return "timeout";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify?.(`local-jev: starting the local Jev service failed: ${message}.`, "error");
		return "failed";
	}
}

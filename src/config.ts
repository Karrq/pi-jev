/**
 * Reading pi-jev's settings out of pi's settings.json.
 *
 * Pi has no per-extension settings mechanism, so pi-jev uses one top-level key in
 * the settings file it already reads:
 *
 *   "pi-jev": {
 *     "endpoint": "local",
 *     "endpoints": {
 *       "local": { "url": "http://127.0.0.1:10610" },
 *       "prod":  { "url": "https://api.typesafe.ai", "apiKeyEnv": "JEV_API_KEY" }
 *     },
 *     "model": "gemma-4-26b-a4b",
 *     "timeoutMs": 120000,
 *     "overrides": { "bash-gate": { "autoAllowAt": 0.9 } }
 *   }
 *
 * Project settings (<cwd>/.pi/settings.json) win over user settings, but only after
 * project trust, which the caller reports through `trusted`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EndpointConfig {
	/** Base URL of a TypeSafe-compatible /v1/systemone server. */
	url: string;
	/** Environment variable holding the bearer token. Never the token itself. */
	apiKeyEnv?: string;
	/** Model name sent with requests; the server's own name is used when absent. */
	model?: string;
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export interface JevServerSettings {
	/** launchd label to kickstart on macOS. Default "local.openjev.server". */
	label?: string;
	/** Command to spawn instead of launchd. */
	command?: string;
	cwd?: string;
	/** How long to wait for /health after starting, ms. Default 120000. */
	timeoutMs?: number;
}

export interface JevSettings {
	/** Which entry of `endpoints` to use. Defaults to "local", then to `url`. */
	endpoint?: string;
	endpoints?: Record<string, string | EndpointConfig>;
	/** Shorthand for a single unnamed endpoint. */
	url?: string;
	apiKeyEnv?: string;
	model?: string;
	timeoutMs?: number;
	/** Per-extension overrides, keyed by extension name (e.g. "bash-gate"). */
	overrides?: Record<string, Record<string, unknown>>;
	/** Shown to the model and in /jev to explain where requests go. */
	defaults?: Record<string, unknown>;
	/**
	 * Start the local open-jev service when the endpoint is not answering. Off by
	 * default, and only ever applies to a local endpoint. See `server` for the
	 * launchd label or command to use.
	 */
	autostart?: boolean;
	server?: JevServerSettings;
}

export interface ResolvedEndpoint {
	name: string;
	url: string;
	apiKey?: string;
	model?: string;
	timeoutMs: number;
	headers: Record<string, string>;
}

export const DEFAULT_URL = "http://127.0.0.1:10610";
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface LoadedSettings {
	settings: JevSettings;
	/** Which files contributed, user first. */
	sources: string[];
}

const cache = new Map<string, { mtimeMs: number; value: unknown }>();

function readJson(path: string): unknown | undefined {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		cache.delete(path);
		return undefined;
	}
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs) return hit.value;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		value = undefined;
	}
	cache.set(path, { mtimeMs, value });
	return value;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge project settings over user settings, one level deep, ignoring unknown keys. */
function merge(a: JevSettings, b: JevSettings): JevSettings {
	const out: JevSettings = { ...a };
	for (const [key, value] of Object.entries(b)) {
		if (value === undefined) continue;
		if (isObject(value) && isObject(out[key])) {
			out[key as keyof JevSettings] = { ...(out[key] as object), ...value } as never;
		} else {
			out[key as keyof JevSettings] = value as never;
		}
	}
	return out;
}

export function loadSettings(cwd: string, trusted = false): LoadedSettings {
	const sources: string[] = [];
	let settings: JevSettings = {};

	const userPath = join(agentDir(), "settings.json");
	const user = readJson(userPath);
	if (isObject(user) && isObject(user["pi-jev"])) {
		settings = user["pi-jev"] as JevSettings;
		sources.push(userPath);
	}

	if (trusted) {
		const projectPath = join(cwd, ".pi", "settings.json");
		const project = readJson(projectPath);
		if (isObject(project) && isObject(project["pi-jev"])) {
			settings = merge(settings, project["pi-jev"] as JevSettings);
			sources.push(projectPath);
		}
	}

	return { settings, sources };
}

function toEndpoint(value: string | EndpointConfig | undefined): EndpointConfig | undefined {
	if (typeof value === "string") return value ? { url: value } : undefined;
	if (isObject(value) && typeof value.url === "string" && value.url) return value as EndpointConfig;
	return undefined;
}

/**
 * Resolve the endpoint an extension should talk to.
 *
 * `extension` picks up `settings.overrides[extension]` first, so one extension can
 * point somewhere else (or at different thresholds) without touching the others.
 */
/**
 * The whole of `~/.pi/agent/settings.json`, for the few places that need a pi setting
 * rather than a `pi-jev` one. Cached by mtime like the rest.
 */
export function readAgentSettings(): Record<string, unknown> {
	const settings = readJson(join(agentDir(), "settings.json"));
	return isObject(settings) ? settings : {};
}

export function resolveEndpoint(settings: JevSettings, extension?: string): ResolvedEndpoint {
	const scoped: JevSettings = { ...settings };
	const override = extension ? settings.overrides?.[extension] : undefined;
	if (isObject(override)) {
		for (const [key, value] of Object.entries(override)) {
			(scoped as Record<string, unknown>)[key] = value;
		}
		if (isObject(override.endpoints) && isObject(scoped.endpoints)) {
			scoped.endpoints = { ...scoped.endpoints, ...(override.endpoints as JevSettings["endpoints"]) };
		}
	}

	const endpoints = scoped.endpoints ?? {};
	const name = scoped.endpoint ?? (endpoints.local ? "local" : Object.keys(endpoints)[0]) ?? "default";
	const chosen = toEndpoint(endpoints[name]) ?? toEndpoint(endpoints.default) ?? toEndpoint(scoped.url);
	const url = (chosen?.url ?? DEFAULT_URL).replace(/\/+$/, "");
	const apiKeyEnv = chosen?.apiKeyEnv ?? scoped.apiKeyEnv;
	const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

	return {
		name,
		url,
		apiKey,
		model: chosen?.model ?? scoped.model,
		timeoutMs: chosen?.timeoutMs ?? scoped.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		headers: chosen?.headers ?? {},
	};
}

export interface ResolvedExtension {
	endpoint: ResolvedEndpoint;
	/** Everything from `overrides[extension]`, for extension-specific settings. */
	options: Record<string, unknown>;
	sources: string[];
}

/** Endpoint plus that extension's own option block. */
export function resolve(cwd: string, extension: string, trusted = false): ResolvedExtension {
	const { settings, sources } = loadSettings(cwd, trusted);
	const options = settings.overrides?.[extension] ?? {};
	return { endpoint: resolveEndpoint(settings, extension), options, sources };
}

export function describe(endpoint: ResolvedEndpoint): string {
	const auth = endpoint.apiKey ? ` (auth via ${endpoint.apiKey ? "bearer token" : ""})` : "";
	return `${endpoint.name} -> ${endpoint.url}${auth}${endpoint.model ? ` [${endpoint.model}]` : ""}`;
}
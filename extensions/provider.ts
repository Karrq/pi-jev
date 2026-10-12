/**
 * jev-provider: the local System One endpoint as a pi classifier provider.
 *
 * Registers provider `local-jev`, so any extension can call
 * `ctx.modelRegistry.getModelsOfType("classifier", "local-jev")` and
 * `ctx.modelRegistry.classify(model, { state, questions })` instead of talking to
 * the endpoint through a hand-rolled client. `src/classifier.ts` also exports a
 * `classify(ctx, ...)` wrapper that resolves the model and adds elapsed time.
 *
 * The model carries api `local-jev-system-one`, implemented in `src/classifier.ts`,
 * rather than pi's built-in `typesafe-system-one`. The built-in parser normalizes
 * score answers to `{ score, confidence }` and drops `legend` and per-level
 * probabilities, which the bash gate and model router read.
 *
 * Two details the System One transport imposes:
 * - it builds the URL as `<baseUrl>/systemone`, and open-jev serves `/v1/systemone`,
 *   so `baseUrl` must end in `/v1` (the built-in typesafe provider uses `.../v1/`).
 * - it requires a non-empty apiKey; a local server ignores the value, so `"local"`
 *   is a safe fallback.
 *
 * The endpoint (url, model, apiKey, headers) comes from pi-jev's settings under the
 * `pi-jev` key, through `resolve(cwd, "provider", trusted)`. It is resolved at load and
 * again on every `session_start`, since cwd and project trust are only known then. It
 * re-registers only when the resolved values actually changed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { API, DEFAULT_MODEL, providerClassify } from "../src/classifier.ts";
import { ensureLocalService, rootUrlOf } from "../src/autostart.ts";
import { loadSettings, resolve } from "../src/config.ts";
import type { JevSettings } from "../src/config.ts";

const PROVIDER = "local-jev";
const CONTEXT_WINDOW = 128_000;

/** What the last registration resolved to, for the change check on session start. */
interface Registered {
	baseUrl: string;
	id: string;
	apiKey: string;
	headers: Record<string, string>;
}

/** Strip trailing slashes, then add `/v1` unless the url already ends with it. */
function classifierBaseUrl(url: string): string {
	const trimmed = url.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Guards against firing more than one service start at a time. */
let starting: Promise<unknown> | undefined;

/** Start the local open-jev service on session start, when settings ask for it. */
function maybeStart(ctx: ExtensionContext, settings: JevSettings): void {
	if (settings.autostart !== true || starting) return;
	const rootUrl = rootUrlOf(resolve(ctx.cwd, "provider", ctx.isProjectTrusted()).endpoint.url);
	starting = ensureLocalService({
		rootUrl,
		autostart: true,
		label: settings.server?.label,
		command: settings.server?.command,
		cwd: settings.server?.cwd,
		timeoutMs: settings.server?.timeoutMs,
		notify: (message, level) => ctx.ui.notify(message, level),
	}).finally(() => {
		starting = undefined;
	});
}

export default function (pi: ExtensionAPI) {
	let registered: Registered | undefined;

	function build(cwd: string, trusted: boolean) {
		const { endpoint } = resolve(cwd, "provider", trusted);
		const baseUrl = classifierBaseUrl(endpoint.url);
		const id = endpoint.model ?? DEFAULT_MODEL;
		const apiKey = endpoint.apiKey ?? "local";
		const headers = endpoint.headers;
		const model = {
			type: "classifier" as const,
			id,
			name: `Local Jev (${id})`,
			api: API,
			baseUrl,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CONTEXT_WINDOW,
		};
		const config = {
			apiKey,
			models: [model],
			classifiers: { [API]: { classify: providerClassify } },
			...(Object.keys(headers).length ? { headers } : {}),
		};
		const state: Registered = { baseUrl, id, apiKey, headers };
		return { config, state };
	}

	function sync(cwd: string, trusted: boolean): void {
		const { config, state } = build(cwd, trusted);
		const unchanged =
			registered !== undefined &&
			registered.baseUrl === state.baseUrl &&
			registered.id === state.id &&
			registered.apiKey === state.apiKey &&
			JSON.stringify(registered.headers) === JSON.stringify(state.headers);
		if (unchanged) return;
		if (registered) pi.unregisterProvider(PROVIDER);
		pi.registerProvider(PROVIDER, config);
		registered = state;
	}

	sync(process.cwd(), false);

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const trusted = ctx.isProjectTrusted();
		sync(ctx.cwd, trusted);
		const { settings } = loadSettings(ctx.cwd, trusted);
		void maybeStart(ctx, settings);
	});
}

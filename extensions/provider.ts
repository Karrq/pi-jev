/**
 * jev-provider: the local System One endpoint as a pi classifier provider.
 *
 * pi ships classifier models and a built-in `typesafe-system-one` API. Registering
 * this provider exposes the local open-jev server as provider `local-jev`, so any
 * extension can call `ctx.modelRegistry.getModelOfType("classifier", "local-jev")`
 * and `ctx.modelRegistry.classify(model, { state, questions })` instead of talking to
 * the endpoint through the hand-rolled client in `src/client.ts`. Retiring that client
 * is the point; it is the current alternative until the extensions are migrated.
 *
 * Two details the built-in transport imposes:
 * - it builds the URL as `<baseUrl>/systemone`, and open-jev serves `/v1/systemone`,
 *   so `baseUrl` must end in `/v1` (the built-in typesafe provider uses `.../v1/`).
 * - it resolves an apiKey before sending and throws when none is found; a local server
 *   ignores the value, so `"local"` is a safe fallback.
 *
 * The endpoint (url, model, apiKey, headers) comes from pi-jev's settings under the
 * `pi-jev` key, through `resolve(cwd, "provider", trusted)`. It is resolved at load and
 * again on every `session_start`, since cwd and project trust are only known then. It
 * re-registers only when the resolved values actually changed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "../src/config.ts";

const PROVIDER = "local-jev";
const API = "typesafe-system-one";
const DEFAULT_MODEL = "open-jev";
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
			api: API,
			apiKey,
			models: [model],
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
		sync(ctx.cwd, ctx.isProjectTrusted());
	});
}

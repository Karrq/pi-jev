/**
 * Client for a TypeSafe-compatible System One endpoint.
 *
 * Same POST /v1/systemone contract for the hosted service and for a local
 * open-jev server, so switching between them is a settings change (see config.ts).
 * open-jev answers in ~0.5s for a short state and reuses a prefilled prefix across
 * requests, which matters when one state is asked hundreds of questions.
 */

import type { ResolvedEndpoint } from "./config.ts";
import type { JevQuestion, SystemOneRequest, SystemOneResponse } from "./types.ts";

export interface AskOptions {
	/** Aborts the request; also used to implement timeouts. */
	signal?: AbortSignal;
	/** Overrides the endpoint's default model for this call. */
	model?: string;
}

export interface AskResult {
	answers: Record<string, SystemOneResponse["answers"][string]>;
	usage: { input_tokens?: number; output_tokens?: number };
	elapsedMs: number;
	endpoint: string;
	model?: string;
}

/** Ask `questions` about `state`. One request, no generation on the server. */
export async function systemOne(
	endpoint: ResolvedEndpoint,
	state: SystemOneRequest["state"],
	questions: Record<string, JevQuestion>,
	options: AskOptions = {},
): Promise<AskResult> {
	if (Object.keys(questions).length === 0) throw new Error("no questions to ask");

	const headers: Record<string, string> = {
		"content-type": "application/json",
		...endpoint.headers,
	};
	if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
	const model = options.model ?? endpoint.model;

	const timeout = AbortSignal.timeout(endpoint.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const started = Date.now();

	let response: Response;
	try {
		response = await fetch(`${endpoint.url}/v1/systemone`, {
			method: "POST",
			headers,
			signal,
			body: JSON.stringify({ state, questions, ...(model ? { model } : {}) } satisfies SystemOneRequest),
		});
	} catch (error) {
		const reason = signal.aborted && !options.signal?.aborted
			? `timed out after ${endpoint.timeoutMs}ms`
			: String((error as Error)?.message ?? error);
		throw new Error(`jev request to ${endpoint.name} (${endpoint.url}) failed: ${reason}`);
	}

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, 400);
		throw new Error(`jev request to ${endpoint.name} (${endpoint.url}) failed: HTTP ${response.status} ${body}`);
	}

	const payload = (await response.json()) as SystemOneResponse;
	if (!payload.answers) throw new Error(`jev ${endpoint.name} returned no answers`);

	return {
		answers: payload.answers,
		usage: payload.usage ?? {},
		elapsedMs: Date.now() - started,
		endpoint: endpoint.name,
		model: payload.model,
	};
}

/** Run `systemOne` and render the answers as one line per question. */
export async function askFormatted(
	endpoint: ResolvedEndpoint,
	state: SystemOneRequest["state"],
	questions: Record<string, JevQuestion>,
	format: (id: string, answer: SystemOneResponse["answers"][string]) => string,
	options: AskOptions = {},
): Promise<{ text: string; result: AskResult }> {
	const result = await systemOne(endpoint, state, questions, options);
	const lines = Object.entries(result.answers).map(([id, answer]) => `${id}: ${format(id, answer)}`);
	return { text: lines.join("\n"), result };
}
/**
 * The local System One endpoint as a pi classifier, with the score-level
 * distribution preserved.
 *
 * pi ships a `typesafe-system-one` classifier API, but it normalizes every score
 * answer to `{ score, confidence }` and drops `legend` and `probabilities` on the
 * way out (`@earendil-works/pi-ai/dist/api/system-one-shared.js`). The bash gate
 * decides from P(medium)+P(high) and P(high); the model router reads the winning
 * level from the distribution. Both need the mass the built-in parser throws away,
 * and `ClassifierScoreAnswer` has no field for it, so the endpoint is registered
 * under its own classifier api here instead.
 *
 * `extensions/provider.ts` registers provider `local-jev` with the implementation
 * below. Extensions do not call it directly; they call `classify()` with an
 * `ExtensionContext`, which resolves the model and adds elapsed time and errors.
 *
 * Two details carried over from the built-in transport:
 * - the URL is `<baseUrl>/systemone`, and open-jev serves `/v1/systemone`, so the
 *   provider sets `baseUrl` ending in `/v1` (see provider.ts).
 * - a non-empty apiKey is required; a local server ignores its value.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
	JsonObject,
	Usage,
} from "@earendil-works/pi-ai";

/**
 * The question vocabulary the extensions build against. `bool` is pi's name for
 * what the endpoint calls `noul`; the wire mapping lives in `wireQuestions`.
 */
export type JevQuestion = ClassifierQuestion;
/** Tool-facing question kind, where `noul` is the documented spelling of `bool`. */
export type QuestionType = "noul" | "choice" | "score";

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

/** The whole point of this module: `probabilities` and `legend` survive the trip. */
export interface ScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
	probabilities: Record<string, number>;
	legend: Record<string, string>;
}

export interface BoolAnswer {
	type: "bool";
	probability: number;
}

export type JevAnswer = ChoiceAnswer | ScoreAnswer | BoolAnswer;

/** Provider id registered by `extensions/provider.ts`. */
export const PROVIDER = "local-jev";
/** Classifier api id this module implements. */
export const API = "local-jev-system-one";
/** Model id used when the endpoint names none. */
export const DEFAULT_MODEL = "open-jev";

/** Wire shape of one answer, probabilities and legend intact. */
interface WireAnswers {
	[id: string]: {
		type?: unknown;
		choice?: unknown;
		probabilities?: unknown;
		confidence?: unknown;
		score?: unknown;
		legend?: unknown;
		noul?: unknown;
	};
}

/** Retry statuses: 429 and 529 are the documented back-offs, 5xx covers gateways. */
function isRetryable(status: number): boolean {
	return status === 429 || status === 529 || (status >= 500 && status < 600);
}

function retryDelayMs(response: Response, attempt: number): number {
	const header = response.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		const date = Date.parse(header);
		if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	}
	return 500 * 2 ** attempt;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a choice question from `label -> description` pairs. */
export function choice(instructions: string, criteria: Record<string, string>): JevQuestion {
	return { type: "choice", instructions, criteria };
}

/** Build a score question from ordered level descriptions. */
export function score(instructions: string, criteria: string[]): JevQuestion {
	return { type: "score", instructions, criteria };
}

/**
 * Build a yes/no question. pi requires both sides of `criteria`, so generic
 * wording stands in when the caller names neither.
 */
export function noul(instructions: string, yes?: string, no?: string): JevQuestion {
	return {
		type: "bool",
		instructions,
		criteria: { true: yes ?? "Yes", false: no ?? "No" },
	};
}

/** Yes/no probability, whichever way the answer was spelled. */
export function noulProbability(answer: JevAnswer): number {
	if (answer.type === "bool") return answer.probability;
	if (answer.type === "choice") {
		const entries = Object.entries(answer.probabilities);
		const yes = entries.find(([label]) => /^(true|yes)$/i.test(label));
		const no = entries.find(([label]) => /^(false|no)$/i.test(label));
		if (yes && no) return yes[1];
	}
	throw new Error(`answer is not a yes/no answer: ${JSON.stringify(answer)}`);
}

/** Full distribution, label to probability, for any answer type. */
export function distribution(answer: JevAnswer): Record<string, number> {
	if (answer.type === "bool") return { true: answer.probability, false: 1 - answer.probability };
	return answer.probabilities;
}

/** The highest-probability label, its probability, and the server's confidence. */
export function topLabel(answer: JevAnswer): { label: string; probability: number; confidence: number } {
	if (answer.type === "bool") {
		return {
			label: answer.probability >= 0.5 ? "true" : "false",
			probability: Math.max(answer.probability, 1 - answer.probability),
			confidence: Math.abs(answer.probability - 0.5) * 2,
		};
	}
	const entries = Object.entries(answer.probabilities);
	if (entries.length === 0) {
		// The hosted API has shipped score answers without a distribution; the mean is the floor.
		const label = answer.type === "score" ? (answer.legend[String(Math.round(answer.score))] ?? String(Math.round(answer.score))) : "";
		return { label, probability: 0, confidence: answer.type === "score" ? answer.confidence : 0 };
	}
	const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
	const label = answer.type === "score" ? (answer.legend[best[0]] ?? best[0]) : best[0];
	return { label, probability: best[1], confidence: answer.confidence };
}

/** One line per answer: the winning label first, then the whole distribution. */
export function formatAnswer(answer: JevAnswer): string {
	const dist = distribution(answer);
	const parts = Object.entries(dist)
		.sort((a, b) => b[1] - a[1])
		.map(([label, p]) => `${label} ${(p * 100).toFixed(1)}%`);
	const head = answer.type === "score" ? `mean level ${answer.score.toFixed(2)}` : topLabel(answer).label;
	return `${head} (${parts.join(", ")})`;
}

function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} returned an invalid ${field}`);
	return value;
}

function numberMap(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	const out: Record<string, number> = {};
	for (const [key, probability] of Object.entries(value)) {
		out[key] = requiredNumber(label, probability, `probability for ${id}.${key}`);
	}
	return out;
}

function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, label] of Object.entries(value)) if (typeof label === "string") out[key] = label;
	return out;
}

/** Map public `bool` questions to System One's wire-level `noul`. */
function wireQuestions(questions: Record<string, ClassifierQuestion>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(questions).map(([id, question]) => [
			id,
			question.type === "bool" ? { ...question, type: "noul" } : question,
		]),
	);
}

function parseAnswers(label: string, value: unknown, questions: Record<string, ClassifierQuestion>): Record<string, JevAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers: Record<string, JevAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			answers[id] = {
				type: "choice",
				choice: answer.choice,
				probabilities: numberMap(label, answer.probabilities, id),
				confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
			};
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			answers[id] = {
				type: "score",
				score: requiredNumber(label, answer.score, `score for ${id}`),
				confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				probabilities: numberMap(label, answer.probabilities, id),
				legend: stringMap(answer.legend),
			};
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers[id] = { type: "bool", probability: requiredNumber(label, answer.noul, `probability for ${id}`) };
		}
	}
	return answers;
}

function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const input = typeof value.input_tokens === "number" && value.input_tokens > 0 ? value.input_tokens : 0;
	const output = typeof value.output_tokens === "number" && value.output_tokens > 0 ? value.output_tokens : 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		// The provider registers the local model at zero cost, so the split is zero too.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The `ProviderClassifier` implementation registered by `extensions/provider.ts`.
 * Never rejects: a failure comes back with `stopReason` set, the same contract as
 * the built-in classifier APIs.
 */
export async function providerClassify(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: ClassifierOptions,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const label = "System One API";
	try {
		if (model.api !== API) throw new Error(`Unsupported classifier API: ${model.api}`);
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		if (!model.baseUrl) throw new Error(`Provider ${model.provider} has no baseUrl`);

		const url = `${model.baseUrl.replace(/\/+$/u, "")}/systemone`;
		const headers: Record<string, string> = {
			"content-type": "application/json",
			authorization: `Bearer ${options.apiKey}`,
			...model.headers,
			...options.headers,
		};
		const body = JSON.stringify({
			model: model.id,
			state: context.state,
			questions: wireQuestions(context.questions),
		});
		const maxAttempts = (options.maxRetries ?? 2) + 1;
		const fetchImpl = (options.fetch ?? globalThis.fetch) as typeof fetch;

		let lastError: unknown;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const timeout = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			const signal = options.signal && timeout
				? AbortSignal.any([options.signal, timeout])
				: (options.signal ?? timeout);
			let response: Response;
			try {
				response = await fetchImpl(url, { method: "POST", headers, body, signal });
			} catch (error) {
				if (options.signal?.aborted) throw error;
				lastError = error;
				if (attempt === maxAttempts - 1) break;
				await sleep(500 * 2 ** attempt, options.signal);
				continue;
			}
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				lastError = new Error(`${label} returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
				if (!isRetryable(response.status) || attempt === maxAttempts - 1) break;
				await sleep(retryDelayMs(response, attempt), options.signal);
				continue;
			}
			const payload = (await response.json()) as { answers?: WireAnswers; usage?: unknown };
			const usage = parseUsage(payload.usage);
			if (usage) output.usage = usage;
			output.answers = parseAnswers(label, payload.answers, context.questions) as ClassifierResult["answers"];
			return output;
		}
		throw lastError ?? new Error(`${label} request failed`);
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		return output;
	}
}

export interface ClassifyOptions {
	signal?: AbortSignal;
	/** Selects among registered classifier models by id; defaults to the only one. */
	model?: string;
	timeoutMs?: number;
}

export interface ClassifyResult {
	answers: Record<string, JevAnswer>;
	usage?: Usage;
	elapsedMs: number;
	provider: string;
	model: string;
}

/** The `local-jev` classifier model, or undefined before provider.ts has registered it. */
export function classifierModel(ctx: ExtensionContext, id?: string): ClassifierModel<ClassifierApi> | undefined {
	const models = ctx.modelRegistry.getModelsOfType("classifier", PROVIDER);
	if (models.length === 0) return undefined;
	if (id) return models.find((model) => model.id === id) ?? undefined;
	return models[0];
}

/**
 * Ask the endpoint `questions` about `state` through pi's model registry.
 *
 * Throws on any failure, unlike `providerClassify`, so callers keep the try/catch
 * they already had around a direct request.
 */
export async function classify(
	ctx: ExtensionContext,
	state: string | JsonObject,
	questions: Record<string, JevQuestion>,
	options: ClassifyOptions = {},
): Promise<ClassifyResult> {
	if (Object.keys(questions).length === 0) throw new Error("no questions to ask");
	const model = classifierModel(ctx, options.model);
	if (!model) throw new Error(`no classifier registered for provider ${PROVIDER}; is extensions/provider.ts loaded?`);
	const started = Date.now();
	const result = await ctx.modelRegistry.classify(
		model,
		{ state: state as JsonObject, questions },
		{ signal: options.signal, timeoutMs: options.timeoutMs },
	);
	if (result.stopReason !== "stop") {
		throw new Error(
			`jev request to ${model.provider} (${model.id}) failed: ${result.errorMessage ?? result.stopReason}`,
		);
	}
	return {
		answers: result.answers as Record<string, JevAnswer>,
		usage: result.usage,
		elapsedMs: Date.now() - started,
		provider: result.provider,
		model: result.model,
	};
}

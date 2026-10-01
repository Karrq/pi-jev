/**
 * jev-model-router: a virtual model that lets Jev pick the physical model.
 *
 * Registers `jev/auto` (provider `jev`, id `auto`). Select it like any other
 * model, put it in `defaultModel` or `enabledModels`, and every request is routed:
 * Jev reads the latest user message and chooses which enabled model handles it, plus
 * a thinking level. Because the choice happens inside a virtual model, subagents and
 * any allowlist that names models work unchanged: they just see `jev/auto`.
 *
 * What Jev is told about each candidate comes from pi's model registry: price per
 * million tokens in and out, context window, and which thinking levels that model
 * accepts. Pi has no capability benchmarks, so anything you know about a model's
 * character goes in `profiles` as a free-text note and is passed through verbatim.
 *
 * The questions:
 * - One score per candidate: how well should this model handle the task, weighing
 *   price. The cheapest model that handles it well scores top; a cheap model that
 *   only scrapes by does not. The highest score wins, ties go to the cheaper model.
 * - One score for depth, on exactly the levels the chosen model accepts, so the
 *   level that comes back is a level pi can actually send.
 *
 * Routing rules:
 * - `user` requests are routed by Jev. `continuation` and `retry` stay on the model
 *   that handled the turn, which keeps prompt caches and thinking signatures valid.
 * - `direct` requests (compaction summaries, extension calls) go to `fallback`.
 * - If Jev is unreachable or returns nothing usable, `fallback` answers instead.
 *
 * Settings: overrides["jev-model-router"] = {
 *   fallback, candidates, profiles, thinkingLevels, maxCandidates, taskChars,
 *   tieMargin }
 *
 * Toggle: "+extensions/model-router.ts" in the package's extension list.
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { listOption, numberOption, objectOption, stringOption } from "../src/shared.ts";

const EXTENSION = "jev-model-router";

const VIRTUAL_PROVIDER = "jev";
const VIRTUAL_ID = "auto";

const DEFAULT_LEVELS = ["off", "low", "medium", "high", "xhigh"];
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof ALL_LEVELS)[number];

/** Five levels for "how well should this model handle the task, weighing price". */
const FIT_LEVELS = ["cannot", "poorly", "adequately", "well", "expertly"];

interface Candidate {
	label: string;
	model: Model<any>;
	/** Levels this model accepts, narrowed to what `jev/auto` advertises. */
	levels: Level[];
	/** Dollars per million tokens. */
	input: number;
	output: number;
	/** Weighted for an agentic turn: one input token is worth three output tokens. */
	blended: number;
	note?: string;
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function money(value: number): string {
	return `$${value.toFixed(2)}`;
}

/** Levels this model accepts, from its thinking level map, narrowed to `advertised`. */
function levelsOf(model: Model<any>, advertised: readonly Level[]): Level[] {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	if (!map) return [...advertised];
	const supported = advertised.filter((level) => map[level] !== null);
	return supported.length ? supported : ["off"];
}

function describe(candidate: Candidate, index: number): string {
	const lines = [
		`[${index}] ${candidate.label}`,
		`    price: ${money(candidate.input)}/M input, ${money(candidate.output)}/M output`,
		`    limits: ${Math.round(candidate.model.contextWindow / 1000)}k context, ${Math.round(candidate.model.maxTokens / 1000)}k max output`,
		`    thinking: ${candidate.levels.join(", ")}`,
	];
	if (candidate.note) lines.push(`    notes: ${candidate.note}`);
	return lines.join("\n");
}

function collect(ctx: ExtensionContext, labels: string[], notes: Record<string, string>, advertised: readonly Level[]): Candidate[] {
	const registry = ctx.modelRegistry;
	const candidates: Candidate[] = [];
	for (const label of labels) {
		const slash = label.indexOf("/");
		const model = registry.find(label.slice(0, slash), label.slice(slash + 1));
		if (!model) continue;
		const input = model.cost?.input ?? 0;
		const output = model.cost?.output ?? 0;
		candidates.push({
			label,
			model,
			levels: levelsOf(model, advertised),
			input,
			output,
			blended: input + 3 * output,
			note: notes[label],
		});
	}
	return candidates;
}

/** Nearest level to `requested`, by name, within what the model accepts. */
function nearestLevel(requested: string, allowed: readonly Level[]): Level {
	const wanted = ALL_LEVELS.indexOf(requested as Level);
	if (wanted < 0) return allowed[0];
	if (allowed.includes(requested as Level)) return requested as Level;
	return allowed.reduce((best, level) =>
		Math.abs(ALL_LEVELS.indexOf(level) - wanted) < Math.abs(ALL_LEVELS.indexOf(best) - wanted) ? level : best,
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel({
		provider: VIRTUAL_PROVIDER,
		id: VIRTUAL_ID,
		name: "Auto (Jev)",
		thinkingLevels: DEFAULT_LEVELS,
		async route(request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> {
			// Options can only be read from a context, and route() does not get one
			// until a session starts, so read them through the model registry's ctx.
			const { options } = resolve(ctx.cwd ?? process.cwd(), EXTENSION, ctx.isProjectTrusted());
			const fallbackLabel = stringOption(options, "fallback", "");
			const advertised = listOption(options, "thinkingLevels", DEFAULT_LEVELS) as Level[];
			const profiles = objectOption(options, "profiles", {}) as Record<string, string>;
			const maxCandidates = numberOption(options, "maxCandidates", 24);
			const taskChars = numberOption(options, "taskChars", 16_000);
			const tieMargin = numberOption(options, "tieMargin", 0.25);

			const scoped = (ctx.getScopedModels?.() ?? []).map((entry: any) => entry.model ?? entry);
			const enabled = [
				...new Set(
					scoped
						.map((model: any) => `${model?.provider ?? ""}/${model?.id ?? ""}`)
						.filter((label) => label !== "/" && label !== `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`),
				),
			];
			const configured = listOption(options, "candidates", []);
			const labels = (configured.length ? configured : enabled).slice(0, maxCandidates);
			const candidates = collect(ctx, labels, profiles, advertised);
			if (candidates.length === 0) {
				throw new Error(
					`jev-model-router: no candidate models. Set overrides["${EXTENSION}"].candidates or enable models with credentials.`,
				);
			}
			const fallback =
				candidates.find((candidate) => candidate.label === fallbackLabel)?.model ?? candidates[0].model;

			// Keep the turn together: continuation and retry stay on the same model so
			// prompt caches and thinking signatures survive.
			if (request.reason === "continuation" && request.previous) {
				return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel };
			}
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel };
			}
			if (request.reason !== "user" || candidates.length < 2) {
				return { model: fallback, thinkingLevel: request.thinkingLevel };
			}

			const task = lastUserText(request.messages).slice(0, taskChars);
			const state = [`Task:\n${task}`, "", "Candidate models:", ...candidates.map(describe)].join("\n");
			// Depth is asked on the levels `jev/auto` advertises and then narrowed by name
			// to the winner's own levels. Intersecting them here instead would collapse the
			// question to "off" as soon as one candidate cannot think.
			const depthLevels = advertised.filter((level) => candidates.some((candidate) => candidate.levels.includes(level)));
			const depthCriteria = depthLevels.length ? depthLevels : (["off"] as Level[]);

			try {
				const { endpoint } = resolve(ctx.cwd ?? process.cwd(), EXTENSION, ctx.isProjectTrusted());
				const questions: Record<string, any> = {};
				for (const [index, candidate] of candidates.entries()) {
					questions[`fit_${index}`] = {
						type: "score",
						instructions:
							`How well should ${candidate.label} handle this task, weighing what it costs? The cheapest model that handles it well belongs at the top; a cheap model that only scrapes by does not, however cheap it is.`,
						criteria: FIT_LEVELS,
					};
				}
				questions.depth = {
					type: "score",
					instructions: "How much reasoning depth does this task need?",
					criteria: depthCriteria,
				};

				const result = await systemOne(endpoint, state, questions, { signal: request.signal });

				// Highest fit wins; models within tieMargin of it are treated as tied and
				// the cheaper of those takes it.
				const scored = candidates
					.map((candidate, index) => {
						const answer = result.answers[`fit_${index}`];
						return { candidate, fit: answer?.type === "score" ? answer.score : -1 };
					})
					.filter((entry) => entry.fit >= 0);
				if (scored.length === 0) return { model: fallback, thinkingLevel: request.thinkingLevel };
				const best = Math.max(...scored.map((entry) => entry.fit));
				const contenders = scored.filter((entry) => entry.fit >= best - tieMargin);
				const chosen = contenders.reduce((a, b) => (b.candidate.blended < a.candidate.blended ? b : a));

				const depth = result.answers.depth;
				const requested = depth?.type === "score" ? String(levelLabel(depth)) : "off";
				const thinkingLevel = nearestLevel(requested, chosen.candidate.levels);
				return { model: chosen.candidate.model, thinkingLevel };
			} catch {
				return { model: fallback, thinkingLevel: request.thinkingLevel };
			}
		},
	});
}

/** The score answer's winning level, falling back to rounding its mean index. */
function levelLabel(answer: { probabilities: Record<string, number>; score: number }): string {
	const entries = Object.entries(answer.probabilities ?? {});
	if (entries.length) {
		const [label] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
		if (label) return label;
	}
	return ALL_LEVELS[Math.max(0, Math.min(ALL_LEVELS.length - 1, Math.round(answer.score)))] ?? "off";
}

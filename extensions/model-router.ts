/**
 * jev-model-router: a virtual model that lets Jev pick the physical model.
 *
 * Registers `jev/auto` (provider `jev`, id `auto`). Select it like any other
 * model, put it in `defaultModel` or `enabledModels`, and every request is routed:
 * Jev reads the latest user message and chooses which enabled model handles it, plus
 * a thinking level. Because the choice happens inside a virtual model, subagents and
 * any allowlist that names models work unchanged: they just see `jev/auto`.
 *
 * What Jev is told about each candidate is Artificial Analysis: capability on the
 * Intelligence Index and cost per task, per model *and reasoning effort*, since the
 * site reports those as separate entities. So Jev sees that Opus 5.5 at medium scores 51
 * for $1.34 a task, that Opus at low scores 42 for $0.55, and that Sonnet 5.5 at high
 * scores 47 for $1.08, and can weigh the pair rather than the name. Anything else you
 * know about a model goes in `profiles` as a free-text note.
 *
 * Those two numbers are the whole decision. A cheap model that cannot do the task
 * scores low and loses; a cheap model that can do it scores high and wins the tie,
 * since ties go to the cheapest measured configuration.
 *
 * The questions:
 * - One score per candidate: how well should this model handle the task, weighing
 *   price. The cheapest model that handles it well scores top; a cheap model that
 *   only scrapes by does not. The highest score wins, ties go to the cheaper model.
 * - One score for depth over the levels the chosen model accepts, weighted by what
 *   each step up costs, since the effort numbers say a step can be worth it or not.
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
import { costAtLevel, effortLines } from "../src/aa.ts";
import { readAgentSettings, resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { listOption, numberOption, objectOption, stringOption } from "../src/shared.ts";

const EXTENSION = "jev-model-router";

const VIRTUAL_PROVIDER = "jev";
const VIRTUAL_ID = "auto";

const DEFAULT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
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

/** Levels this model accepts, from its thinking level map, narrowed to `advertised`. */
function levelsOf(model: Model<any>, advertised: readonly Level[]): Level[] {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	if (!map) return [...advertised];
	const supported = advertised.filter((level) => map[level] !== null);
	return supported.length ? supported : ["off"];
}

function describe(candidate: Candidate, index: number): string {
	const lines = [`[${index}] ${candidate.label}`];
	const efforts = effortLines(candidate.model);
	if (efforts) {
		lines.push("    Artificial Analysis Intelligence Index and cost per task, by reasoning effort:");
		lines.push(...efforts);
	}
	if (candidate.note) lines.push(`    notes: ${candidate.note}`);
	return lines.join("\n");
}

/**
 * The models this session may use, as `provider/id`.
 *
 * Pi's context exposes them as `ctx.scopedModels` (an array of `{model}`); the typed
 * `ctx.getScopedModels()` is declared but absent at runtime, so asking for it returns
 * nothing and every candidate disappears. Both shapes are accepted, and the enabled
 * models in settings are the last resort when a context carries neither.
 */
function enabledLabels(ctx: ExtensionContext): string[] {
	const scoped = (ctx as { scopedModels?: unknown }).scopedModels ?? [];
	const entries = Array.isArray(scoped) ? scoped : [];
	const labels = entries.map((entry: any) => {
		const model = entry?.model ?? entry;
		const provider = model?.provider ?? "";
		const id = model?.id ?? "";
		return provider && id ? `${provider}/${id}` : "";
	});
	if (labels.length) return [...new Set(labels)];
	const getter = (ctx as { getScopedModels?: () => readonly unknown[] }).getScopedModels;
	if (typeof getter === "function") {
		const fromGetter = getter.call(ctx).map((entry: any) => {
			const model = entry?.model ?? entry;
			return model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
		});
		if (fromGetter.length) return [...new Set(fromGetter)];
	}
	// Last resort: the enabled model patterns in settings, which is where the session's
	// model set comes from anyway.
	const patterns = listOption(readAgentSettings(), "enabledModels", []);
	const expanded = new Set<string>();
	for (const pattern of patterns) {
		if (!pattern.includes("*")) {
			expanded.add(pattern.includes("/") ? pattern : `claude-bridge/${pattern}`);
			continue;
		}
		const [provider, pattern2] = pattern.split("/");
		if (!pattern2) continue;
		const prefix = pattern2.split("*")[0];
		for (const model of ctx.modelRegistry.getAll()) {
			if (model.provider === provider && model.id.startsWith(prefix)) expanded.add(`${provider}/${model.id}`);
		}
	}
	return [...expanded];
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
		// Only shown until the first response, after which pi uses the physical model's own
		// limits. These are the smallest among the candidates rather than a claim about any
		// one model, since the model is not known until it is routed.
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> {
			// Options can only be read from a context, and route() does not get one
			// until a session starts, so read them through the model registry's ctx.
			const { options } = resolve(ctx.cwd ?? process.cwd(), EXTENSION, ctx.isProjectTrusted());
			const fallbackLabel = stringOption(options, "fallback", "");
			const advertised = listOption(options, "thinkingLevels", DEFAULT_LEVELS) as Level[];
			const profiles = objectOption(options, "profiles", {}) as Record<string, string>;
			const maxCandidates = numberOption(options, "maxCandidates", 24);
			const taskChars = numberOption(options, "taskChars", 16_000);
			const tieMargin = numberOption(options, "tieMargin", 0.5);

			const enabled = enabledLabels(ctx).filter((label) => label !== `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`);
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

			const hasAa = candidates.some((candidate) => effortLines(candidate.model) !== undefined);
			try {
				const { endpoint } = resolve(ctx.cwd ?? process.cwd(), EXTENSION, ctx.isProjectTrusted());
				const questions: Record<string, any> = {};
				for (const [index, candidate] of candidates.entries()) {
					questions[`fit_${index}`] = {
						type: "score",
						instructions:
							`How well should ${candidate.label} handle this task, weighing what it costs? Judge it against what the task needs, not against the model's reputation. The cheapest model that handles it well belongs at the top; a cheap model that only scrapes by does not, however cheap it is.`,
						criteria: FIT_LEVELS,
					};
				}
				questions.depth = {
					type: "score",
					instructions: hasAa
						? "How much reasoning depth does this task need? Weigh what each step up costs: where a higher effort barely raises the score, stay at the lower one."
						: "How much reasoning depth does this task need?",
					criteria: depthCriteria,
				};

				const result = await systemOne(endpoint, state, questions, { signal: request.signal });

				// Depth first: the effort decides what a task costs, so the cost comparison
				// has to happen at the effort that will actually be used.
				const depth = result.answers.depth;
				const requested = depth?.type === "score" ? levelLabel(depth) : "off";

				// Highest fit wins; models within tieMargin of it are treated as tied and the
				// cheapest of those takes it. Cost is what a task costs at the effort each
				// model would run at, which is what lets a cheap model win a task that does
				// not need a strong one.
				const scored = candidates
					.map((candidate, index) => {
						const answer = result.answers[`fit_${index}`];
						const level = nearestLevel(requested, candidate.levels);
						// Measured cost at that effort, else the cheapest row the site has, else
						// the catalog price for a model it knows nothing about.
						const cost = costAtLevel(candidate.model, level, true) ?? candidate.blended;
						return { candidate, level, cost, fit: answer?.type === "score" ? answer.score : -1 };
					})
					.filter((entry) => entry.fit >= 0);
				if (scored.length === 0) return { model: fallback, thinkingLevel: request.thinkingLevel };
				const best = Math.max(...scored.map((entry) => entry.fit));
				const contenders = scored.filter((entry) => entry.fit >= best - tieMargin);
				const chosen = contenders.reduce((a, b) => (b.cost < a.cost ? b : a));
				return { model: chosen.candidate.model, thinkingLevel: chosen.level };
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

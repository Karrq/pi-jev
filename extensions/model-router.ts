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
import { costAtLevel, effortLines, type ManualProfile } from "../src/aa.ts";
import { readAgentSettings, resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { listOption, numberOption, profilesOption, stringOption } from "../src/shared.ts";

const EXTENSION = "jev-model-router";

const VIRTUAL_PROVIDER = "jev";
const VIRTUAL_ID = "auto";

const DEFAULT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof ALL_LEVELS)[number];

/** Five levels for "how well should this model handle the task, weighing price". */
const FIT_LEVELS = ["cannot", "poorly", "adequately", "well", "expertly"];

/**
 * How much work the task is, from smallest to largest. These are magnitudes, not turn
 * counts: "a multi-step piece of work" might be four turns or forty, and the point is
 * only how many more turns the cache can be amortised over.
 */
const LENGTH_LEVELS = [
	"one answer and done",
	"one task, finished here",
	"a few steps with check-ins",
	"a multi-step piece of work",
	"a project over many turns",
];

/** Turns to amortise a cache write over, per length level. Geometric on purpose. */
const DEFAULT_HORIZON_BY_LEVEL = [1, 1, 2, 4, 8];

interface Candidate {
	label: string;
	model: Model<any>;
	/** Levels this model accepts, narrowed to what `jev/auto` advertises. */
	levels: Level[];
	/** Dollars per million tokens. */
	input: number;
	output: number;
	cacheRead: number;
	/** What priming this model's cache costs, per million input tokens. */
	cacheWrite: number;
	/** Weighted for an agentic turn: one input token is worth three output tokens. */
	blended: number;
	/** Set when the rates came from another provider's catalog rather than this model's. */
	pricedFrom?: string;
	note?: string;
	/** Hand-written scores and notes from `profiles`, if any. */
	profile?: ManualProfile;
}

/** One scored candidate: the model, the effort it would run at, and what that costs. */
interface Scored {
	candidate: Candidate;
	level: Level;
	/** What the tie-break compares: this turn's expected cost, or per-task cost. */
	cost: number;
	/** Artificial Analysis dollars per task at this effort, when measured. */
	aaCost?: number;
	fit: number;
	/** Expected dollars for the upcoming turn with this pair's cache already warm. */
	warmTurn: number;
	/** Expected dollars for the upcoming turn, writing this pair's cache first. */
	coldTurn: number;
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
	const efforts = effortLines(candidate.model, candidate.profile);
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

/**
 * What the upcoming turn is likely to cost, in dollars.
 *
 * A warm pair pays cache-read rates for the whole prompt; a cold one pays cache-write
 * rates to prime it. Output is charged at the model's own rate either way, which is why
 * a long turn on a cheap model can beat a short turn on an expensive one, and why the
 * cache write is worth paying only when enough turns follow.
 */
function turnCost(candidate: Candidate, prefixTokens: number, outputTokens: number, warm: boolean): number {
	const perMillion = 1_000_000;
	const input = (prefixTokens / perMillion) * (warm ? candidate.cacheRead : candidate.cacheWrite);
	const output = (outputTokens / perMillion) * candidate.output;
	return input + output;
}

/** One completed user prompt in this session, and what answering it actually took. */
interface TurnRecord {
	prompt: string;
	turns: number;
	models: string[];
	outputTokens: number;
	/** Dollars for those turns, from reported usage or from borrowed rates. */
	cost: number;
	estimated: boolean;
}

/**
 * What earlier prompts in this session cost in turns, models and dollars.
 *
 * The length question guesses how big a piece of work is. A precedent does not guess:
 * "what is the capital of France?" took one turn and 40 dollars of cents, so a short
 * follow-up to it is a small task, and a prompt like the multi-step one that took nine
 * turns is not. Only completed prompts appear, so the current turn is never listed.
 */
function sessionHistory(
	messages: readonly Message[],
	candidates: readonly Candidate[],
	prompts: number,
	promptChars: number,
): TurnRecord[] {
	const rateFor = new Map(candidates.map((candidate) => [candidate.label, candidate]));
	const records: TurnRecord[] = [];
	let current: TurnRecord | undefined;
	for (const message of messages) {
		if (message.role === "user") {
			current = { prompt: lastUserText([message]).trim(), turns: 0, models: [], outputTokens: 0, cost: 0, estimated: false };
			records.push(current);
			continue;
		}
		if (message.role !== "assistant" || !current) continue;
		const usage = (message as { usage?: { output?: number; cost?: { total?: number } } }).usage;
		if (!usage) continue;
		current.turns += 1;
		current.outputTokens += usage.output ?? 0;
		const model = `${(message as { provider?: string }).provider ?? "?"}/${(message as { model?: string }).model ?? "?"}`;
		if (!current.models.includes(model)) current.models.push(model);
		const reported = usage.cost?.total ?? 0;
		if (reported > 0) {
			current.cost += reported;
		} else {
			// Bridges and free routers report no cost. Price those tokens with whatever
			// rates this candidate borrowed, so the precedent still has a number.
			const rates = rateFor.get(model) ?? rateFor.get(`${(message as any).provider}/${(message as any).model}`);
			if (rates) {
				const input = (usage as any).input ?? 0;
				const read = (usage as any).cacheRead ?? 0;
				const write = (usage as any).cacheWrite ?? 0;
				current.cost +=
					((input + write) / 1_000_000) * rates.cacheWrite +
					(read / 1_000_000) * rates.cacheRead +
					(usage.output ?? 0) / 1_000_000 * rates.output;
				current.estimated = true;
			}
		}
	}
	return records.filter((record) => record.turns > 0).slice(-prompts);
}


/**
 * Prompt size and expected answer size for the next turn, from what the last assistant
 * message actually used. That is a far better estimate than the length of the last user
 * message, and it is what a cache write would have to cover.
 */
function turnSize(messages: readonly Message[]): { prefixTokens: number; outputTokens?: number } {
	let prefixTokens = 0;
	const outputs: number[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
		if (!usage) continue;
		prefixTokens = Math.max(prefixTokens, (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
		if (usage.output) outputs.push(usage.output);
	}
	if (!prefixTokens) {
		// No usage recorded: a quarter of the transcript's characters is a serviceable
		// guess at the prompt size.
		const chars = messages.reduce((sum, message) => sum + JSON.stringify(message.content ?? "").length, 0);
		prefixTokens = Math.ceil(chars / 4);
	}
	// Undefined rather than a guess: the caller decides, since a longer piece of work
	// deserves a longer answer than the flat default.
	const outputTokens = outputs.length ? outputs.reduce((a, b) => a + b, 0) / outputs.length : undefined;
	return { prefixTokens, outputTokens };
}

function collect(
	ctx: ExtensionContext,
	labels: string[],
	profiles: Record<string, ManualProfile>,
	advertised: readonly Level[],
	priceFrom: readonly string[],
): Candidate[] {
	const registry = ctx.modelRegistry;
	const candidates: Candidate[] = [];
	for (const label of labels) {
		const slash = label.indexOf("/");
		const model = registry.find(label.slice(0, slash), label.slice(slash + 1));
		if (!model) continue;
		const own = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		// Subscription bridges and free routers publish no rates. Rather than treat those as
		// genuinely free, borrow the catalog price of the same model id from a provider that
		// does publish one, so cache writes still have to be paid for. Anything with no
		// counterpart stays at zero, which is what a free model should cost.
		const borrowed =
			!own.input && !own.output
				? priceFrom
						.map((provider) => registry.find(provider, model.id)?.cost)
						.find((cost): cost is NonNullable<typeof cost> => Boolean(cost?.input || cost?.output))
				: undefined;
		const rates = borrowed ?? own;
		const input = rates.input ?? 0;
		const output = rates.output ?? 0;
		// Providers quote cache rates per million tokens; fall back to the usual 0.1x read
		// and 1.25x write when a catalog omits them.
		const cacheRead = rates.cacheRead ?? input * 0.1;
		const cacheWrite = rates.cacheWrite ?? input * 1.25;
		candidates.push({
			label,
			model,
			levels: levelsOf(model, advertised),
			input,
			output,
			cacheRead,
			cacheWrite,
			blended: input + 3 * output,
			profile: profiles[label],
			pricedFrom: borrowed ? `${priceFrom.find((provider) => registry.find(provider, model.id)?.cost === borrowed)} catalog` : undefined,
			note: profiles[label]?.notes,
		});
	}
	return candidates;
}

/** Where a candidate's rates came from, when they were borrowed from another catalog. */
function rates(candidate: Candidate): string | undefined {
	return candidate.pricedFrom ? `${candidate.label} from the ${candidate.pricedFrom}` : undefined;
}

/** `provider/id` for a model object, matching the labels candidates are keyed by. */
function labelOf(model: { provider?: string; id?: string }): string {
	return `${model.provider ?? ""}/${model.id ?? ""}`;
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
			const profiles = profilesOption(options, "profiles");
			const maxCandidates = numberOption(options, "maxCandidates", 24);
			const taskChars = numberOption(options, "taskChars", 16_000);
			const tieMargin = numberOption(options, "tieMargin", 0.5);
			const stick = options.stick !== false;
			// horizon 0 means "ask Jev how long the work is"; a number pins it instead.
			const horizonSetting = numberOption(options, "horizon", 0);
			const horizonByLevel = listOption(options, "horizonByLevel", DEFAULT_HORIZON_BY_LEVEL.map(String)).map(Number);
			const downgradeMargin = numberOption(options, "downgradeMargin", 0.25);
			// Capability gain overrides price: a clearly better model takes over even from a
			// free one, since a cache write is cheap next to doing the work properly.
			const upgradeMargin = numberOption(options, "upgradeMargin", 0.25);
			const switchCostFactor = numberOption(options, "switchCostFactor", 1);
			const defaultOutputTokens = numberOption(options, "expectedOutputTokens", 2_000);
			// 3 rather than 1: with only the most recent precedent a short follow-up to a
			// three-turn task still read as multi-step, while showing the trivial question
			// answered in one turn alongside it dropped the same follow-up to one task.
			const historyPrompts = numberOption(options, "historyPrompts", 3);
			const record = options.record !== false;
			const notify = options.notify !== false;
			const debug = debugOn(options);
			const historyChars = numberOption(options, "historyChars", 240);
			// What to do when the catalog prices every candidate at zero, which is the case
			// for subscription bridges and free routers: there are no cache economics to
			// compare, so the policy decides whether fit alone moves the model.
			const zeroCostPolicy = (["stick", "switch", "aa"] as const).includes(options.zeroCostPolicy as never)
				? (options.zeroCostPolicy as "stick" | "switch" | "aa")
				: "stick";

			const enabled = enabledLabels(ctx).filter((label) => label !== `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`);
			const configured = listOption(options, "candidates", []);
			const labels = (configured.length ? configured : enabled).slice(0, maxCandidates);
			const priceFrom = listOption(options, "priceFrom", ["anthropic"]);
			const candidates = collect(ctx, labels, profiles, advertised, priceFrom);
			if (candidates.length === 0) {
				throw new Error(
					`jev-model-router: no candidate models. Set overrides["${EXTENSION}"].candidates or enable models with credentials.`,
				);
			}
			const fallback =
				candidates.find((candidate) => candidate.label === fallbackLabel)?.model ?? candidates[0].model;
			const priced = candidates.some((candidate) => candidate.input > 0 || candidate.output > 0);

			// Keep the turn together: continuation and retry stay on the same model so
			// prompt caches and thinking signatures survive.
			const previousLabel = request.previous ? labelOf(request.previous.model) : undefined;
			const keep = (model: { provider?: string; id?: string }, thinkingLevel: unknown, why: string) => {
				recordDecision(
					ctx,
					{
						task: "",
						history: [],
						reason: request.reason,
						previous: previousLabel,
						decided: { model: labelOf(model), level: String(thinkingLevel), why },
					},
					record,
					notify,
				);
				return { model: model as any, thinkingLevel: thinkingLevel as any };
			};
			if (request.reason === "continuation" && request.previous) {
				return keep(request.previous.model, request.previous.thinkingLevel, "continuation, kept for prompt cache");
			}
			if (request.reason === "retry" && request.failed) {
				return keep(request.failed.model, request.failed.thinkingLevel, "retry, kept on the failed model");
			}
			if (request.reason !== "user" || candidates.length < 2) {
				return keep(fallback, request.thinkingLevel, `${request.reason}, went to the fallback`);
			}

			const task = lastUserText(request.messages).slice(0, taskChars);
			const history = sessionHistory(request.messages, candidates, historyPrompts, historyChars).map(
				(record_) =>
					`"${record_.prompt}" took ${record_.turns} turn${record_.turns === 1 ? "" : "s"} on ${record_.models.join(", ")}, ` +
					`$${record_.cost < 0.01 ? record_.cost.toFixed(4) : record_.cost.toFixed(3)}${record_.estimated ? " estimated" : ""} ` +
					`and ${Math.round(record_.outputTokens)} output tokens`,
			);
			const state = [
				`Task:\n${task}`,
				"",
				...(history.length
					? ["Earlier prompts in this session, and what answering them actually took:", ...history.map((line) => `  ${line}`), ""]
					: []),
				"Candidate models:",
				...candidates.map(describe),
			].join("\n");
			// Depth is asked on the levels `jev/auto` advertises and then narrowed by name
			// to the winner's own levels. Intersecting them here instead would collapse the
			// question to "off" as soon as one candidate cannot think.
			const depthLevels = advertised.filter((level) => candidates.some((candidate) => candidate.levels.includes(level)));
			const depthCriteria = depthLevels.length ? depthLevels : (["off"] as Level[]);

			const hasAa = candidates.some((candidate) => effortLines(candidate.model, candidate.profile) !== undefined);
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
				questions.length = {
					type: "score",
					instructions:
						"How much work is this, from the user's side? Judge the whole piece of work rather than this one message: whether it ends with an answer, a single task, or something that takes several steps and turns to get right. Any earlier prompt listed with the turns it took is a precedent: a follow-up to a small piece of work is small, and a prompt like one that took many turns is not.",
					criteria: LENGTH_LEVELS,
				};
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
				const requested = depth?.type === "score" ? levelLabel(depth, depthCriteria) : "off";

				// How long the work is decides how many turns a cache write can be spread
				// over, which is what the stickiness rule weighs. Level 0 and 1 both mean this
				// turn is the whole thing, so the write can never pay for itself.
				const lengthIndex = argmaxIndex(result.answers.length, LENGTH_LEVELS);
				const horizon = horizonSetting > 0 ? horizonSetting : (horizonByLevel[lengthIndex] ?? 1);

				// Highest fit wins; models within tieMargin of it are treated as tied and the
				// cheapest of those takes it. Cost is what a task costs at the effort each
				// model would run at, which is what lets a cheap model win a task that does
				// not need a strong one.
				const { prefixTokens, outputTokens: measured } = turnSize(request.messages);
				// With no transcript to learn from, a longer piece of work gets a longer
				// first answer to divide by.
				const outputTokens = measured ?? defaultOutputTokens * horizon;
				const scored: Scored[] = candidates
					.map((candidate, index) => {
						const answer = result.answers[`fit_${index}`];
						const level = nearestLevel(requested, candidate.levels);
						const warmTurn = turnCost(candidate, prefixTokens, outputTokens, true);
						return {
							candidate,
							level,
							// What the tie-break compares. Dollars per task and dollars per
							// million tokens are not the same unit, so once any candidate has
							// real rates the comparison uses this turn's expected cost at the
							// effort the model would run at, which is the same arithmetic the
							// stickiness rule uses. Artificial Analysis per-task cost is the
							// fallback for when nothing is priced at all.
							cost: priced
								? warmTurn
								: (costAtLevel(candidate.model, level, true, candidate.profile) ?? candidate.blended),
							aaCost: costAtLevel(candidate.model, level, true, candidate.profile),
							fit: answer?.type === "score" ? answer.score : -1,
							warmTurn,
							coldTurn: turnCost(candidate, prefixTokens, outputTokens, false),
						};
					})
					.filter((entry) => entry.fit >= 0);
				if (scored.length === 0) return { model: fallback, thinkingLevel: request.thinkingLevel };
				const best = Math.max(...scored.map((entry) => entry.fit));
				const contenders = scored.filter((entry) => entry.fit >= best - tieMargin);
				const proposal = contenders.reduce((a, b) => (b.cost < a.cost ? b : a));
				let chosen = proposal;
				if (debug) {
					debugNotify(ctx, true, [
						`jev router: length ${LENGTH_LEVELS[lengthIndex]} -> horizon ${horizon}, ` +
							`turn ~${outputTokens} output tokens over a ${prefixTokens} token prompt. ` +
							contenders
								.map(
									(entry) =>
										`${entry.candidate.label}@${entry.level} fit ${entry.fit.toFixed(2)} ` +
										(priced
											? `$${entry.cost.toFixed(4)}/turn${entry.aaCost !== undefined ? ` ($${entry.aaCost.toFixed(2)}/task)` : ""}`
											: `$${entry.cost.toFixed(2)}/task`),
								)
								.join(", "),
					]);
				}

				// Stickiness. Switching models means writing a fresh prompt cache, so a cheaper
				// but weaker model only takes over if it saves more than that write over the
				// turns expected to follow. Staying is free: this pair's cache is already warm.
				const current = request.previous
					? scored.find((entry) => entry.candidate.label === labelOf(request.previous!.model))
					: undefined;
				let stuck = false;
				let stayedBecause = "";
				if (stick && zeroCostPolicy !== "switch" && !priced && current && chosen !== current) {
					// No prices anywhere: a cache write cannot be weighed against a saving.
					// "stick" keeps the warm pair, "aa" compares the Artificial Analysis cost
					// per task instead and only moves for a real saving.
					const upgrade = chosen.fit >= current.fit + upgradeMargin;
					const aaCheaper = zeroCostPolicy === "aa" && chosen.cost < current.cost;
					const smallEnough = current.fit - chosen.fit <= downgradeMargin;
					if (!upgrade && (!aaCheaper || !smallEnough)) {
						chosen = current;
						stuck = true;
						stayedBecause = !smallEnough
							? `the proposal was ${(current.fit - chosen.fit).toFixed(2)} behind on fit, more than the ${downgradeMargin} allowed`
							: `nothing is priced, so a cache write cannot be weighed against a saving (policy ${zeroCostPolicy})`;
					}
					if (debug) {
						debugNotify(ctx, true, [
							`jev router: no catalog prices, policy ${zeroCostPolicy}. Proposed ` +
								`${proposal.candidate.label}@${proposal.level} (fit ${proposal.fit.toFixed(2)}, ` +
								`$${proposal.cost.toFixed(2)}/task) against ${current.candidate.label}@${current.level} ` +
								`(fit ${current.fit.toFixed(2)}, $${current.cost.toFixed(2)}/task). ` +
								(stuck
									? `Staying on ${current.candidate.label}.`
									: `Switching to ${proposal.candidate.label}${upgrade ? " on capability" : ""}.`),
						]);
					}
				} else if (stick && priced && current && chosen !== current) {
					// Staying pays a warm cache read every turn. Switching writes the cache once
					// and is warm from then on, so both paths are totalled over the horizon: a long
					// turn amortises the write, a short one never does.
					const stayTotal = current.warmTurn * horizon;
					const writeCost = (prefixTokens / 1_000_000) * chosen.candidate.cacheWrite;
					const switchTotal =
						chosen.coldTurn + (horizon - 1) * chosen.warmTurn + (switchCostFactor - 1) * writeCost;
					const cheaperOverall = switchTotal < stayTotal;
					// A downgrade also has to be a small one. Capability is not priced here, so this
					// is the guard rail: a model that is meaningfully worse for this task stays put
					// however much it saves.
					const downgrade = current.fit - chosen.fit;
					const upgrade = -downgrade >= upgradeMargin;
					const smallEnough = downgrade <= downgradeMargin;
					if (!upgrade && (!cheaperOverall || !smallEnough)) {
						chosen = current;
						stuck = true;
						stayedBecause = !smallEnough
							? `the proposal was ${downgrade.toFixed(2)} behind on fit, more than the ${downgradeMargin} allowed`
							: `the switch cost $${writeCost.toFixed(4)} to write the cache and saved $${(stayTotal - switchTotal).toFixed(4)} over ${horizon} turn(s)`;
					}
					if (debug) {
						debugNotify(ctx, true, [
							`jev router: length ${LENGTH_LEVELS[lengthIndex]} -> horizon ${horizon}. ` +
							`Proposed ${proposal.candidate.label}@${proposal.level} (fit ${proposal.fit.toFixed(2)}, ` +
								`$${switchTotal.toFixed(4)} over ${horizon} turn(s)) against ${current.candidate.label}@${current.level} ` +
								`(fit ${current.fit.toFixed(2)}, $${stayTotal.toFixed(4)} warm, $${writeCost.toFixed(4)} to write the cache). ` +
								(stuck
									? `Staying on ${current.candidate.label}.`
									: `Switching to ${proposal.candidate.label}${upgrade ? " on capability" : ""}.`) +
								(rates(current.candidate) || rates(proposal.candidate)
									? ` Borrowed rates: ${[rates(current.candidate), rates(proposal.candidate)].filter(Boolean).join(" and ")}.`
									: ""),
						]);
					}
				}
				// Say what happened to the model, not what happened to the proposal: the
				// proposal is only a candidate for the change, and the change is measured
				// against the model that was actually in use.
				const why = !current
					? "first turn, nothing to stay on"
					: chosen === current && proposal === current
						? "the current model was Jev's pick anyway"
						: chosen === current
							? `stayed: ${stayedBecause || "the proposal was not better"}`
							: "switched to Jev's pick, which won on fit and price";
				recordDecision(
					ctx,
					{
						task,
						history,
						reason: request.reason,
						previous: previousLabel,
						length: { level: LENGTH_LEVELS[lengthIndex], score: result.answers.length?.score, horizon },
						depth: { level: requested, score: result.answers.depth?.score },
						turn: { promptTokens: prefixTokens, outputTokens },
						candidates: scored.map((entry) => ({
							label: entry.candidate.label,
							level: entry.level,
							fit: Math.round(entry.fit * 1000) / 1000,
							...(entry.aaCost !== undefined ? { aaCostPerTask: entry.aaCost } : {}),
							costBasis: entry.cost,
							warmTurn: Math.round(entry.warmTurn * 10000) / 10000,
							coldTurn: Math.round(entry.coldTurn * 10000) / 10000,
							...(entry.candidate.pricedFrom ? { ratesFrom: entry.candidate.pricedFrom } : {}),
						})),
						decided: { model: chosen.candidate.label, level: chosen.level, why },
						answers: recordAnswers(result),
					},
					record,
					notify,
				);
				return { model: chosen.candidate.model, thinkingLevel: chosen.level };
			} catch (error) {
				debugNotify(ctx, debug, [`jev router error: ${(error as Error).message}`]);
				return keep(fallback, request.thinkingLevel, `routing failed: ${(error as Error).message}`);
			}
		},
	});
}

/**
 * The winning level of a score answer, as a label.
 *
 * Endpoints disagree on what the probability keys are. open-jev keys them by criterion
 * index and puts the labels in `legend`; the hosted API keys them by label. Reading the
 * key as a label made every depth answer come back as a number, which silently collapsed
 * the depth choice onto the lowest level a model supported.
 */
function winningLabel(answer: ScoreAnswerish | undefined, criteria: readonly string[]): string {
	const entries = Object.entries(answer?.probabilities ?? {});
	if (entries.length) {
		const [key] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
		const legend = answer?.legend ?? {};
		const fromLegend = typeof legend[key] === "string" ? (legend[key] as string) : undefined;
		if (fromLegend && criteria.includes(fromLegend)) return fromLegend;
		const index = Number(key);
		if (Number.isInteger(index) && criteria[index]) return criteria[index];
		if (criteria.includes(key)) return key;
	}
	const mean = answer?.score ?? 0;
	const index = Math.max(0, Math.min(criteria.length - 1, Math.round(mean)));
	return criteria[index] ?? "off";
}

interface ScoreAnswerish {
	type?: string;
	probabilities?: Record<string, number>;
	legend?: Record<string, unknown>;
	score?: number;
}

/** Index of the winning level within `criteria`. */
function argmaxIndex(answer: ScoreAnswerish | undefined, criteria: readonly string[]): number {
	const label = winningLabel(answer, criteria);
	const index = criteria.indexOf(label);
	if (index >= 0) return index;
	const mean = answer?.score ?? 0;
	return Math.max(0, Math.min(criteria.length - 1, Math.round(mean)));
}

/** The score answer's winning level, falling back to rounding its mean index. */
/**
 * Debug output goes through the UI, never stderr: pi's TUI owns the terminal and writing
 * to stderr behind its back corrupts the display. Set `debug` in settings or
 * PI_JEV_ROUTER_DEBUG=1 to see the arithmetic.
 */
function debugOn(options: Record<string, unknown>): boolean {
	return options.debug === true || Boolean(process.env.PI_JEV_ROUTER_DEBUG);
}

function debugNotify(ctx: ExtensionContext, on: boolean, lines: string[]): void {
	if (!on) return;
	try {
		ctx.ui.notify(lines.join("\n"), "info");
	} catch {
		// No UI attached, and stderr would corrupt the TUI.
	}
}

/** Where a decision is written down, for reading back out of the session file. */
const ENTRY_TYPE = "jev-model-router.decision";

/** Compact the answers so a session file stays readable and small. */
function recordAnswers(result: { answers: Record<string, any> }): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [id, answer] of Object.entries(result.answers ?? {})) {
		const probabilities: Record<string, number> = {};
		for (const [label, value] of Object.entries(answer.probabilities ?? {})) {
			probabilities[label] = Math.round(Number(value) * 1000) / 1000;
		}
		out[id] =
			answer.type === "noul"
				? { type: "noul", noul: Math.round(Number(answer.noul) * 1000) / 1000 }
				: {
						type: answer.type,
						...(answer.type === "choice" ? { choice: answer.choice } : { score: answer.score }),
						...(Object.keys(probabilities).length ? { probabilities } : {}),
					};
	}
	return out;
}

/**
 * Write one decision to the session and, when the model actually changed, say so.
 *
 * The entry holds what Jev was asked and what it said, so a routing choice can be
 * reconstructed from the session file afterwards. Data-only custom entries are not sent
 * to the model, so this costs no context.
 */
function recordDecision(
	ctx: ExtensionContext,
	record_: {
		task: string;
		history: string[];
		reason: string;
		length?: { level: string; score?: number; horizon: number };
		depth?: { level: string; score?: number };
		candidates?: unknown[];
		decided: { model: string; level: string; why: string };
		previous?: string;
		elapsedMs?: number;
		answers?: Record<string, unknown>;
		fallback?: string;
	},
	recordEnabled: boolean,
	notifyEnabled: boolean,
): void {
	const payload = { at: new Date().toISOString(), ...record_ };
	if (recordEnabled) {
		try {
			ctx.appendEntry(ENTRY_TYPE, payload);
		} catch {
			// Recording is a convenience; never let it fail a request.
		}
	}
	const switched = record_.previous !== undefined && record_.previous !== record_.decided.model;
	if (!notifyEnabled || !switched) return;
	const { model, level, why } = record_.decided;
	const length = record_.length ? `${record_.length.level}, horizon ${record_.length.horizon}` : "length unknown";
	try {
		ctx.ui.notify(
			`jev: ${record_.previous} -> ${model} @ ${level}\n${why}. Length: ${length}. Full record in this session's ${ENTRY_TYPE} entries.`,
			"info",
		);
	} catch {
		// No UI attached, nothing to say.
	}
}

function levelLabel(answer: { probabilities: Record<string, number>; score: number }): string {
	const entries = Object.entries(answer.probabilities ?? {});
	if (entries.length) {
		const [label] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
		if (label) return label;
	}
	return ALL_LEVELS[Math.max(0, Math.min(ALL_LEVELS.length - 1, Math.round(answer.score)))] ?? "off";
}

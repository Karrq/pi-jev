/**
 * jev-model-router: a virtual model that lets Jev pick the physical model.
 *
 * Registers `jev/auto` (provider `jev`, id `auto`). Select it like any other
 * model, put it in `defaultModel` or `enabledModels`, and every request is routed:
 * Jev reads the latest user message and chooses which enabled model handles it, plus
 * a thinking level. Because the choice happens inside a virtual model, subagents and
 * any allowlist that names models work unchanged: they just see `jev/auto`.
 *
 * Routing rules:
 * - `user` requests are routed by Jev. The state holds the candidate list and the
 *   last user message, and the questions are which model fits, how much reasoning
 *   depth it needs, and whether the cheapest candidate is enough.
 * - `continuation` and `retry` stay on the model that handled the turn, which keeps
 *   prompt caches and thinking signatures valid.
 * - `direct` requests (compaction summaries, extension calls) go to `fallback`.
 * - If Jev is unreachable or returns nothing usable, `fallback` answers instead.
 *
 * Settings: overrides["jev-model-router"] = {
 *   fallback, candidates, thinkingLevels, maxCandidates }
 *
 * Toggle: "+extensions/model-router.ts" in the package's extension list.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { listOption, numberOption, stringOption } from "../src/shared.ts";

const EXTENSION = "jev-model-router";

const VIRTUAL_PROVIDER = "jev";
const VIRTUAL_ID = "auto";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof THINKING_LEVELS)[number];

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Enabled physical models, as `provider/id`, ignoring the virtual one. */
function physicalModels(ctx: ExtensionContext, exclude: { provider: string; id: string }): string[] {
	const models = ctx.getScopedModels?.() ?? [];
	const ids = models
		.map((entry: any) => {
			const provider = entry.provider ?? entry.model?.provider ?? "";
			const id = entry.id ?? entry.modelId ?? entry.model?.id ?? "";
			return { provider, id, label: provider && id ? `${provider}/${id}` : "" };
		})
		.filter((entry) => entry.label && !(entry.provider === exclude.provider && entry.id === exclude.id));
	return [...new Set(ids.map((entry) => entry.label))];
}

function findModel(ctx: ExtensionContext, label: string) {
	const slash = label.indexOf("/");
	const provider = label.slice(0, slash);
	const id = label.slice(slash + 1);
	return ctx.modelRegistry.find(provider, id);
}

/** Pick the closest allowed thinking level to what Jev asked for. */
function nearestLevel(requested: number, allowed: Level[]): Level {
	const clamped = Math.max(0, Math.min(THINKING_LEVELS.length - 1, Math.round(requested)));
	return allowed[clamped] ?? allowed[allowed.length - 1];
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel({
		provider: VIRTUAL_PROVIDER,
		id: VIRTUAL_ID,
		name: "Auto (Jev)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		async route(request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> {
			// Options can only be read from a context, and route() does not get one
			// until a session starts, so read them through the model registry's ctx.
			const { options } = resolve(ctx.cwd ?? process.cwd(), EXTENSION, ctx.isProjectTrusted());
			const fallbackLabel = stringOption(options, "fallback", "");
			const allowed = listOption(options, "thinkingLevels", ["off", "low", "medium", "high", "xhigh"]) as Level[];
			const configured = listOption(options, "candidates", []);
			const maxCandidates = numberOption(options, "maxCandidates", 24);

			const candidates = (configured.length ? configured : physicalModels(ctx, { provider: VIRTUAL_PROVIDER, id: VIRTUAL_ID })).slice(0, maxCandidates);
			const fallback = fallbackLabel || candidates[0];
			if (!fallback) throw new Error(`jev-model-router: no candidate models. Set overrides["${EXTENSION}"].fallback or enable models.`);

			// Keep the turn together: continuation and retry stay on the same model so
			// prompt caches and thinking signatures survive.
			if (request.reason === "continuation" && request.previous) {
				return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel };
			}
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel };
			}
			if (request.reason !== "user" || candidates.length < 2) {
				const model = findModel(ctx, fallback);
				if (!model) throw new Error(`jev-model-router: ${fallback} is not in the model catalog`);
				return { model, thinkingLevel: request.thinkingLevel };
			}

			const task = lastUserText(request.messages).slice(0, 16_000);
			try {
				const { endpoint } = resolve(ctx.cwd ?? process.cwd(), EXTENSION, ctx.isProjectTrusted());
				const result = await systemOne(
					endpoint,
					`Task:\n${task}\n\nCandidate models:\n${candidates.map((c, i) => `[${i}] ${c}`).join("\n")}`,
					{
						model: {
							type: "choice",
							instructions: "Which candidate model should handle this task?",
							criteria: Object.fromEntries(candidates.map((candidate) => [candidate, candidate])),
						},
						depth: {
							type: "score",
							instructions: "How much reasoning depth does this task need?",
							criteria: THINKING_LEVELS as unknown as string[],
						},
						cheapest_enough: {
							type: "noul",
							instructions: "Can the smallest and cheapest candidate handle this task well enough?",
							criteria: {
								true: "The smallest candidate is good enough; capability is not the bottleneck.",
								false: "The task needs a stronger model to do it properly.",
							},
						},
					},
					{ signal: request.signal },
				);

				const chosen = result.answers.model.type === "choice" ? result.answers.model.choice : undefined;
				const label = chosen && candidates.includes(chosen) ? chosen : fallback;
				const model = findModel(ctx, label);
				if (!model) throw new Error(`${label} is not in the model catalog`);

				const depth = result.answers.depth.type === "score" ? result.answers.depth.score : 2;
				const thinkingLevel = nearestLevel(depth, allowed);
				return { model, thinkingLevel };
			} catch (error) {
				const model = findModel(ctx, fallback);
				if (!model) throw error;
				return { model, thinkingLevel: request.thinkingLevel };
			}
		},
	});
}
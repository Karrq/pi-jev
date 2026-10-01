/**
 * jev-model-router: pick which model should handle a task.
 *
 * The state is the task description plus the candidate list (the models pi has
 * enabled, unless you pass your own), and the questions are which model fits,
 * how much reasoning depth it needs, and whether the cheap model is enough. The
 * router only advises: the tool returns the pick, and `/jev-route --apply` switches
 * the session's model.
 *
 * Settings: overrides["jev-model-router"] = { maxCandidates, thinkingLevels, alwaysApply }
 *
 * Toggle: "+extensions/model-router.ts" in the package's extension list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { formatAnswer } from "../src/types.ts";
import { failure, listOption, numberOption, text } from "../src/shared.ts";

const EXTENSION = "jev-model-router";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const RouteParams = Type.Object({
	task: Type.String({ description: "What the model has to do" }),
	candidates: Type.Optional(
		Type.Array(Type.String(), {
			description: "Model ids to choose from (default: the models pi has enabled)",
		}),
	),
	constraints: Type.Optional(
		Type.String({ description: "Extra facts the choice must respect, e.g. 'no network, 30s budget'" }),
	),
	apply: Type.Optional(Type.Boolean({ description: "Switch the session model when a candidate matches (default false)" })),
});

/** Model ids pi can actually switch to, in the form pi uses (provider/id). */
function sessionCandidates(ctx: any): string[] {
	const models = ctx.getScopedModels?.() ?? [];
	const ids = models
		.map((entry: any) => (typeof entry === "string" ? entry : `${entry.provider ?? ""}/${entry.id ?? entry.modelId ?? ""}`))
		.filter((id: string) => id && id !== "/");
	return [...new Set(ids)];
}

export default function (pi: ExtensionAPI) {
	async function route(task: string, candidates: string[], constraints: string | undefined, ctx: any, signal?: AbortSignal) {
		const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
		const state = [
			`Task: ${task}`,
			constraints ? `Constraints: ${constraints}` : undefined,
			`Candidate models:\n${candidates.map((id, index) => `[${index}] ${id}`).join("\n")}`,
		]
			.filter(Boolean)
			.join("\n\n");
		const criteria: Record<string, string> = {};
		candidates.forEach((id) => (criteria[id] = id));
		const levels = listOption(options, "thinkingLevels", THINKING_LEVELS).filter((level) => THINKING_LEVELS.includes(level));
		const questions: Parameters<typeof systemOne>[2] = {
			model: {
				type: "choice",
				instructions: "Which candidate model should handle this task?",
				criteria,
			},
			depth: {
				type: "score",
				instructions: "How much reasoning depth does this task need?",
				criteria: levels.length >= 2 ? levels : ["low", "high"],
			},
			cheapest_enough: {
				type: "noul",
				instructions: "Can the smallest and cheapest candidate handle this task well enough?",
				criteria: {
					true: "The smallest candidate is good enough; quality is not the bottleneck.",
					false: "The task needs a stronger model to do it properly.",
				},
			},
		};
		const result = await systemOne(endpoint, state, questions, { signal });
		const pick = result.answers.model.type === "choice" ? result.answers.model.choice : candidates[0];
		const depth = result.answers.depth.type === "score" ? result.answers.depth : undefined;
		return { endpoint, result, pick, depth, candidates };
	}

	function report(result: Awaited<ReturnType<typeof route>>, apply: boolean, applied: string | undefined) {
		const lines = [
			`recommended: ${result.pick} (${formatAnswer(result.result.answers.model)})`,
			`depth: ${result.depth ? formatAnswer(result.depth) : "unknown"}`,
			`cheapest enough: ${formatAnswer(result.result.answers.cheapest_enough)}`,
			`[jev ${result.endpoint.name} ${result.result.elapsedMs}ms]`,
		];
		if (apply) lines.push(applied ? `session model: ${applied}` : "session model unchanged (candidate not available)");
		return lines.join("\n");
	}

	pi.registerTool({
		name: "jev_route",
		label: "Jev Model Router",
		description:
			"Choose which model should handle a task from the candidates pi has enabled, using System One. Returns the " +
			"recommended model id, a reasoning-depth level, and whether the cheapest candidate suffices.",
		promptSnippet: "Pick the best available model for a task with System One",
		parameters: RouteParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const maxCandidates = numberOption(resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted()).options, "maxCandidates", 24);
			const candidates = (params.candidates ?? sessionCandidates(ctx)).slice(0, maxCandidates);
			if (candidates.length < 2) {
				return text(`jev router needs at least 2 candidates, got ${candidates.length}.`);
			}
			try {
				const routed = await route(params.task, candidates, params.constraints, ctx, ctx.signal);
				const apply = params.apply ?? false;
				let applied: string | undefined;
				if (apply) applied = await switchModel(routed.pick, ctx);
				return {
					...text(report(routed, apply, applied)),
					details: {
						task: params.task,
						candidates,
						recommended: routed.pick,
						applied,
						answers: routed.result.answers,
						elapsedMs: routed.result.elapsedMs,
						endpoint: routed.endpoint.name,
					},
				};
			} catch (error) {
				return failure(resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted()).endpoint, error);
			}
		},
	});

	pi.registerCommand("jev-route", {
		description: "Route the last user message to a model; --apply switches the session model",
		handler: async (args, ctx) => {
			const apply = /\b--apply\b/.test(args);
			const branch = ctx.sessionManager.getBranch();
			const lastUser = [...branch].reverse().find(
				(entry) => entry.type === "message" && entry.message.role === "user",
			);
			const task =
				(lastUser?.type === "message" && lastUser.message.role === "user"
					? lastUser.message.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					: "") || args.replace("--apply", "").trim();
			if (!task) {
				ctx.ui.notify("nothing to route: no user message and no argument", "error");
				return;
			}
			const candidates = sessionCandidates(ctx);
			if (candidates.length < 2) {
				ctx.ui.notify(`jev router needs at least 2 candidate models, found ${candidates.length}`, "error");
				return;
			}
			try {
				const routed = await route(task, candidates, undefined, ctx);
				const applied = apply ? await switchModel(routed.pick, ctx) : undefined;
				ctx.ui.notify(report(routed, apply, applied), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	/** Switch the session model when the router's pick is one pi has loaded. */
	async function switchModel(pick: string, ctx: any): Promise<string | undefined> {
		const models: any[] = ctx.getScopedModels?.() ?? [];
		const match = models.find((entry: any) => {
			const id = typeof entry === "string" ? entry : `${entry.provider ?? ""}/${entry.id ?? entry.modelId ?? ""}`;
			return id === pick;
		});
		const model = match?.model ?? match;
		if (!model || typeof ctx.setModel !== "function") return undefined;
		const ok = await ctx.setModel(model);
		return ok ? pick : undefined;
	}
}
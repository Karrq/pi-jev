/**
 * jev-decider: the general-purpose System One decision tool.
 *
 * Give it any state (tool output, a transcript excerpt, a document, a diff) and a
 * set of typed questions; it answers all of them in one request with no generation
 * on the server. This is the extension to load when none of the specialised ones
 * fit: routing, triage, "is this answer supported by the log", and so on.
 *
 * Settings (settings.json, "pi-jev"):
 *   endpoint / endpoints / url / model / apiKeyEnv / timeoutMs   (see src/config.ts)
 *   overrides["jev-decider"].maxQuestions                        (default 32)
 *   overrides["jev-decider"].maxStateChars                       (default 200000)
 *
 * Toggle it by adding or removing "+extensions/decider.ts" from the package's
 * extension list in settings.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { formatAnswer, type JevQuestion, type QuestionType } from "../src/types.ts";
import { endpointLine, failure, numberOption, text } from "../src/shared.ts";

const EXTENSION = "jev-decider";

const QuestionSpec = Type.Object({
	id: Type.Optional(Type.String({ description: "Key for the answer; defaults to q1, q2, ..." })),
	instructions: Type.String({ description: "What to decide about the state" }),
	type: Type.Optional(
		Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")], {
			description: "noul = yes/no probability (default), choice = pick a label, score = ordered level",
		}),
	),
	criteria: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"choice: labels, optionally 'label: description'. score: ordered levels. Ignored for noul.",
		}),
	),
});

const DecideParams = Type.Object({
	state: Type.String({ description: "The text every question is answered against" }),
	questions: Type.Array(QuestionSpec, { minItems: 1, description: "Typed questions to answer about the state" }),
	model: Type.Optional(Type.String({ description: "Override the model for this call" })),
});

interface Spec {
	id?: string;
	instructions: string;
	type?: QuestionType;
	criteria?: string[];
}

/**
 * Turn the tool's question list into the API's typed questions.
 *
 * Labels accept "label: description" so a choice question can carry option text
 * without a nested object in the schema.
 */
export function buildQuestions(specs: Spec[], maxQuestions: number): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	specs.slice(0, maxQuestions).forEach((spec, index) => {
		const id = spec.id?.trim() || `q${index + 1}`;
		const instructions = spec.instructions.trim();
		if (!instructions) throw new Error(`question ${id} has no instructions`);
		const criteria = spec.criteria?.map((c) => c.trim()).filter(Boolean) ?? [];
		if (spec.type === "choice") {
			if (criteria.length < 2) throw new Error(`choice question ${id} needs at least 2 criteria`);
			const entries: Record<string, string> = {};
			for (const entry of criteria) {
				const colon = entry.indexOf(":");
				if (colon > 0) entries[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
				else entries[entry] = entry;
			}
			questions[id] = { type: "choice", instructions, criteria: entries };
		} else if (spec.type === "score") {
			if (criteria.length < 2) throw new Error(`score question ${id} needs at least 2 criteria`);
			questions[id] = { type: "score", instructions, criteria };
		} else {
			questions[id] = { type: "noul", instructions };
		}
	});
	return questions;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev_decide",
		label: "Jev Decide",
		description:
			"Answer typed yes/no, choice and score questions about a block of text in one request (System One). " +
			"Use for triage, routing, or checking claims against a log: the state is read once and every question is " +
			"answered from it without generating text.",
		promptSnippet: "Answer typed questions about a block of text in one pass (System One)",
		parameters: DecideParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const maxQuestions = numberOption(options, "maxQuestions", 32);
			const maxStateChars = numberOption(options, "maxStateChars", 200_000);
			try {
				const state = params.state.length > maxStateChars ? params.state.slice(0, maxStateChars) : params.state;
				const questions = buildQuestions(params.questions as Spec[], maxQuestions);
				const result = await systemOne(endpoint, state, questions, { signal, model: params.model });
				const lines = Object.entries(result.answers).map(([id, answer]) => `${id}: ${formatAnswer(answer)}`);
				const truncated = state.length < params.state.length ? `\n(state truncated to ${state.length} chars)` : "";
				const skipped = params.questions.length > maxQuestions ? `\n(${maxQuestions} question limit)` : "";
				const header = `[jev ${result.endpoint} ${result.elapsedMs}ms, ${result.usage.input_tokens ?? "?"} input tokens]${truncated}${skipped}`;
				return {
					...text([header, "", ...lines].join("\n")),
					details: {
						answers: result.answers,
						usage: result.usage,
						elapsedMs: result.elapsedMs,
						endpoint: result.endpoint,
						model: result.model,
						stateChars: state.length,
						truncated: state.length < params.state.length,
					},
				};
			} catch (error) {
				return failure(endpoint, error);
			}
		},
	});

	pi.registerCommand("jev", {
		description: "Show the pi-jev endpoint, or decide a yes/no question about a string",
		handler: async (args, ctx) => {
			const { endpoint, sources } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const question = args.trim();
			if (!question) {
				ctx.ui.notify(endpointLine(endpoint, sources), "info");
				return;
			}
			const branch = ctx.sessionManager.getBranch();
			const lastUser = [...branch].reverse().find(
				(entry) => entry.type === "message" && entry.message.role === "user",
			);
			const state =
				lastUser?.type === "message" && lastUser.message.role === "user"
					? lastUser.message.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					: question;
			try {
				const result = await systemOne(endpoint, state || question, {
					q1: { type: "noul", instructions: question },
				});
				ctx.ui.notify(formatAnswer(result.answers.q1), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
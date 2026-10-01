/**
 * jev-dropper: decide which items in a pool are still worth keeping.
 *
 * The state is the numbered pool (up to ~20k tokens) and each item gets three
 * questions in one request: is it still needed for the stated goal, is it a
 * near-duplicate of an earlier item, and how important is it. Everything is
 * prefilled once on the server, so 200 items x 3 questions is one prefill and a
 * few seconds of question work.
 *
 * Settings: overrides["jev-dropper"] = { keepAt, duplicateAt, maxItems,
 * maxStateChars, includeImportance }
 *
 * Toggle: "+extensions/dropper.ts" in the package's extension list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { noulProbability, topLabel, type JevAnswer, type JevQuestion } from "../src/types.ts";
import { failure, numberOption, text } from "../src/shared.ts";

const EXTENSION = "jev-dropper";

const DropParams = Type.Object({
	goal: Type.String({ description: "What the pool is for; every question is judged against this" }),
	items: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ description: "Stable id; defaults to the item's index" })),
			text: Type.String({ description: "The item's text" }),
		}),
		{ minItems: 1, description: "Pool items to triage" },
	),
	keepAt: Type.Optional(Type.Number({ description: "Keep an item when P(still needed) is at least this (default 0.5)" })),
	duplicateAt: Type.Optional(Type.Number({ description: "Flag an item as a duplicate at or above this (default 0.8)" })),
});

interface ItemVerdict {
	id: string;
	keep: boolean;
	keepProbability: number;
	duplicate: boolean;
	duplicateProbability: number;
	importance?: { level: string; mean: number };
}

function renderPool(goal: string, items: { id: string; text: string }[]): string {
	const body = items.map((item, index) => `[item ${index} (${item.id})]\n${item.text}`).join("\n\n");
	return `Goal: ${goal}\n\nPool:\n${body}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev_drop",
		label: "Jev Dropper",
		description:
			"Triage a pool of observations or notes against a goal: returns keep/drop per item with probabilities, " +
			"duplicate detection and an importance level. One request for the whole pool (System One).",
		promptSnippet: "Triage a pool of items against a goal, with keep/drop probabilities",
		parameters: DropParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const maxItems = numberOption(options, "maxItems", 200);
			const maxStateChars = numberOption(options, "maxStateChars", 80_000);
			const includeImportance = options.includeImportance !== false;
			const keepAt = params.keepAt ?? numberOption(options, "keepAt", 0.5);
			const duplicateAt = params.duplicateAt ?? numberOption(options, "duplicateAt", 0.8);

			try {
				const items = params.items.slice(0, maxItems).map((item, index) => ({
					id: item.id?.trim() || String(index),
					text: item.text,
				}));
				let state = renderPool(params.goal, items);
				let truncated = false;
				if (state.length > maxStateChars) {
					truncated = true;
					state = state.slice(0, maxStateChars);
				}

				const questions: Record<string, JevQuestion> = {};
				// No criteria on the yes/no questions: with them, Gemma 4 answered
				// "not needed" for every item regardless of content, while the plain
				// question kept the items that matter and dropped the rest.
				items.forEach((item, index) => {
					questions[`keep_${index}`] = {
						type: "noul",
						instructions: `Is item ${index} (${item.id}) still needed for the goal: ${params.goal}?`,
					};
					questions[`dup_${index}`] = {
						type: "noul",
						instructions: `Does item ${index} (${item.id}) repeat content that an earlier item already states?`,
					};
					if (includeImportance) {
						questions[`imp_${index}`] = {
							type: "score",
							instructions: `How important is item ${index} (${item.id}) for the goal: ${params.goal}?`,
							criteria: ["irrelevant", "minor", "useful", "important", "critical"],
						};
					}
				});

				onUpdate?.({
					content: [{ type: "text", text: `Asking about ${items.length} items...` }],
					details: { items: items.length, questions: Object.keys(questions).length },
				});

				const result = await systemOne(endpoint, state, questions, { signal });
				const answers = result.answers as Record<string, JevAnswer>;

				const verdicts: ItemVerdict[] = items.map((item, index) => {
					const keep = noulProbability(answers[`keep_${index}`]);
					const duplicateProbability = noulProbability(answers[`dup_${index}`]);
					const duplicate = duplicateProbability >= duplicateAt;
					const importanceAnswer = answers[`imp_${index}`];
					return {
						id: item.id,
						keep: keep >= keepAt && !duplicate,
						keepProbability: keep,
						duplicate,
						duplicateProbability,
						importance: importanceAnswer
							? { level: topLabel(importanceAnswer).label, mean: importanceAnswer.type === "score" ? importanceAnswer.score : 0 }
							: undefined,
					};
				});

				const kept = verdicts.filter((v) => v.keep);
				const dropped = verdicts.filter((v) => !v.keep);
				const keptChars = kept.reduce((sum, v) => sum + (items.find((i) => i.id === v.id)?.text.length ?? 0), 0);
				const totalChars = items.reduce((sum, i) => sum + i.text.length, 0);

				const lines = verdicts.map((v) => {
					const bits = [
						`${v.keep ? "KEEP" : "DROP"} ${v.id}`,
						`P(needed)=${v.keepProbability.toFixed(2)}`,
						v.duplicate ? `duplicate(${v.duplicateProbability.toFixed(2)})` : null,
						v.importance ? `${v.importance.level} (${v.importance.mean.toFixed(1)})` : null,
					].filter(Boolean);
					return bits.join("  ");
				});
				const header = `[jev drop ${result.endpoint} ${result.elapsedMs}ms] ${kept.length} kept, ${dropped.length} dropped, ${keptChars}/${totalChars} chars kept${
					truncated ? `, state truncated at ${maxStateChars} chars` : ""
				}${params.items.length > maxItems ? `, item limit ${maxItems}` : ""}`;

				return {
					...text([header, "", ...lines].join("\n")),
					details: {
						goal: params.goal,
						keepAt,
						duplicateAt,
						verdicts,
						kept: kept.map((v) => v.id),
						dropped: dropped.map((v) => v.id),
						usage: result.usage,
						elapsedMs: result.elapsedMs,
						endpoint: result.endpoint,
						answers,
					},
				};
			} catch (error) {
				return failure(endpoint, error);
			}
		},
	});

	pi.registerCommand("jev-drop", {
		description: "Explain the dropper's thresholds and endpoint",
		handler: async (_args, ctx) => {
			const { endpoint, options, sources } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			ctx.ui.notify(
				[
					`endpoint ${endpoint.name} -> ${endpoint.url}`,
					`keepAt ${numberOption(options, "keepAt", 0.5)}, duplicateAt ${numberOption(options, "duplicateAt", 0.8)}`,
					`maxItems ${numberOption(options, "maxItems", 200)}, maxStateChars ${numberOption(options, "maxStateChars", 80_000)}`,
					`settings: ${sources.join(", ") || "none found"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
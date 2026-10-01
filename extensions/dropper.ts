/**
 * jev-dropper: decide which items in a pool are still worth keeping.
 *
 * The state is the numbered pool (up to ~20k tokens) and each item gets three
 * questions in one request: is it still needed for the stated goal, is it a
 * near-duplicate of an earlier item, and how important is it. Everything is
 * prefilled once on the server, so 200 items x 3 questions is one prefill and a
 * few seconds of question work.
 *
 * Two ways in. The model calls `jev_drop` with the items it has. You run
 * `/jev-drop <goal>` to triage the observation pool pi-observational-memory has
 * recorded in this session, without writing anything back to it.
 *
 * Settings: overrides["jev-dropper"] = { keepAt, duplicateAt, maxItems,
 * maxStateChars, includeImportance }
 *
 * Toggle: "+extensions/dropper.ts" in the package's extension list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { formatDrop, readObservationPool, runDrop } from "../src/drop.ts";
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev_drop",
		label: "Jev Dropper",
		description:
			"Triage a pool of observations or notes against a goal: returns keep/drop per item with probabilities, " +
			"duplicate detection and an importance level. One request for the whole pool (System One).",
		promptSnippet: "Triage a pool of items against a goal, with keep/drop probabilities",
		parameters: DropParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			try {
				const items = params.items.map((item, index) => ({ id: item.id?.trim() || String(index), text: item.text }));
				const result = await runDrop(
					endpoint,
					params.goal,
					items,
					{
						keepAt: params.keepAt ?? numberOption(options, "keepAt", 0.5),
						duplicateAt: params.duplicateAt ?? numberOption(options, "duplicateAt", 0.8),
						includeImportance: options.includeImportance !== false,
						maxItems: numberOption(options, "maxItems", 200),
						maxStateChars: numberOption(options, "maxStateChars", 80_000),
						model: typeof options.model === "string" ? options.model : undefined,
					},
					signal,
				);
				return {
					...text(formatDrop(result, params.goal)),
					details: {
						goal: params.goal,
						verdicts: result.verdicts,
						kept: result.kept,
						dropped: result.dropped,
						usage: result.usage,
						elapsedMs: result.elapsedMs,
						endpoint: result.endpoint,
					},
				};
			} catch (error) {
				return failure(endpoint, error);
			}
		},
	});

	pi.registerCommand("jev-drop", {
		description: "Triage the session's observation pool against a goal: /jev-drop <goal>",
		handler: async (args, ctx) => {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify(
					[
						"usage: /jev-drop <goal>",
						"",
						"Scores every observation pi-observational-memory has recorded in this session against the goal",
						"and prints keep/drop per item. Nothing is written back to memory.",
						"",
						`endpoint ${endpoint.name} -> ${endpoint.url}`,
						`keepAt ${numberOption(options, "keepAt", 0.5)}, duplicateAt ${numberOption(options, "duplicateAt", 0.8)}`,
					].join("\n"),
					"info",
				);
				return;
			}
			const pool = readObservationPool(ctx.sessionManager.getBranch());
			if (pool.length === 0) {
				ctx.ui.notify(
					"No observations found in this session. pi-observational-memory records them as it observes, or run it in a session that has some.",
					"error",
				);
				return;
			}
			try {
				const result = await runDrop(
					endpoint,
					goal,
					pool.map((observation) => ({ id: observation.id, text: observation.content })),
					{
						keepAt: numberOption(options, "keepAt", 0.5),
						duplicateAt: numberOption(options, "duplicateAt", 0.8),
						maxItems: numberOption(options, "maxItems", 200),
						maxStateChars: numberOption(options, "maxStateChars", 80_000),
					},
					ctx.signal,
				);
				ctx.ui.notify(formatDrop(result, goal), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
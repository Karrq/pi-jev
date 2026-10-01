/**
 * The pool triage both the jev_drop tool and the /jev-drop command run.
 *
 * One request for the whole pool: the state is the numbered pool, and every item
 * gets the same three questions. Kept separate from the extension so the slash
 * command can reuse it against a live pi-observational-memory pool.
 */

import { resolve, type ResolvedEndpoint } from "./config.ts";
import { systemOne } from "./client.ts";
import { noulProbability, topLabel, type JevAnswer, type JevQuestion } from "./types.ts";

export interface DropOptions {
	keepAt?: number;
	duplicateAt?: number;
	includeImportance?: boolean;
	maxItems?: number;
	maxStateChars?: number;
	model?: string;
}

export interface ItemVerdict {
	id: string;
	keep: boolean;
	keepProbability: number;
	duplicate: boolean;
	duplicateProbability: number;
	importance?: { level: string; mean: number };
}

export interface DropResult {
	verdicts: ItemVerdict[];
	kept: string[];
	dropped: string[];
	keptChars: number;
	totalChars: number;
	itemsTruncated: number;
	stateTruncated: boolean;
	elapsedMs: number;
	usage: { input_tokens?: number; output_tokens?: number };
	endpoint: string;
	answers: Record<string, JevAnswer>;
}

export function renderPool(goal: string, items: { id: string; text: string }[]): string {
	const body = items.map((item, index) => `[item ${index} (${item.id})]\n${item.text}`).join("\n\n");
	return `Goal: ${goal}\n\nPool:\n${body}`;
}

/**
 * Score a pool against a goal.
 *
 * The yes/no questions carry no criteria: with criteria text, Gemma 4 answered
 * "not needed" at 98-100% confidence for every item, including the item stating
 * the failure being fixed. The plain question separates them correctly.
 */
export async function runDrop(
	endpoint: ResolvedEndpoint,
	goal: string,
	items: { id: string; text: string }[],
	options: DropOptions = {},
	signal?: AbortSignal,
): Promise<DropResult> {
	const keepAt = options.keepAt ?? 0.5;
	const duplicateAt = options.duplicateAt ?? 0.8;
	const includeImportance = options.includeImportance !== false;
	const maxItems = options.maxItems ?? 200;
	const maxStateChars = options.maxStateChars ?? 80_000;

	const capped = items.slice(0, maxItems);
	let state = renderPool(goal, capped);
	let stateTruncated = false;
	if (state.length > maxStateChars) {
		state = state.slice(0, maxStateChars);
		stateTruncated = true;
	}

	const questions: Record<string, JevQuestion> = {};
	capped.forEach((item, index) => {
		questions[`keep_${index}`] = {
			type: "noul",
			instructions: `Is item ${index} (${item.id}) still needed for the goal: ${goal}?`,
		};
		questions[`dup_${index}`] = {
			type: "noul",
			instructions: `Does item ${index} (${item.id}) repeat content that an earlier item already states?`,
		};
		if (includeImportance) {
			questions[`imp_${index}`] = {
				type: "score",
				instructions: `How important is item ${index} (${item.id}) for the goal: ${goal}?`,
				criteria: ["irrelevant", "minor", "useful", "important", "critical"],
			};
		}
	});

	const result = await systemOne(endpoint, state, questions, { signal, model: options.model });
	const answers = result.answers as Record<string, JevAnswer>;
	const verdicts = capped.map((item, index) => {
		const keep = noulProbability(answers[`keep_${index}`]);
		const duplicateProbability = noulProbability(answers[`dup_${index}`]);
		const importanceAnswer = answers[`imp_${index}`];
		return {
			id: item.id,
			keep: keep >= keepAt && duplicateProbability < duplicateAt,
			keepProbability: keep,
			duplicate: duplicateProbability >= duplicateAt,
			duplicateProbability,
			importance: importanceAnswer
				? { level: topLabel(importanceAnswer).label, mean: importanceAnswer.type === "score" ? importanceAnswer.score : 0 }
				: undefined,
		};
	});

	const kept = verdicts.filter((v) => v.keep);
	const byId = new Map(capped.map((item) => [item.id, item.text.length]));
	return {
		verdicts,
		kept: kept.map((v) => v.id),
		dropped: verdicts.filter((v) => !v.keep).map((v) => v.id),
		keptChars: kept.reduce((sum, v) => sum + (byId.get(v.id) ?? 0), 0),
		totalChars: capped.reduce((sum, item) => sum + item.text.length, 0),
		itemsTruncated: items.length - capped.length,
		stateTruncated,
		elapsedMs: result.elapsedMs,
		usage: result.usage,
		endpoint: result.endpoint,
		answers,
	};
}

export function formatDrop(result: DropResult, goal: string): string {
	const lines = result.verdicts.map((v) => {
		const bits = [
			`${v.keep ? "KEEP" : "DROP"} ${v.id}`,
			`P(needed)=${v.keepProbability.toFixed(2)}`,
			v.duplicate ? `duplicate(${v.duplicateProbability.toFixed(2)})` : null,
			v.importance ? `${v.importance.level} (${v.importance.mean.toFixed(1)})` : null,
		].filter(Boolean);
		return bits.join("  ");
	});
	const header =
		`[jev drop ${result.endpoint} ${result.elapsedMs}ms] goal: ${goal}\n` +
		`${result.kept.length} kept, ${result.dropped.length} dropped, ${result.keptChars}/${result.totalChars} chars kept` +
		(result.stateTruncated ? ", state truncated" : "") +
		(result.itemsTruncated ? `, ${result.itemsTruncated} items over the cap not scored` : "");
	return [header, "", ...lines].join("\n");
}

/** Everything pi-observational-memory has recorded as observations on this branch. */
export interface OmObservation {
	id: string;
	content: string;
	timestamp?: string;
	relevance?: string;
}

const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";

/**
 * Read the live observation pool from session entries.
 *
 * pi-observational-memory records observations as custom entries and records drops
 * separately, so the current pool is everything recorded minus everything dropped.
 * Its own ids are 12 hex characters; anything else in those entries is ignored.
 */
export function readObservationPool(branch: readonly unknown[]): OmObservation[] {
	const observations = new Map<string, OmObservation>();
	const dropped = new Set<string>();
	for (const entry of branch) {
		const custom = entry as { type?: string; customType?: string; data?: unknown };
		if (custom?.type !== "custom") continue;
		if (custom.customType === OM_OBSERVATIONS_RECORDED) {
			const data = custom.data as { observations?: OmObservation[] } | undefined;
			for (const observation of data?.observations ?? []) {
				if (typeof observation?.id === "string" && typeof observation?.content === "string") {
					observations.set(observation.id, observation);
				}
			}
		} else if (custom.customType === OM_OBSERVATIONS_DROPPED) {
			const data = custom.data as { observationIds?: string[] } | undefined;
			for (const id of data?.observationIds ?? []) dropped.add(id);
		}
	}
	return [...observations.values()].filter((observation) => !dropped.has(observation.id));
}

export { resolve };
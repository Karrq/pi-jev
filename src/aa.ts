/**
 * Artificial Analysis figures, one row per model *and reasoning effort*, from
 * data/aa-intelligence.json (refreshed by hand with tools/aa-intelligence.mjs).
 *
 * The router uses these instead of prose notes, because the site treats model and
 * effort as one entity: Claude Opus 5.5 at medium scores 51 on the Intelligence Index
 * for $1.34 a task, Claude Sonnet 5.5 at high scores 47 for $1.08, and which one is
 * the better buy depends on the task, not on the model name.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AaRow {
	/** "artificialanalysis" for fetched rows, "manual" for hand-written ones. */
	source?: "artificialanalysis" | "manual";
	slug: string;
	url: string;
	label?: string;
	index?: number;
	outputTokensPerSecond?: number;
	costPerTaskUsd?: number;
	outputTokensPerTask?: string;
	priceIn?: number;
	priceOut?: number;
	model?: string;
}

/**
 * A hand-written stand-in for a model Artificial Analysis has not measured. Scores here
 * override the fetched rows for that model, since a number you chose on purpose should
 * not be silently replaced by a fetch.
 */
export interface ManualProfile {
	notes?: string;
	/** Artificial Analysis Intelligence Index, higher is better. */
	index?: number;
	costPerTask?: number;
	/** Per-effort scores, e.g. `{ low: { index: 30 }, high: { index: 44 } }`. */
	byEffort?: Record<string, { index?: number; costPerTask?: number }>;
}

export interface AaData {
	source: string;
	fetchedAt: string;
	index: string;
	rows: AaRow[];
}

const here = dirname(fileURLToPath(import.meta.url));
let cached: AaData | undefined;

/** The data file, or undefined when it is missing or unreadable. */
export function aaData(): AaData | undefined {
	if (cached !== undefined) return cached;
	try {
		const parsed = JSON.parse(readFileSync(join(here, "..", "data", "aa-intelligence.json"), "utf8")) as AaData;
		cached = Array.isArray(parsed.rows) ? parsed : undefined;
	} catch {
		cached = undefined;
	}
	return cached;
}

/** The effort a row describes: "low", "medium", "high", "xhigh", or "default". */
export function effortOf(row: AaRow): string {
	const fromSlug = /-(low|medium|high|xhigh|max|minimal)$/.exec(row.slug)?.[1];
	if (fromSlug) return fromSlug;
	const fromLabel = /(\w+) Effort/.exec(row.label ?? "")?.[1];
	return fromLabel ? fromLabel.toLowerCase() : "default";
}

const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "default"];

function sortRows(rows: AaRow[]): AaRow[] {
	return [...rows].sort((a, b) => ORDER.indexOf(effortOf(a)) - ORDER.indexOf(effortOf(b)));
}

/** Rows written by hand, in the same shape as fetched ones. */
export function manualRows(label: string, profile: ManualProfile | undefined): AaRow[] {
	if (!profile) return [];
	const rows: AaRow[] = [];
	const efforts = Object.entries(profile.byEffort ?? {});
	if (efforts.length) {
		for (const [effort, scores] of efforts) {
			if (scores.index === undefined && scores.costPerTask === undefined) continue;
			rows.push({
				source: "manual",
				slug: `${label}#${effort}`,
				url: "",
				index: scores.index,
				costPerTaskUsd: scores.costPerTask,
				model: label,
			});
		}
	}
	if (rows.length === 0 && (profile.index !== undefined || profile.costPerTask !== undefined)) {
		rows.push({
			source: "manual",
			slug: `${label}#default`,
			url: "",
			index: profile.index,
			costPerTaskUsd: profile.costPerTask,
			model: label,
		});
	}
	return sortRows(rows);
}

/**
 * Rows for a pi model label, matched on the label recorded in the data file first,
 * then on family name plus the exact version numbers, so `claude-opus-5` never picks
 * up `claude-opus-5-5` rows or `claude-4-5-haiku` rows.
 */
export function rowsFor(model: { id: string; name?: string }, manual?: ManualProfile): AaRow[] {
	const written = manualRows(`${model.provider ?? ""}/${model.id}`.replace(/^\//, ""), manual);
	if (written.length) return written;
	const data = aaData();
	if (!data) return [];
	const exact = data.rows.filter((row) => row.model === `${model.id}` || row.model?.endsWith(`/${model.id}`));
	if (exact.length) return sortRows(exact);
	const words = model.id.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !/^\d+$/.test(word));
	const versions = versionTokens(model.id);
	if (!words.length) return [];
	const matches = (slug: string) => {
		const haystack = slug.toLowerCase();
		if (!words.every((word) => haystack.includes(word))) return false;
		const rowVersions = versionTokens(slug);
		return versions.length === rowVersions.length && versions.every((value, index) => rowVersions[index] === value);
	};
	return sortRows(data.rows.filter((row) => matches(`${row.slug} ${row.label ?? ""}`)));
}

/** Numeric segments of a model name, in order: claude-opus-5-5 is [5, 5]. */
function versionTokens(name: string): string[] {
	return name.match(/\d+/g) ?? [];
}

/**
 * The per-effort lines for a candidate, or undefined when nothing matched. Only the
 * two headline measures: capability on the Artificial Analysis Intelligence Index, and
 * what one task costs at that effort. Speed is in the data file and left out here.
 */
export function effortLines(model: { id: string; name?: string }, manual?: ManualProfile): string[] | undefined {
	const rows = rowsFor(model, manual);
	if (!rows.length) return undefined;
	return rows.map((row) => {
		const estimate = row.source === "manual" ? "~" : "";
		const index = row.index !== undefined ? `index ${estimate}${row.index}` : "index not measured";
		const cost = row.costPerTaskUsd !== undefined ? `$${row.costPerTaskUsd.toFixed(2)}/task` : "cost not measured";
		const source = row.source === "manual" ? " (your estimate)" : "";
		return `      ${effortOf(row).padEnd(8)} ${index}, ${cost}${source}`;
	});
}

/**
 * What one task costs this model at a given effort, or undefined when that effort was
 * never measured. `lowestMeasured` falls back to the cheapest row the site does have,
 * which is what a model with a single expensive row should be charged.
 */
export function costAtLevel(
	model: { id: string; name?: string },
	level: string,
	lowestMeasured = false,
	manual?: ManualProfile,
): number | undefined {
	const rows = rowsFor(model, manual);
	const exact = rows.find((row) => effortOf(row) === level)?.costPerTaskUsd;
	if (exact !== undefined) return exact;
	if (!lowestMeasured) return undefined;
	const costs = rows.map((row) => row.costPerTaskUsd).filter((value): value is number => value !== undefined);
	return costs.length ? Math.min(...costs) : undefined;
}

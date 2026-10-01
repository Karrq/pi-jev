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

/**
 * Rows for a pi model label, matched on the label recorded in the data file first,
 * then on family name plus the exact version numbers, so `claude-opus-5` never picks
 * up `claude-opus-5-5` rows or `claude-4-5-haiku` rows.
 */
export function rowsFor(model: { id: string; name?: string }): AaRow[] {
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
 * The per-effort lines for a candidate, or undefined when nothing matched.
 *
 * `levels` is what pi can actually send. A row whose effort pi cannot select is
 * marked with `*`, since it describes a setting the router would never choose:
 * Claude Sonnet 5 has one Artificial Analysis row, its own maximum-effort default,
 * and pi would run it at low, medium or high.
 */
export function effortLines(model: { id: string; name?: string }, levels?: readonly string[]): string[] | undefined {
	const rows = rowsFor(model);
	if (!rows.length) return undefined;
	const lines = rows.map((row) => {
		const effort = effortOf(row);
		const parts = [
			row.index !== undefined ? `index ${row.index}` : "index not measured",
			row.costPerTaskUsd !== undefined ? `$${row.costPerTaskUsd.toFixed(2)}/task` : "cost not measured",
			row.outputTokensPerSecond !== undefined ? `${row.outputTokensPerSecond} tok/s` : undefined,
		].filter(Boolean);
		const mark = levels && !levels.includes(effort) ? "*" : " ";
		return `     ${mark} ${effort.padEnd(8)} ${parts.join(", ")}`;
	});
	if (lines.some((line) => line.startsWith("     *"))) {
		lines.push("       (* a setting pi cannot select for this model)");
	}
	return lines;
}

/** The best index any effort of this model reached, for a one-line summary. */
export function bestIndex(model: { id: string; name?: string }): number | undefined {
	const indexes = rowsFor(model)
		.map((row) => row.index)
		.filter((value): value is number => value !== undefined);
	return indexes.length ? Math.max(...indexes) : undefined;
}

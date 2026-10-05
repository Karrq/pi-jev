/**
 * jev-file-relevance: answer questions about files, chunking them when large.
 *
 * One request can cover several files and globs: the state is the files with
 * their resolved paths as labels, and each answer reports which file (and chunk)
 * it came from. A file that fits in one chunk is asked whole; a larger one is split
 * into overlapping chunks, because accuracy on a single long state falls off past a
 * few thousand tokens. Per question the most confident chunk wins.
 *
 * Settings: overrides["jev-file-relevance"] = { chunkChars, overlapChars, maxChunks,
 * maxFiles, maxScanChars, filesPerRequest, maxBatchChars, maxFileBytes, maxQuestions,
 * concurrency }
 *
 * maxFiles and maxScanChars decide how much of the tree is read at all; maxScanChars
 * is the one that bounds how long the call takes, since time tracks characters read.
 * The read set is then split into requests of at most filesPerRequest files and
 * maxBatchChars characters, so each request stays quick.
 *
 * Patterns follow .gitignore, so a `**` scan does not read node_modules. A pattern
 * may opt out with the `i` flag, `<i>/**`.
 *
 * Toggle: "+extensions/file-relevance.ts" in the package's extension list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { distribution, formatAnswer, topLabel, type JevAnswer, type JevQuestion } from "../src/types.ts";
import { failure, numberOption, text } from "../src/shared.ts";
import { readPathPatterns, globToRegExp, type SourceBlock } from "../src/sources.ts";
import { extname, posix, resolve as resolvePath } from "node:path";

const MAX_OVERFLOW_GLOBS = 6;
const MAX_OTHER_SKIPS = 5;

const EXTENSION = "jev-file-relevance";

const FileParams = Type.Object({
	paths: Type.Array(
		Type.String({
			description:
				"File, directory, or glob, relative to the working directory or absolute; a directory is walked recursively and " +
				"globs are expanded. .gitignore applies, so `**` skips node_modules and build output; prefix a pattern with " +
				"<i>/ to include those, or name an ignored path outright to read it. Files are read in the order given, " +
				"and reading stops at maxFiles files or maxScanChars characters (300k), which bounds how long the call takes. " +
				"The read set is asked about in several small requests, so a wide pattern is cheap.",
		}),
		{ minItems: 1, description: "Files to read" },
	),
	questions: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ description: "Key for the answer; defaults to q1, q2, ..." })),
			instructions: Type.String({ description: "What to determine from the files, phrased to fit the type" }),
			type: Type.Optional(
				Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")], {
					description:
						"noul = yes/no probability (default), choice = pick one label, score = pick an ordered level. " +
						"There is no free-text answer: ask 'Does any file X?', not 'List the files that X'.",
				}),
			),
			criteria: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Required for choice and score, at least 2 entries; omit for noul. " +
						"choice: labels, optionally 'label: description', e.g. ['tool: registers a tool', 'command: registers a command', 'none: neither']. " +
						"score: levels from lowest to highest, e.g. ['none', 'partial', 'complete'].",
				}),
			),
		}),
		{ minItems: 1, description: "Typed questions to answer about the files" },
	),
});

interface Spec {
	id?: string;
	instructions: string;
	type?: "noul" | "choice" | "score";
	criteria?: string[];
}

export function buildQuestions(specs: Spec[]): Record<string, JevQuestion> {
	const questions: Record<string, JevQuestion> = {};
	specs.forEach((spec, index) => {
		const id = spec.id?.trim() || `q${index + 1}`;
		const instructions = spec.instructions.trim();
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

export interface Chunk {
	source: number;
	index: number;
	start: number;
	end: number;
	text: string;
}

export function chunkFile(block: SourceBlock, chunkChars: number, overlapChars: number, maxChunks: number): { chunks: Chunk[]; truncated: boolean } {
	if (block.text.length <= chunkChars) {
		return { chunks: [{ source: -1, index: 0, start: 0, end: block.text.length, text: block.text }], truncated: false };
	}
	const chunks: Chunk[] = [];
	const step = Math.max(1, chunkChars - overlapChars);
	for (let start = 0; start < block.text.length && chunks.length < maxChunks; start += step) {
		const end = Math.min(block.text.length, start + chunkChars);
		chunks.push({ source: -1, index: chunks.length, start, end, text: block.text.slice(start, end) });
		if (end === block.text.length) return { chunks, truncated: false };
	}
	return { chunks, truncated: true };
}

/** Most confident answer per question across chunks. */
function betterThan(current: JevAnswer | undefined, candidate: JevAnswer): boolean {
	if (!current) return true;
	const scoreOf = (answer: JevAnswer) => (answer.type === "noul" ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence);
	return scoreOf(candidate) > scoreOf(current);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index], index);
			}
		}),
	);
	return results;
}

/**
 * One glob per directory that overflowed, so the model can ask for the rest by
 * pattern instead of receiving a line per unread file. Files in a directory that
 * share a few extensions collapse into a brace pattern; anything wider falls back
 * to `dir/**\/*`.
 */
export function overflowGlobs(origins: string[]): string[] {
	const byDir = new Map<string, string[]>();
	for (const origin of origins) {
		const slash = origin.lastIndexOf("/");
		const dir = slash < 0 ? "." : origin.slice(0, slash);
		const ext = extname(origin);
		const files = byDir.get(dir) ?? [];
		files.push(ext);
		byDir.set(dir, files);
	}
	// Merge a directory into its parent when every sibling under that parent is also
	// in the set: node_modules and similar trees collapse to one glob per package.
	let merged = true;
	// A directory that absorbed children needs `**` to still cover what it absorbed.
	const deep = new Set<string>();
	while (merged) {
		merged = false;
		const parents = [...byDir.keys()].map((dir) => (dir === "." ? null : dir.slice(0, dir.lastIndexOf("/"))));
		for (const parent of new Set(parents.filter((p): p is string => p !== null))) {
			const owned = [...byDir.keys()].filter((dir) => dir !== parent && dir.startsWith(`${parent}/`));
			if (owned.length === 0) continue;
			const siblings = [...byDir.keys()].filter((dir) => dir.startsWith(`${parent}/`) && !owned.includes(dir));
			if (siblings.length) continue;
			const own = byDir.get(parent) ?? [];
			const exts = [...own, ...owned.flatMap((dir) => byDir.get(dir) ?? [])];
			byDir.delete(parent);
			for (const dir of owned) byDir.delete(dir);
			byDir.set(parent, exts);
			deep.add(parent);
			merged = true;
		}
	}
	const globs: string[] = [];
	for (const [dir, exts] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const unique = [...new Set(exts)].filter(Boolean).sort();
		const brace = unique.length > 0 && unique.length <= 3 ? `*.{${unique.map((e) => e.slice(1)).join(",")}}` : null;
		// `brace` names the extensions; a directory that absorbed children needs `**`
		// so the pattern still matches what it took in.
		const body = brace === null ? "**/*" : deep.has(dir) ? `**/${brace}` : brace;
		globs.push(dir === "." ? (brace === null ? body : brace) : posix.join(dir, body));
	}
	return globs;
}

/**
 * Group chunks into requests bounded by both file count and characters. Reading
 * 200 files is then a run of small fast requests rather than one slow one.
 */
export function batchChunks(chunks: Chunk[], maxFiles: number, maxChars: number): Chunk[][] {
	const batches: Chunk[][] = [];
	let current: Chunk[] = [];
	let chars = 0;
	const files = new Set<number>();
	for (const chunk of chunks) {
		const size = chunk.text.length;
		const full = current.length > 0 && (files.size >= maxFiles || chars + size > maxChars);
		if (full) {
			batches.push(current);
			current = [];
			chars = 0;
			files.clear();
		}
		current.push(chunk);
		chars += size;
		files.add(chunk.source);
	}
	if (current.length) batches.push(current);
	return batches;
}

/**
 * Notes for files that were never read: a glob for the overflow, at most a few lines
 * for the rest.
 *
 * The globs are built from the dropped paths themselves, so they describe exactly
 * what was not read. A glob can still catch a file that was read, which is checked
 * against the read set (bounded by maxFiles) rather than by expanding the glob.
 */
export function skipNotes(
	skipped: { origin: string; reason: string }[],
	overflowReason: (reason: string) => boolean,
	cwd: string,
	readPaths: Set<string>,
): string[] {
	const overflow = skipped.filter((skip) => overflowReason(skip.reason));
	const other = skipped.filter((skip) => !overflowReason(skip.reason));
	const notes: string[] = [];
	if (overflow.length) {
		const globs = overflowGlobs(overflow.map((skip) => skip.origin));
		const shown = globs.slice(0, MAX_OVERFLOW_GLOBS);
		const rest = globs.length - shown.length;
		const overlap = new Set(
			[...readPaths].filter((path) => shown.some((glob) => globToRegExp(resolvePath(cwd, glob)).test(resolvePath(cwd, path)))),
		);
		notes.push(
			`not read, ${overflow.length} file(s) still match ${shown.join(", ")}${rest > 0 ? `, and ${rest} more pattern(s)` : ""} ` +
				`(raise maxFiles or maxScanChars to include them${overlap.size ? `; these would re-read up to ${overlap.size} file(s) already read` : ""})`,
		);
	}
	for (const skip of other.slice(0, MAX_OTHER_SKIPS)) notes.push(`skipped ${skip.origin} (${skip.reason})`);
	if (other.length > MAX_OTHER_SKIPS) notes.push(`skipped ${other.length - MAX_OTHER_SKIPS} more file(s) for other reasons`);
	return notes;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev_file",
		label: "Jev File Relevance",
		description:
			"Answer typed questions about many files at once, returning only each answer with the file and character range " +
			"it came from. Cheap enough to use first whenever a question spans several files or you are unsure which files hold " +
			"the answer: prefer it over opening files yourself or grepping via `bash`, and survey with a broad glob over the " +
			"relevant subtree before narrowing to a read.\n\n" +
			"Answers are yes/no (noul), one label (choice), or a level (score), never free text. The per-request lines " +
			"show which group of files each answer came from; rerun on a narrower path to pin one file down.\n\n" +
			"Examples:\n" +
			'- {"paths": ["src/**/*.ts"], "questions": [{"id": "retry", "instructions": "Does any file retry failed HTTP requests?"}]}\n' +
			'- {"paths": ["extensions"], "questions": [{"id": "kind", "type": "choice", "instructions": "What does this extension register?", ' +
			'"criteria": ["tool: a tool", "command: a slash command", "both: a tool and a command", "none: neither"]}]}\n' +
			'- {"paths": ["README.md", "docs/*.md"], "questions": [{"id": "setup", "type": "score", "instructions": "How completely are setup steps documented?", ' +
			'"criteria": ["none", "partial", "complete"]}]}',
		promptSnippet:
			"Ask yes/no, choice, or score questions over many files or globs at once; use it before read, grep, or bash when the answer could be in several files",
		promptGuidelines: [
			"Use jev_file first for questions that span several files or an unknown location, then read only the files it points to",
			"In jev_file, choice and score questions need at least 2 criteria, e.g. criteria: ['tool: registers a tool', 'command: registers a command']; noul questions take no criteria",
		],
		parameters: FileParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			// Chunking is an implementation detail, not a decision for the model:
			// these come from settings only.
			const chunkChars = numberOption(options, "chunkChars", 16_000);
			const overlapChars = numberOption(options, "overlapChars", 1_000);
			const maxChunks = numberOption(options, "maxChunks", 8);
			const maxFiles = numberOption(options, "maxFiles", 200);
			// Chars, not files, bound how long a scan takes, so they are the real budget.
			const maxScanChars = numberOption(options, "maxScanChars", 300_000);
			const maxFileBytes = numberOption(options, "maxFileBytes", 2 << 20);
			const concurrency = numberOption(options, "concurrency", 1);
			const maxQuestions = numberOption(options, "maxQuestions", 12);
			// One request covers at most this many files and this many characters, so a
			// 200-file scan stays a sequence of small fast requests instead of one slow one.
			const filesPerRequest = numberOption(options, "filesPerRequest", 20);
			const maxBatchChars = numberOption(options, "maxBatchChars", 48_000);

			try {
				const found = await readPathPatterns(params.paths, { cwd: ctx.cwd, maxFileBytes, maxFiles, maxChars: maxScanChars });
				if (found.blocks.length === 0) {
					throw new Error(`no files matched: ${params.paths.join(", ")}`);
				}
				const questions = buildQuestions(params.questions.slice(0, maxQuestions) as Spec[]);

				const chunks: Chunk[] = [];
				const truncatedFiles: string[] = [];
				found.blocks.forEach((block, source) => {
					const result = chunkFile(block, chunkChars, overlapChars, maxChunks);
					if (result.truncated) truncatedFiles.push(block.label);
					for (const chunk of result.chunks) chunks.push({ ...chunk, source });
				});
				const totalChars = found.blocks.reduce((sum, block) => sum + block.text.length, 0);

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Reading ${found.blocks.length} file(s), ${totalChars} chars in ${chunks.length} chunk(s)`,
						},
					],
					details: { files: found.blocks.length, chars: totalChars, chunks: chunks.length },
				});

				const stateOf = (chunk: Chunk) => {
					const block = found.blocks[chunk.source];
					const where =
						found.blocks.length > 1
							? `File: ${block.label}${chunks.filter((c) => c.source === chunk.source).length > 1 ? ` (chunk ${chunk.index + 1} of several, characters ${chunk.start}-${chunk.end} of ${block.text.length})` : ""}`
							: `File: ${block.label}`;
					return `${where}\n\n${chunk.text}`;
				};

				const batches = batchChunks(chunks, filesPerRequest, maxBatchChars);
				const startedAll = Date.now();
				let done = 0;
				const answers = await mapLimit(batches, concurrency, async (batch) => {
					const state = batch.map(stateOf).join("\n\n");
					const result = await systemOne(endpoint, state, questions, { signal });
					done++;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Asked ${done}/${batches.length} request(s): ${batch.length} chunk(s), ${batch.reduce((sum, chunk) => sum + chunk.text.length, 0)} chars`,
							},
						],
						details: { files: found.blocks.length, chars: totalChars, chunks: chunks.length, requests: batches.length, done },
					});
					return { batch, answers: result.answers, elapsedMs: result.elapsedMs };
				});

				const best: Record<string, { answer: JevAnswer; chunk: Chunk }> = {};
				for (const { batch, answers: perBatch } of answers) {
					// One answer covers the whole request, so credit it to the longest chunk in
					// it: the range then points at the biggest stretch of text it covers.
					const chunk = batch.reduce((bestChunk, candidate) => (candidate.text.length > bestChunk.text.length ? candidate : bestChunk));
					for (const [id, answer] of Object.entries(perBatch)) {
						if (betterThan(best[id]?.answer, answer)) best[id] = { answer, chunk };
					}
				}

				const lines = Object.entries(best).map(([id, { answer, chunk }]) => {
					const where = `${found.blocks[chunk.source].label} chars ${chunk.start}-${chunk.end}`;
					return `${id}: ${formatAnswer(answer)} [${where}]`;
				});
				const perChunkLines = answers.map(
					({ batch, answers: perBatch, elapsedMs }) => {
						const files = [...new Set(batch.map((chunk) => found.blocks[chunk.source].label))];
						return `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3} more` : ""}: ${Object.entries(perBatch)
							.map(([id, answer]) => `${id}=${topLabel(answer).label}`)
							.join(", ")} [${elapsedMs}ms]`;
					},
				);
				const totalMs = Date.now() - startedAll;
				const notes = [
					...found.missing.map((pattern) => `no match: ${pattern}`),
					...skipNotes(
						found.skipped,
						(reason) => reason.startsWith("maxFiles") || reason.startsWith("maxChars"),
						ctx.cwd,
						new Set(found.blocks.map((block) => block.label)),
					),
					...(truncatedFiles.length ? [`read only the first ${maxChunks} chunks of: ${truncatedFiles.join(", ")}`] : []),
				];
				const header = `[jev file ${endpoint.name}: ${found.blocks.length} file(s), ${totalChars} chars, ${chunks.length} chunk(s), ${answers.length} request(s), ${totalMs}ms]`;

				return {
					...text([header, "", ...lines, "", ...perChunkLines, ...(notes.length ? ["", ...notes] : [])].join("\n")),
					details: {
						paths: params.paths,
						resolvedPaths: found.blocks.map((block) => block.path ?? block.label),
						labels: found.blocks.map((block) => block.label),
						files: found.blocks.map((block) => ({ path: block.label, chars: block.text.length, originalBytes: block.originalBytes })),
						chunks: chunks.map((chunk) => ({
							file: found.blocks[chunk.source].label,
							index: chunk.index,
							start: chunk.start,
							end: chunk.end,
						})),
						answers: Object.fromEntries(Object.entries(best).map(([id, entry]) => [id, entry.answer])),
						sources: Object.fromEntries(
							Object.entries(best).map(([id, entry]) => [
								id,
								{ file: found.blocks[entry.chunk.source].label, start: entry.chunk.start, end: entry.chunk.end },
							]),
						),
						distributions: Object.fromEntries(Object.entries(best).map(([id, entry]) => [id, distribution(entry.answer)])),
						notes,
						elapsedMs: totalMs,
					},
				};
			} catch (error) {
				return failure(endpoint, error);
			}
		},
	});
}
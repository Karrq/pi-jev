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
 * maxFiles, maxFileBytes, maxQuestions, concurrency }
 *
 * Toggle: "+extensions/file-relevance.ts" in the package's extension list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { distribution, formatAnswer, topLabel, type JevAnswer, type JevQuestion } from "../src/types.ts";
import { failure, numberOption, text } from "../src/shared.ts";
import { readPathPatterns, type SourceBlock } from "../src/sources.ts";

const EXTENSION = "jev-file-relevance";

const FileParams = Type.Object({
	paths: Type.Array(
		Type.String({ description: "File or glob, relative to the working directory or absolute. Glob patterns are expanded." }),
		{ minItems: 1, description: "Files to read" },
	),
	questions: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String()),
			instructions: Type.String({ description: "What to determine from the files" }),
			type: Type.Optional(Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")])),
			criteria: Type.Optional(Type.Array(Type.String(), { description: "choice/score criteria, 'label: description' for choice" })),
		}),
		{ minItems: 1, description: "Typed questions to answer about the files" },
	),
	chunkChars: Type.Optional(Type.Number({ description: "Characters per chunk when a file is large (default 16000, about 4k tokens)" })),
	maxChunks: Type.Optional(Type.Number({ description: "Stop after this many chunks per file (default 8)" })),
	maxFiles: Type.Optional(Type.Number({ description: "Stop after this many files (default 20)" })),
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev_file",
		label: "Jev File Relevance",
		description:
			"Answer typed questions about one or more files (globs allowed) by reading them in chunks: per question the " +
			"most confident chunk wins, and the answer names the file and character range. Use to check whether files " +
			"answer a question, or to extract facts from many of them at once, without loading them into context.",
		promptSnippet: "Answer typed questions about files, chunked, with the source file and range reported",
		parameters: FileParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const chunkChars = params.chunkChars ?? numberOption(options, "chunkChars", 16_000);
			const overlapChars = numberOption(options, "overlapChars", 1_000);
			const maxChunks = params.maxChunks ?? numberOption(options, "maxChunks", 8);
			const maxFiles = params.maxFiles ?? numberOption(options, "maxFiles", 20);
			const maxFileBytes = numberOption(options, "maxFileBytes", 2 << 20);
			const concurrency = numberOption(options, "concurrency", 1);
			const maxQuestions = numberOption(options, "maxQuestions", 12);

			try {
				const found = await readPathPatterns(params.paths, { cwd: ctx.cwd, maxFileBytes, maxFiles });
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

				const startedAll = Date.now();
				const answers = await mapLimit(chunks, concurrency, async (chunk) => {
					const result = await systemOne(endpoint, stateOf(chunk), questions, { signal });
					return { chunk, answers: result.answers, elapsedMs: result.elapsedMs };
				});

				const best: Record<string, { answer: JevAnswer; chunk: Chunk }> = {};
				for (const { chunk, answers: perChunk } of answers) {
					for (const [id, answer] of Object.entries(perChunk)) {
						if (betterThan(best[id]?.answer, answer)) best[id] = { answer, chunk };
					}
				}

				const lines = Object.entries(best).map(([id, { answer, chunk }]) => {
					const where = `${found.blocks[chunk.source].label} chars ${chunk.start}-${chunk.end}`;
					return `${id}: ${formatAnswer(answer)} [${where}]`;
				});
				const perChunkLines = answers.map(
					({ chunk, answers: perChunk, elapsedMs }) =>
						`${found.blocks[chunk.source].label} ${chunk.start}-${chunk.end}: ${Object.entries(perChunk)
							.map(([id, answer]) => `${id}=${topLabel(answer).label}`)
							.join(", ")} [${elapsedMs}ms]`,
				);
				const totalMs = Date.now() - startedAll;
				const notes = [
					...found.missing.map((pattern) => `no match: ${pattern}`),
					...found.skipped.map((skip) => `skipped ${skip.origin} (${skip.reason})`),
					...(truncatedFiles.length ? [`read only the first ${maxChunks} chunks of: ${truncatedFiles.join(", ")}`] : []),
					...(found.blocks.length >= maxFiles ? [`stopped at maxFiles ${maxFiles}`] : []),
				];
				const header = `[jev file ${endpoint.name}: ${found.blocks.length} file(s), ${totalChars} chars, ${chunks.length} chunk(s), ${totalMs}ms]`;

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
/**
 * jev-file-relevance: answer questions about a file, chunking it when it is large.
 *
 * A small file is one request. A large one is split into overlapping chunks and
 * asked separately, because accuracy on a single long state falls off past a few
 * thousand tokens: per question the most confident chunk wins, and the chunk index
 * is reported so the caller can read the right part of the file itself.
 *
 * Settings: overrides["jev-file-relevance"] = { chunkChars, overlapChars, maxChunks, maxQuestions, concurrency }
 *
 * Toggle: "+extensions/file-relevance.ts" in the package's extension list.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { systemOne } from "../src/client.ts";
import { distribution, formatAnswer, topLabel, type JevAnswer, type JevQuestion } from "../src/types.ts";
import { failure, numberOption, text } from "../src/shared.ts";

const EXTENSION = "jev-file-relevance";

const FileParams = Type.Object({
	path: Type.String({ description: "File to read, absolute or relative to the working directory" }),
	questions: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String()),
			instructions: Type.String({ description: "What to determine from the file" }),
			type: Type.Optional(Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")])),
			criteria: Type.Optional(Type.Array(Type.String(), { description: "choice/score criteria, 'label: description' for choice" })),
		}),
		{ minItems: 1, description: "Typed questions to answer about the file" },
	),
	chunkChars: Type.Optional(Type.Number({ description: "Characters per chunk when the file is large (default 16000, about 4k tokens)" })),
	maxChunks: Type.Optional(Type.Number({ description: "Stop after this many chunks (default 8)" })),
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
	index: number;
	start: number;
	end: number;
	text: string;
}

export function chunkText(text: string, chunkChars: number, overlapChars: number, maxChunks: number): { chunks: Chunk[]; truncated: boolean } {
	if (text.length <= chunkChars) return { chunks: [{ index: 0, start: 0, end: text.length, text }], truncated: false };
	const chunks: Chunk[] = [];
	const step = Math.max(1, chunkChars - overlapChars);
	for (let start = 0; start < text.length && chunks.length < maxChunks; start += step) {
		const end = Math.min(text.length, start + chunkChars);
		chunks.push({ index: chunks.length, start, end, text: text.slice(start, end) });
		if (end === text.length) return { chunks, truncated: false };
	}
	return { chunks, truncated: true };
}

/** Most confident answer per question across chunks. */
function bestAnswer(current: JevAnswer | undefined, candidate: JevAnswer): JevAnswer {
	if (!current) return candidate;
	const scoreOf = (answer: JevAnswer) =>
		answer.type === "noul" ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence;
	return scoreOf(candidate) > scoreOf(current) ? candidate : current;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev_file",
		label: "Jev File Relevance",
		description:
			"Answer typed questions about a file by reading it in chunks: per question the most confident chunk wins, " +
			"with the chunk's character range reported. Use to check whether a file answers a question, or to extract " +
			"facts from it, without pulling the whole file into context.",
		promptSnippet: "Answer typed questions about a file, chunked, with the source range reported",
		parameters: FileParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const chunkChars = params.chunkChars ?? numberOption(options, "chunkChars", 16_000);
			const overlapChars = numberOption(options, "overlapChars", 1_000);
			const maxChunks = params.maxChunks ?? numberOption(options, "maxChunks", 8);
			const concurrency = numberOption(options, "concurrency", 4);
			const maxQuestions = numberOption(options, "maxQuestions", 12);

			try {
				const path = isAbsolute(params.path) ? params.path : resolvePath(ctx.cwd, params.path);
				const file = await readFile(path, "utf8");
				const { chunks, truncated } = chunkText(file, chunkChars, overlapChars, maxChunks);
				const questions = buildQuestions(params.questions.slice(0, maxQuestions) as Spec[]);

				onUpdate?.({
					content: [{ type: "text", text: `Reading ${params.path}: ${file.length} chars in ${chunks.length} chunk(s)` }],
					details: { path, chars: file.length, chunks: chunks.length },
				});

				const state = (chunk: Chunk) => `File: ${params.path}\nCharacters ${chunk.start}-${chunk.end} of ${file.length}\n\n${chunk.text}`;
				const perChunk = await mapLimit(chunks, concurrency, async (chunk) => {
					const result = await systemOne(endpoint, state(chunk), questions, { signal });
					return { chunk, answers: result.answers, elapsedMs: result.elapsedMs };
				});

				const best: Record<string, { answer: JevAnswer; chunk: number }> = {};
				for (const { chunk, answers } of perChunk) {
					for (const [id, answer] of Object.entries(answers)) {
						const current = best[id];
						if (!current || bestAnswer(current.answer, answer) === answer) best[id] = { answer, chunk: chunk.index };
					}
				}

				const lines = Object.entries(best).map(([id, { answer, chunk }]) => {
					const chunkInfo = chunks.length > 1 ? ` [chunk ${chunk}, chars ${chunks[chunk].start}-${chunks[chunk].end}]` : "";
					return `${id}: ${formatAnswer(answer)}${chunkInfo}`;
				});
				const perChunkLines = perChunk.map(
					({ chunk, answers, elapsedMs }) =>
						`chunk ${chunk.index} (${chunk.start}-${chunk.end}): ${Object.entries(answers)
							.map(([id, answer]) => `${id}=${topLabel(answer).label}`)
							.join(", ")} [${elapsedMs}ms]`,
				);
				const header =
					`[jev file ${endpoint.name} ${path}, ${file.length} chars in ${chunks.length} chunk(s), ${perChunk.reduce((s, c) => s + c.elapsedMs, 0)}ms total]` +
					(truncated ? `\nWARNING: stopped after ${maxChunks} chunks; ${file.length - chunks[chunks.length - 1].end} chars were not read` : "");

				return {
					...text([header, "", ...lines, "", ...perChunkLines].join("\n")),
					details: {
						path,
						chars: file.length,
						chunks: chunks.map((c) => ({ index: c.index, start: c.start, end: c.end })),
						truncated,
						answers: Object.fromEntries(Object.entries(best).map(([id, b]) => [id, b.answer])),
						sources: Object.fromEntries(Object.entries(best).map(([id, b]) => [id, b.chunk])),
						distributions: Object.fromEntries(Object.entries(best).map(([id, b]) => [id, distribution(b.answer)])),
					},
				};
			} catch (error) {
				return failure(endpoint, error);
			}
		},
	});
}
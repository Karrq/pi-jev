/**
 * ask-jev: typed questions about any text, without putting that text in context.
 *
 * Commands run here, their combined output goes to the endpoint, and only the answers
 * come back, so 40k tokens of output can be reasoned about without the model ever
 * reading them. Each command's output is written to its own temp file and the paths are
 * reported, so the exact lines are one `read` away.
 *
 * `state` is context rather than a source: a scope, a constraint, what to exclude. It
 * is sent in front of the output and is not saved or attributed. Prose to be judged goes
 * through a command (`echo "..."`), which keeps one code path for every source.
 *
 * One request covers every source. With `perSource: true` each source is asked
 * separately, which costs one request per source but reports which file or command
 * each answer came from.
 *
 * Every command's full output is written to a temp file (the same place pi puts
 * truncated bash output) and the path is listed with the source, so the exact
 * failing lines are one `read` away instead of a second request.
 *
 * `timeout` caps each command, like the bash tool's. Settings:
 * overrides["ask-jev"] = { maxQuestions, maxCommandBytes, commandTimeoutMs,
 * maxHeadChars, model }
 *
 * `maxHeadChars` quotes the head of each contributing source. The model does not
 * report offsets, so this is the start of the output, not the matching region.
 *
 * Toggle: "+extensions/ask-jev.ts" in the package's extension list.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolve } from "../src/config.ts";
import { classify, formatAnswer, noul, type JevAnswer, type JevQuestion, type QuestionType } from "../src/classifier.ts";
import { endpointLine, failure, numberOption, text } from "../src/shared.ts";
import { renderBlocks, runCommand, type SourceBlock } from "../src/sources.ts";

const EXTENSION = "ask-jev";

const QuestionSpec = Type.Object({
	id: Type.Optional(Type.String({ description: "Key for the answer; defaults to q1, q2, ..." })),
	instructions: Type.String({ description: "What to decide about the sources" }),
	type: Type.Optional(
		Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")], {
			description: "noul = yes/no probability (default), choice = pick a label, score = ordered level",
		}),
	),
	criteria: Type.Optional(
		Type.Array(Type.String(), {
			description: "choice: labels, optionally 'label: description'. score: ordered levels. Ignored for noul.",
		}),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSpec, { minItems: 1, description: "Typed questions to answer" }),
	state: Type.Optional(
		Type.String({
			description:
				"Extra context for interpreting the output, sent with it and not saved: a scope, a constraint, or what to exclude. To have prose judged, run `echo` as a command instead.",
		}),
	),
	commands: Type.Optional(
		Type.Array(Type.String(), {
			description: "Shell commands to run. Their combined output is sent, not shown to you.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Milliseconds to wait for each command before killing it (default 30000)" }),
	),
	perSource: Type.Optional(
		Type.Boolean({ description: "Ask each source separately so every answer names its source (one request per source)" }),
	),
});

interface Spec {
	id?: string;
	instructions: string;
	type?: QuestionType;
	criteria?: string[];
}

/** Turn the tool's question list into the API's typed questions. */
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
			questions[id] = noul(instructions);
		}
	});
	return questions;
}

function blockFor(block: SourceBlock, index: number): SourceBlock {
	return { ...block, label: `${index}: ${block.label}` };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_jev",
		label: "Ask Jev",
		description:
			"Answer typed yes/no, choice and score questions about text you never see: inline text, files or globs " +
			"(paths), or the output of shell commands (commands). Prefer this over pasting large output into the " +
			"conversation: the sources are sent to a System One endpoint and only the answers return. Use it to " +
			"classify, triage, check claims against a log, or pull facts out of many files in one request.",
		promptSnippet: "Answer typed questions about command output without loading it into context",
		parameters: AskParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const { endpoint, options } = resolve(ctx.cwd, EXTENSION, ctx.isProjectTrusted());
			const maxQuestions = numberOption(options, "maxQuestions", 32);
			const maxCommandBytes = numberOption(options, "maxCommandBytes", 400_000);
			const commandTimeoutMs = params.timeout ?? numberOption(options, "commandTimeoutMs", 30_000);
			const headChars = numberOption(options, "maxHeadChars", 300);

			try {
				const questions = buildQuestions(params.questions as Spec[], maxQuestions);
				const blocks: SourceBlock[] = [];
				const notes: string[] = [];

				for (const command of params.commands ?? []) {
					const result = await runCommand(command, { cwd: ctx.cwd, timeoutMs: commandTimeoutMs, maxBytes: maxCommandBytes, signal });
					const block: SourceBlock = {
						label: `$ ${command}`,
						origin: command,
						text: result.text,
						originalBytes: result.originalBytes,
						truncated: result.truncated,
					};
					const path = join(tmpdir(), `pi-ask-jev-${randomUUID().slice(0, 8)}.log`);
					await writeFile(path, result.text, "utf8");
					block.savedOutput = path;
					blocks.push(block);
					if (result.timedOut) notes.push(`${command}: timed out after ${commandTimeoutMs}ms`);
					else if (result.exitCode !== 0) notes.push(`${command}: exit ${result.exitCode}`);
				}
				if (blocks.length === 0) throw new Error("nothing to ask about: pass at least one command");

				const labelled = blocks.map(blockFor);
				const model = typeof options.model === "string" ? options.model : undefined;
				// `state` is not a source: it is context for reading the sources, put
				// in front of them so every question is judged in the same frame.
				const context = params.state?.trim();
				const state = context ? `--- context ---\n${context}\n\n${renderBlocks(labelled)}` : renderBlocks(labelled);
				const started = Date.now();

				let answers: Record<string, JevAnswer>;
				let usage: Usage | undefined;
				let endpointName = endpoint.name;
				const sources: Record<string, string[]> = {};

				if (params.perSource && labelled.length > 1) {
					// One request per source; the most confident answer per question wins.
					const best: Record<string, { answer: (typeof answers)[string]; label: string; confidence: number }> = {};
					for (const block of labelled) {
						// Context plus this source alone, so per-source still means per source.
						const scoped = context ? `--- context ---\n${context}\n\n--- source ---\n${block.text}` : block.text;
						const result = await classify(ctx, scoped, questions, { signal, model });
						usage = result.usage;
						endpointName = result.provider;
						for (const [id, answer] of Object.entries(result.answers)) {
							const confidence =
								answer.type === "bool" ? Math.abs(answer.probability - 0.5) * 2 : answer.confidence;
							const current = best[id];
							if (!current || confidence > current.confidence) best[id] = { answer, label: block.label, confidence };
							(sources[id] ??= []).push(block.label);
						}
					}
					answers = Object.fromEntries(Object.entries(best).map(([id, b]) => [id, b.answer]));
					for (const [id, entry] of Object.entries(best)) sources[id] = [entry.label];
				} else {
					const result = await classify(ctx, state, questions, { signal, model });
					answers = result.answers;
					usage = result.usage;
					endpointName = result.provider;
				}

				const elapsedMs = Date.now() - started;
				const totalBytes = blocks.reduce((sum, block) => sum + block.originalBytes, 0);
				const header = `[ask_jev ${endpointName} ${elapsedMs}ms, ${blocks.length} source(s), ${totalBytes} bytes, ${usage?.input ?? "?"} input tokens]`;
				const sourceLine = (label: string) => {
					const block = labelled.find((entry) => entry.label === label);
					const bytes = `(${block?.originalBytes ?? 0} bytes${block?.truncated ? ", truncated" : ""})`;
					return `source ${label} ${bytes}${block?.savedOutput ? ` ${block.savedOutput}` : ""}`;
				};
				const answerLine = (id: string) => `${id}: ${formatAnswer(answers[id])}`;
				const answerIds = Object.keys(answers);

				let body: string[];
				if (params.perSource && labelled.length > 1) {
					// Each source was asked on its own, so group the answers under the
					// source that produced them.
					const groups = new Map<string, string[]>();
					for (const id of answerIds) {
						const label = sources[id]?.[0];
						if (!label) continue;
						if (!groups.has(label)) groups.set(label, []);
						groups.get(label)!.push(answerLine(id));
					}
					body = [...groups.entries()].flatMap(([label, lines]) => [sourceLine(label), ...lines, ""]);
				} else {
					body = [labelled.map((block) => sourceLine(block.label)).join("\n"), "", ...answerIds.map(answerLine)];
				}

				return {
					...text([header, "", ...body, ...(notes.length ? ["", ...notes] : [])].join("\n")),
					details: {
						answers,
						sources,
						usage,
						elapsedMs,
						endpoint: endpointName,
						model,
						sourcesRead: labelled.map((block, index) => ({
							index,
							label: block.label,
							path: block.path,
							savedOutput: block.savedOutput,
							bytes: block.originalBytes,
							truncated: block.truncated,
						})),
						notes,
						heads:
							headChars > 0
								? Object.fromEntries(
										labelled
											.filter((block) => Object.values(sources).some((list) => list.includes(block.label)))
											.map((block) => [block.label, block.text.slice(0, headChars)]),
									)
								: undefined,
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
				const result = await classify(ctx, state || question, { q1: noul(question) });
				ctx.ui.notify(formatAnswer(result.answers.q1), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
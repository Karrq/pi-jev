/**
 * Types and helpers for the System One contract (https://docs.typesafe.ai).
 *
 * A request is a state plus typed questions. A state is ingested once and every
 * question is answered against it in a single forward pass, with no generation:
 *
 *   choice  { criteria: {label: description, ...} }  -> one label + distribution
 *   score   { criteria: ["low", "medium", "high"] }   -> level distribution + mean
 *   noul    { criteria?: {true, false} }              -> probability it is true
 */

export type JevQuestion =
	| { type: "choice"; instructions?: string; criteria: Record<string, string> }
	| { type: "score"; instructions?: string; criteria: string[] }
	| { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } };

export type QuestionType = JevQuestion["type"];

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
	legend: Record<string, unknown>;
	probabilities: Record<string, number>;
}

export interface NoulAnswer {
	type: "noul";
	noul: number;
}

export type JevAnswer = ChoiceAnswer | ScoreAnswer | ScoreAnswer | NoulAnswer;

export interface SystemOneRequest {
	state: string | Record<string, unknown> | unknown[];
	model?: string;
	questions: Record<string, JevQuestion>;
}

export interface SystemOneResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** Yes/no probability, whichever way the answer was spelled. */
export function noulProbability(answer: JevAnswer): number {
	if (answer.type === "noul") return answer.noul;
	if (answer.type === "choice") {
		const entries = Object.entries(answer.probabilities);
		const yes = entries.find(([label]) => /^(true|yes)$/i.test(label));
		const no = entries.find(([label]) => /^(false|no)$/i.test(label));
		if (yes && no) return yes[1];
	}
	throw new Error(`answer is not a yes/no answer: ${JSON.stringify(answer)}`);
}

/** The highest-probability label, its probability, and the server's confidence. */
export function topLabel(answer: JevAnswer): { label: string; probability: number; confidence: number } {
	if (answer.type === "choice") {
		const entries = Object.entries(answer.probabilities);
		const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
		return { label: best[0], probability: best[1], confidence: answer.confidence };
	}
	if (answer.type === "score") {
		const entries = Object.entries(answer.probabilities);
		const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
		return { label: best[0], probability: best[1], confidence: answer.confidence };
	}
	return { label: answer.noul >= 0.5 ? "true" : "false", probability: answer.noul, confidence: Math.abs(answer.noul - 0.5) * 2 };
}

/** Full distribution, label to probability, for any answer type. */
export function distribution(answer: JevAnswer): Record<string, number> {
	if (answer.type === "noul") return { true: answer.noul, false: 1 - answer.noul };
	return answer.probabilities;
}

export function formatAnswer(answer: JevAnswer): string {
	const dist = distribution(answer);
	const parts = Object.entries(dist)
		.sort((a, b) => b[1] - a[1])
		.map(([label, p]) => `${label} ${(p * 100).toFixed(1)}%`);
	const head = answer.type === "score" ? `mean level ${answer.score.toFixed(2)}` : topLabel(answer).label;
	return `${head} (${parts.join(", ")})`;
}

/** Build a choice question from `label -> description` pairs. */
export function choice(instructions: string, criteria: Record<string, string>): JevQuestion {
	return { type: "choice", instructions, criteria };
}

/** Build a score question from ordered level descriptions. */
export function score(instructions: string, levels: string[]): JevQuestion {
	return { type: "score", instructions, criteria: levels };
}

/** Build a yes/no question. */
export function noul(instructions: string, yes?: string, no?: string): JevQuestion {
	return { type: "noul", instructions, criteria: yes || no ? { true: yes, false: no } : undefined };
}
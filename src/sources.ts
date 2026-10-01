/**
 * Gathering text for a System One request without putting it in the model's context.
 *
 * Two kinds of source: files (with globs) and shell commands. Both are read or run
 * here, sent to the endpoint, and only small excerpts come back. That is the point:
 * the model gets answers about 40k tokens of output without reading 40k tokens.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { glob } from "node:fs/promises";

export interface SourceBlock {
	/** How this block is labelled in the request and in the result details. */
	label: string;
	/** The path or command this came from. */
	origin: string;
	/** Absolute path for file blocks; unset for command output. */
	path?: string;
	/** Temp file holding this block's full text, when it was saved. */
	savedOutput?: string;
	text: string;
	/** Bytes before any cap was applied. */
	originalBytes: number;
	truncated: boolean;
}

export interface ResolveOptions {
	cwd: string;
	/** Skip files larger than this many bytes. */
	maxFileBytes?: number;
	maxFiles?: number;
	/** Skip directories that would produce this many matches. */
	maxMatches?: number;
}

const DEFAULT_MAX_FILE_BYTES = 2 << 20;
const DEFAULT_MAX_FILES = 40;

/**
 * Expand `paths` against the working directory.
 *
 * A plain path is read as-is. A glob (`src/**` + `/ *.ts`, or `*.log`) is expanded,
 * and a directory is walked recursively for files. Results are sorted and
 * deduplicated so two patterns matching the same file produce one block.
 */
export async function readPathPatterns(patterns: string[], options: ResolveOptions): Promise<{
	blocks: SourceBlock[];
	missing: string[];
	skipped: { origin: string; reason: string }[];
}> {
	const { cwd, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxFiles = DEFAULT_MAX_FILES } = options;
	const missing: string[] = [];
	const skipped: { origin: string; reason: string }[] = [];
	const seen = new Set<string>();
	const blocks: SourceBlock[] = [];

	for (const pattern of patterns) {
		const absolute = isAbsolute(pattern) ? pattern : resolvePath(cwd, pattern);
		const isGlob = /[*?[{]/.test(pattern);
		let candidates: string[];
		if (isGlob) {
			candidates = [];
			for await (const match of glob(absolute, { withFileTypes: false })) candidates.push(String(match));
		} else {
			candidates = [absolute];
		}
		if (candidates.length === 0) {
			missing.push(pattern);
			continue;
		}
		for (const candidate of candidates.sort()) {
			if (seen.has(candidate)) continue;
			let info;
			try {
				info = await stat(candidate);
			} catch {
				missing.push(pattern);
				continue;
			}
			if (info.isDirectory()) {
				for await (const match of glob(resolvePath(candidate, "**/*"), { withFileTypes: false })) {
					const file = String(match);
					if (seen.has(file)) continue;
					seen.add(file);
					const entry = await readOne(file, cwd, maxFileBytes, blocks, skipped);
					if (entry === false) missing.push(file);
				}
				continue;
			}
			seen.add(candidate);
			await readOne(candidate, cwd, maxFileBytes, blocks, skipped);
		}
	}

	if (blocks.length > maxFiles) {
		for (const extra of blocks.splice(maxFiles)) skipped.push({ origin: extra.origin, reason: `maxFiles ${maxFiles}` });
	}
	return { blocks, missing, skipped };
}

async function readOne(
	file: string,
	cwd: string,
	maxFileBytes: number,
	blocks: SourceBlock[],
	skipped: { origin: string; reason: string }[],
): Promise<boolean> {
	const rel = relative(cwd, file) || file;
	let info;
	try {
		info = await stat(file);
	} catch {
		return false;
	}
	if (!info.isFile()) {
		skipped.push({ origin: rel, reason: "not a regular file" });
		return true;
	}
	if (info.size > maxFileBytes) {
		skipped.push({ origin: rel, reason: `${info.size} bytes over maxFileBytes ${maxFileBytes}` });
		return true;
	}
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		skipped.push({ origin: rel, reason: "not readable as utf8" });
		return true;
	}
	blocks.push({ label: rel, origin: rel, path: file, text, originalBytes: info.size, truncated: false });
	return true;
}

export interface CommandResult {
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	text: string;
	originalBytes: number;
	truncated: boolean;
}

/**
 * Run a command and capture its combined output, capped at `maxBytes`.
 *
 * `timeoutMs` bounds the wait. Output beyond the cap is cut with a marker so the
 * model knows it is looking at a prefix.
 */
export async function runCommand(
	command: string,
	options: { cwd: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<CommandResult> {
	const { cwd, timeoutMs = 30_000, maxBytes = 400_000 } = options;
	return new Promise((resolveResult) => {
		const child = spawn(command, { cwd, shell: true, env: process.env });
		let out = "";
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const append = (chunk: Buffer) => {
			if (out.length <= maxBytes * 2) out += chunk.toString("utf8");
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			const originalBytes = Buffer.byteLength(out, "utf8");
			const truncated = originalBytes > maxBytes;
			resolveResult({
				command,
				exitCode,
				timedOut,
				text: truncated ? `${out.slice(0, maxBytes)}\n[output truncated at ${maxBytes} bytes of ${originalBytes}]` : out,
				originalBytes,
				truncated,
			});
		};
		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			out += `\n[failed to start: ${error.message}]`;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

/** Render blocks as one labelled state, keeping the source of every part visible. */
export function renderBlocks(blocks: SourceBlock[]): string {
	return blocks
		.map((block, index) => `--- source ${index}: ${block.label} ---\n${block.text}`)
		.join("\n\n");
}

/** A short window of a source around a character offset, for citation. */
export function excerptAround(text: string, offset: number, radius = 200): string {
	const start = Math.max(0, offset - radius);
	const end = Math.min(text.length, offset + radius);
	return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
}
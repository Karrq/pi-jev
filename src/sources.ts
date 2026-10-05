/**
 * Gathering text for a System One request without putting it in the model's context.
 *
 * Two kinds of source: files (with globs) and shell commands. Both are read or run
 * here, sent to the endpoint, and only small excerpts come back. That is the point:
 * the model gets answers about 40k tokens of output without reading 40k tokens.
 */

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { glob } from "node:fs/promises";
import { Gitignore } from "./gitignore.ts";

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
	/** Stop reading past this many characters across all files. */
	maxChars?: number;
}

/**
 * `<i>/src/**` -> { pattern: "src/**", includeIgnored: true }. An unknown flag is
 * an error. Without flags a pattern skips whatever .gitignore would.
 */
export function parsePattern(raw: string): { pattern: string; includeIgnored: boolean } {
	const match = /^<([a-z]*)>\/(.+)$/.exec(raw);
	if (!match) return { pattern: raw, includeIgnored: false };
	const flags = new Set(match[1].split(""));
	const unknown = [...flags].filter((flag) => flag !== "i");
	if (unknown.length) throw new Error(`unknown flag(s) ${unknown.map((flag) => `<${flag}>`).join(", ")} in pattern ${raw}; only <i> (include gitignored files) exists`);
	return { pattern: match[2], includeIgnored: flags.has("i") };
}

const DEFAULT_MAX_FILE_BYTES = 2 << 20;
const DEFAULT_MAX_FILES = 40;

/**
 * Expand `paths` against the working directory.
 *
 * A plain path is read as-is. A glob (`src/**` + `/ *.ts`, or `*.log`) is expanded,
 * and a directory is walked recursively for files. Results are sorted and
 * deduplicated so two patterns matching the same file produce one block.
 *
 * A pattern may carry `<flags>/` in front of it; `i` includes the files and
 * directories .gitignore excludes, which are skipped otherwise.
 *
 * Reading stops at maxFiles files or maxChars characters, whichever comes first;
 * one file is always read even when it alone exceeds maxChars.
 */

/** Every file under `dir`, pruning directories .gitignore excludes. */
export async function listFiles(dir: string, options: { includeIgnored: boolean; gitignore: Gitignore; limit?: number }): Promise<string[]> {
	const { includeIgnored, gitignore, limit = Number.POSITIVE_INFINITY } = options;
	const files: string[] = [];
	const queue = [dir];
	while (queue.length && files.length < limit) {
		const current = queue.shift()!;
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (includeIgnored || !(await gitignore.dirIgnored(full))) queue.push(full);
				continue;
			}
			if (includeIgnored || !(await gitignore.isIgnored(full))) files.push(full);
		}
	}
	return files;
}

/** Glob to a regex over absolute paths, with `**` crossing directories and `*` not matching a dot. */
export function globToRegExp(pattern: string): RegExp {
	const normalised = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalised.split("/");
	let out = "";
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const last = index === parts.length - 1;
		if (part === "**") {
			out += last ? ".+" : "(?:[^/]+/)*";
			continue;
		}
		out += part
			.split("")
			.map((char, position) => {
				if (char === "*") return position === 0 && !part.startsWith(".") ? "(?!\\.)[^/]*" : "[^/]*";
				if (char === "?") return "[^/]";
				return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			})
			.join("");
		if (!last) out += "/";
	}
	return new RegExp(`^${out}$`);
}

/** The deepest directory a pattern can only be below, so the walk starts there. */
function literalPrefix(absolute: string): string {
	const parts = absolute.split("/");
	const firstMagic = parts.findIndex((part) => /[*?[{]/.test(part));
	if (firstMagic < 0) return absolute;
	return parts.slice(0, firstMagic).join("/") || "/";
}

export async function readPathPatterns(patterns: string[], options: ResolveOptions): Promise<{
	blocks: SourceBlock[];
	missing: string[];
	skipped: { origin: string; reason: string }[];
}> {
	const { cwd, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxFiles = DEFAULT_MAX_FILES, maxChars = Number.POSITIVE_INFINITY } = options;
	const missing: string[] = [];
	const skipped: { origin: string; reason: string }[] = [];
	const seen = new Set<string>();
	const blocks: SourceBlock[] = [];
	const gitignore = await Gitignore.load(cwd);
	// A literal path is read as given; a glob is expanded by walking from its literal
	// prefix and testing each file, so ignored directories are pruned rather than
	// expanded and filtered afterwards.
	for (const raw of patterns) {
		const { pattern, includeIgnored } = parsePattern(raw);
		const absolute = isAbsolute(pattern) ? pattern : resolvePath(cwd, pattern);
		const isGlob = /[*?[{]/.test(pattern);
		let candidates: string[];
		if (isGlob) {
			const regex = globToRegExp(absolute);
			const base = literalPrefix(absolute);
			const found = (await listFiles(base, { includeIgnored, gitignore })).filter((file) => regex.test(file));
			candidates = found.length ? found : await expandPattern(pattern, cwd);
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
				for (const file of await listFiles(candidate, { includeIgnored, gitignore })) {
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

	// The budget decides how much of the tree is read at all. Anything past it is
	// reported as a glob for the model to ask for, not as a line per file.
	const kept: SourceBlock[] = [];
	let chars = 0;
	for (const block of blocks) {
		const overFiles = kept.length >= maxFiles;
		const overChars = kept.length > 0 && chars + block.text.length > maxChars;
		if (overFiles || overChars) {
			skipped.push({ origin: block.origin, reason: overFiles ? `maxFiles ${maxFiles}` : `maxChars ${maxChars}` });
			continue;
		}
		kept.push(block);
		chars += block.text.length;
	}
	blocks.length = 0;
	blocks.push(...kept);
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

/** Every file a pattern matches, ignored directories included. Used to describe what was not read. */
export async function expandPattern(pattern: string, cwd: string): Promise<string[]> {
	const absolute = isAbsolute(pattern) ? pattern : resolvePath(cwd, pattern);
	const matches: string[] = [];
	for await (const match of glob(absolute, { withFileTypes: false })) matches.push(String(match));
	return matches;
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
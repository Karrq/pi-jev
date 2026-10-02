/**
 * Reading .gitignore so a scan skips what git would skip.
 *
 * The rules are git's own: one `.gitignore` per directory, each pattern relative
 * to that directory, last match wins, `!` negates. Nested files are picked up as
 * the walk reaches them, so a monorepo excluding each package's dist costs
 * nothing when the scan never goes there.
 *
 * Not implemented: `core.excludesFile`, `.git/info/exclude`, submodules. Those
 * only add exclusions, so a scan here may read a file git ignores.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

interface Rule {
	regex: RegExp;
	negate: boolean;
	dirOnly: boolean;
	base: string;
}

const GITIGNORE = ".gitignore";
const MAX_FILES = 500;

/** One gitignore line to a regex over paths relative to its own directory. */
export function ruleFrom(line: string, base: string): Rule | null {
	let pattern = line;
	if (!pattern || /^\s*(#|$)/.test(pattern)) return null;
	// Trailing spaces are not significant unless escaped.
	pattern = pattern.replace(/(?<!\\)\s+$/, "");
	let negate = false;
	if (pattern.startsWith("!")) {
		negate = true;
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("\\")) pattern = pattern.slice(1);
	let dirOnly = false;
	if (pattern.endsWith("/")) {
		dirOnly = true;
		pattern = pattern.slice(0, -1);
	}
	// A slash anywhere but the end anchors the pattern to its directory.
	const anchored = pattern.includes("/");
	if (pattern.startsWith("/")) pattern = pattern.slice(1);

	const parts = pattern.split("/").filter((part) => part !== "" && part !== ".");
	const last = parts.pop();
	const head = parts
		.map((part) => (part === "**" ? "(?:[^/]+/)*" : `${escapeSegment(part)}/`))
		.join("");
	const tail = translate(last ?? "");
	const prefix = base === "" ? "" : `${escapeSegment(base)}/`;
	const body = anchored ? `^${prefix}${head}${tail}` : `^${prefix}(?:.*/)?${head}${tail}`;
	// `build` matches the file or directory of that name; `build/` matches the
	// directory and everything under it.
	return { regex: new RegExp(dirOnly ? `${body}(?:/.*)?$` : `${body}(?:/|$)`), negate, dirOnly, base };
}

function escapeSegment(segment: string): string {
	return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** gitignore wildcards to a regex, `**` crossing directories and the rest not. */
function translate(pattern: string): string {
	let out = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index++;
				if (pattern[index + 1] === "/") {
					index++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "[") {
			const close = pattern.indexOf("]", index);
			if (close > index) {
				out += pattern.slice(index, close + 1);
				index = close;
			} else {
				out += "\\[";
			}
		} else {
			out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return out;
}

export class Gitignore {
	private files = 0;
	private cache = new Map<string, Promise<Rule[]>>();

	constructor(private root: string) {}

	static async load(root: string): Promise<Gitignore> {
		const matcher = new Gitignore(isAbsolute(root) ? root : resolve(root));
		await matcher.rules(matcher.root);
		return matcher;
	}

	/** True when git would ignore this path. `.git` itself always counts. */
	async isIgnored(absolute: string): Promise<boolean> {
		const parts = relative(this.root, absolute).split(/[/\\]/);
		if (parts.includes(".git")) return true;
		const rel = parts.join("/");
		if (!rel || rel.startsWith("..")) return false;
		let ignored = false;
		// The deepest .gitignore decides first, so walk from the file's own directory
		// up to the root and let the last match win.
		for (let depth = parts.length; depth > 0; depth--) {
			for (const rule of await this.rules(join(this.root, ...parts.slice(0, depth - 1)))) {
				if (rule.regex.test(rel)) ignored = !rule.negate;
			}
		}
		return ignored;
	}

	private rules(dir: string): Promise<Rule[]> {
		let pending = this.cache.get(dir);
		if (!pending) {
			if (this.files >= MAX_FILES) return Promise.resolve([]);
			this.files++;
			const base = relative(this.root, dir);
			pending = readFile(join(dir, GITIGNORE), "utf8").then(
				(text) =>
					text
						.split(/\r?\n/)
						.map((line) => ruleFrom(line, base))
						.filter((rule): rule is Rule => rule !== null),
				() => [],
			);
			this.cache.set(dir, pending);
		}
		return pending;
	}
}
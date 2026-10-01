/**
 * One-off fetch of Artificial Analysis figures for the models this setup routes
 * between, written to data/aa-intelligence.json. Not run automatically: refresh it
 * by hand when you want new numbers.
 *
 *   node tools/aa-intelligence.mjs
 *
 * Artificial Analysis publishes a page per model *and reasoning effort*, so each
 * effort is a separate row here: claude-opus-5-5-medium is its own entry with its
 * own Intelligence Index, price and speed. That is the point, since a strong model
 * at low effort can beat a cheaper one at high.
 *
 * Figures come from the four stat tiles and the pricing sentence that
 * artificialanalysis.ai server-renders on each model page. Latency is not among
 * them, so it is absent rather than guessed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Model pages to read, with the pi label each one describes. */
const PAGES = [
	["claude-opus-5-5", "claude-bridge/claude-opus-5-5"],
	["claude-opus-5-5-low", "claude-bridge/claude-opus-5-5"],
	["claude-opus-5-5-medium", "claude-bridge/claude-opus-5-5"],
	["claude-opus-5-5-high", "claude-bridge/claude-opus-5-5"],
	["claude-opus-5-5-xhigh", "claude-bridge/claude-opus-5-5"],
	["claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5"],
	["claude-sonnet-5-5-low", "claude-bridge/claude-sonnet-5-5"],
	["claude-sonnet-5-5-medium", "claude-bridge/claude-sonnet-5-5"],
	["claude-sonnet-5-5-high", "claude-bridge/claude-sonnet-5-5"],
	["claude-sonnet-5-5-xhigh", "claude-bridge/claude-sonnet-5-5"],
	["claude-4-5-haiku", "claude-bridge/claude-haiku-4-5"],
];

function tiles(html) {
	const found = new Map();
	const pattern = /<span>([^<]{1,12})<\/span><\/div><div class="text-xs text-neutral-500 max-w-\[20ch\]">([^<]+)<\/div>/g;
	for (const [, value, label] of html.matchAll(pattern)) found.set(label.trim(), value.trim());
	return found;
}

function number(text) {
	const match = /-?[\d.]+/.exec(text ?? "");
	return match ? Number(match[0]) : undefined;
}

async function read(slug) {
	const url = `https://artificialanalysis.ai/models/${slug}`;
	const response = await fetch(url, { headers: { "user-agent": "pi-jev/1.0 (local model router notes)" } });
	if (!response.ok) return { slug, url, error: `HTTP ${response.status}` };
	const html = (await response.text()).replace(/\\"/g, '"');
	const stat = tiles(html);
	// Evaluated pages say "X scores N on the Artificial Analysis"; unevaluated ones
	// show N/A, so fall back to the page title for those.
	const displayName =
		/(Claude [^<"]{3,80}?) scores \d+ on the Artificial Analysis/.exec(html)?.[1]?.trim() ??
		/<title>([^<]{3,120}?)\s*[|<-]/.exec(html)?.[1]?.trim();
	const pricing = /Pricing for ([^<]{3,140}?) is \$([\d.]+) per 1M input tokens.*?\$([\d.]+) per 1M output tokens/.exec(html);
	const index = number(stat.get("Artificial Analysis Intelligence Index"));
	return {
		slug,
		url,
		label: displayName,
		index,
		outputTokensPerSecond: number(stat.get("Output tokens per second")),
		costPerTaskUsd: number((stat.get("Cost per Intelligence Index task") ?? "").replace("$", "")),
		outputTokensPerTask: stat.get("Output tokens from Intelligence Index"),
		priceIn: pricing ? Number(pricing[2]) : undefined,
		priceOut: pricing ? Number(pricing[3]) : undefined,
	};
}

const rows = [];
for (const [slug, model] of PAGES) {
	const row = await read(slug);
	row.model = model;
	rows.push(row);
	console.log(
		`${slug.padEnd(26)} index ${String(row.index ?? "-").padStart(3)}  $${row.priceIn ?? "-"}/${row.priceOut ?? "-"}  ${row.outputTokensPerSecond ?? "-"} tok/s  $${row.costPerTaskUsd ?? "-"}/task  ${row.error ?? ""}`,
	);
}

const payload = {
	source: "https://artificialanalysis.ai",
	fetchedAt: new Date().toISOString().slice(0, 10),
	index: "Artificial Analysis Intelligence Index",
	note: "One row per model and reasoning effort. Latency is not published in the page's stat tiles and is absent here.",
	rows,
};
mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "aa-intelligence.json"), `${JSON.stringify(payload, null, "\t")}\n`);
console.log(`\nwrote data/aa-intelligence.json (${rows.length} rows)`);

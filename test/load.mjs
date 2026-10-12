/**
 * Loads every extension with pi's own jiti and checks what it registers, then
 * runs one real request per tool against the configured endpoint.
 *
 *   node test/load.mjs            # load and register only
 *   node test/load.mjs --schema   # print what the tools look like to the model
 *   node test/load.mjs --live     # also call the tools against the endpoint
 */

import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Pi injects these packages into extensions; standalone they only exist in pi's
// own node_modules, so point jiti at them the way pi does.
const piDir = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createRequire } = await import("node:module");
const piRequire = createRequire(`${piDir}/package.json`);
// Only typebox is imported at runtime; the pi packages are type-only imports.
const alias = { typebox: piRequire.resolve("typebox") };
const jiti = createJiti(import.meta.url, { interopDefault: true, alias });

// The provider path the extensions now use. jiti strips the type-only imports, so
// this brings in the transport without pi running.
const { providerClassify, API: JEV_API } = await jiti.import(join(root, "src/classifier.ts"));
const { resolve: resolveJev } = await jiti.import(join(root, "src/config.ts"));
const jevEndpoint = resolveJev(root, "provider", false).endpoint;
const jevClassifier = {
	type: "classifier",
	provider: "local-jev",
	id: jevEndpoint.model ?? "open-jev",
	api: JEV_API,
	baseUrl: `${jevEndpoint.url.replace(/\/+$/, "")}/v1`,
	headers: jevEndpoint.headers ?? {},
};
const jevRegistry = {
	getModelsOfType: (type, provider) => (type === "classifier" && provider === "local-jev" ? [jevClassifier] : []),
	findOfType: (type, provider, id) =>
		type === "classifier" && provider === "local-jev" && jevClassifier.id === id ? jevClassifier : undefined,
	classify: (model, context, options) =>
		providerClassify(model, context, { ...options, apiKey: jevEndpoint.apiKey ?? "local" }),
};

const schemaMode = process.argv.includes("--schema");
const recorded = [];
const notified = [];
const registered = { tools: [], commands: [], events: [], virtualModels: [], schema: [] };
const tools = new Map();
// Handlers are kept so a test can fire an event the way pi does, not just check the name.
const handlers = new Map();
const stub = {
	registerTool: (tool) => {
		tools.set(tool.name, tool);
		registered.tools.push({ name: tool.name, description: tool.description.slice(0, 60) });
		if (schemaMode) registered.schema.push(tool);
	},
	registerCommand: (name, options) => registered.commands.push(`${name}: ${options.description}`),
	registerVirtualModel: (model) => registered.virtualModels.push(`${model.provider}/${model.id} (${model.name}) levels=${model.thinkingLevels.join(",")}`),
	on: (event, handler) => {
		registered.events.push(event);
		handlers.set(event, handler);
	},
	registerShortcut: () => {},
	registerFlag: () => {},
	registerProvider: () => {},
	registerMessageRenderer: () => {},
	registerMarkdownTransformer: () => {},
	registerEntryRenderer: () => {},
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	getCommands: () => [],
};

const ctx = {
	cwd: root,
	mode: "print",
	hasUI: false,
	isProjectTrusted: () => false,
	signal: undefined,
	sessionManager: { getBranch: () => [] },
	appendEntry: (customType, data) => { recorded.push({ customType, data }); },
	ui: { notify: (message, level) => { notified.push({ message, level }); } },
	getScopedModels: () => [
		{ provider: "anthropic", id: "claude-haiku-4-5", model: { id: "claude-haiku-4-5" } },
		{ provider: "anthropic", id: "claude-opus-5-5", model: { id: "claude-opus-5-5" } },
	],
	scopedModels: [],
	model: undefined,
	modelRegistry: jevRegistry,
	ui: { notify: (message, level) => { notified.push({ message, level }); console.log(`  [ui.${level}] ${message.split("\n")[0]}`); }, confirm: async () => false },
};

const files = readdirSync(join(root, "extensions")).filter((f) => f.endsWith(".ts")).sort();
for (const file of files) {
	const path = join(root, "extensions", file);
	const module = await jiti.import(path);
	const factory = module.default ?? module;
	if (typeof factory !== "function") throw new Error(`${file} has no default factory export`);
	await factory(stub);
	console.log(`ok ${file}`);
}
console.log("\nregistered:", JSON.stringify({ ...registered, schema: registered.schema.map((tool) => tool.name) }, null, 1));
if (schemaMode) {
	for (const tool of registered.schema) {
		console.log(`\n${"=".repeat(76)}\n${tool.name}   label: ${tool.label}\n${"=".repeat(76)}`);
		console.log(`promptSnippet: ${tool.promptSnippet ?? "(none)"}`);
		console.log(`\ndescription:\n${tool.description}`);
		console.log(`\nparameters:\n${JSON.stringify(tool.parameters, null, 1)}`);
	}
}

if (process.argv.includes("--tools")) {
	const { writeFileSync, mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const sample = mkdtempSync(join(tmpdir(), "pi-jev-"));
	writeFileSync(join(sample, "auth.ts"), "export function login(token: string) {\n  if (isExpired(token)) return 401;\n  return 200;\n}\n");
	const cases = {
		ask_jev: {
			commands: ["echo 'Deploy log: staging healthy, p95 210ms, error rate 0.02%.'"],
			state: "the p95 target is 250ms",
			questions: [
				{ id: "healthy", instructions: "Is the service healthy?" },
				{ id: "status", type: "score", instructions: "How bad is it?", criteria: ["fine", "degraded", "down"] },
				{ id: "cause", type: "choice", instructions: "What is the most likely next action?", criteria: ["none: do nothing", "investigate: dig into latency"] },
			],
		},
		jev_drop: {
			goal: "fix the failing login test",
			items: [
				{ id: "a", text: "Test fails: expected 200 got 401 at /login" },
				{ id: "b", text: "Deployed staging at 12:04" },
				{ id: "c", text: "Login returns 401 when the token is expired, which is the failing case" },
				{ id: "d", text: "401 Unauthorized reproduced locally with an expired token" },
				{ id: "e", text: "CI runner runs out of disk space sometimes" },
			],
			keepAt: 0.5,
		},
		jev_file: {
			paths: [join(sample, "auth.ts")],
			questions: [
				{ id: "expiry", instructions: "Does this file return 401 for an expired token?" },
				{ id: "signature", type: "choice", instructions: "What does login take?", criteria: ["token", "user", "password"] },
			],
		},
		ask_jev_saved: {
			questions: [
				{ id: "failing", instructions: "Are any tests failing?" },
				{ id: "count", type: "choice", instructions: "How many tests are failing?", criteria: ["none: zero", "some: at least one", "many: more than five"] },
				{ id: "where", instructions: "Which test suite is failing?" },
			],
			commands: ["node -e \"console.log('FAIL src/auth.test.ts\\n  expected 200 got 401')\"", "echo second source"],
			state: "count only lines starting with FAIL",
		},
		ask_jev_paths: {
			questions: [
				{ id: "has_gate", instructions: "Does the bash gate refuse commands outright above some probability of high risk?" },
				{ id: "who_blocks", type: "choice", instructions: "What happens to a command in the top risk band?", criteria: ["refused: it is blocked with the reason", "asked: a dialog asks you", "allowed: it runs with a warning"] },
			],
			commands: ["cat extensions/bash-gate.ts | head -60", "cat extensions/ask-jev.ts | head -40"],
			perSource: true,
		},
		ask_jev_sources: {
			questions: [
				{ id: "failing", instructions: "Are any tests failing?" },
				{ id: "count", type: "choice", instructions: "How many tests are failing?", criteria: ["none: zero", "some: at least one", "many: more than five"] },
			],
			commands: ["cd /Users/karrq/others/pi-jev && node -e \"console.log('simulated test output: 12 passing, 2 failing')\"", "echo exit=1"],
		},
		jev_file_glob: {
			paths: ["extensions/*.ts"],
			questions: [
				{ id: "virtual", instructions: "Does any file register a virtual model?", type: "noul" },
				{ id: "shared", type: "choice", instructions: "Which file defines the shared drop logic?", criteria: ["src/drop.ts: the drop module", "extensions/dropper.ts: the extension"] },
			],
		},

	};
	for (const [name, params] of Object.entries(cases)) {
		const toolName = name.startsWith("ask_jev_") ? "ask_jev" : name.startsWith("jev_file_") ? "jev_file" : name;
		const tool = tools.get(toolName);
		if (!tool) {
			console.log(`\n== ${name}: not registered`);
			continue;
		}
		const started = Date.now();
		const result = await tool.execute(`test-${name}`, params, undefined, undefined, ctx);
		console.log(`\n== ${name} (${Date.now() - started}ms)\n${result.content.map((c) => c.text).join("\n")}`);
		if (name.startsWith("ask_jev_") || name.startsWith("jev_file_")) console.log("details:", JSON.stringify({ sources: result.details.sources, saved: (result.details.sourcesRead ?? []).map((s) => s.savedOutput).filter(Boolean), resolvedPaths: result.details.resolvedPaths, notes: result.details.notes }, null, 1));
	}
}

if (!["--live", "--tools", "--route", "--gate"].some((flag) => process.argv.includes(flag))) process.exit(0);

if (!["--live", "--route", "--gate"].some((flag) => process.argv.includes(flag))) process.exit(0);

// Live check: one small request per extension through the same classifier the tools use.
const { resolve } = await jiti.import(join(root, "src/config.ts"));
const { classify, formatAnswer } = await jiti.import(join(root, "src/classifier.ts"));

for (const [extension, state, questions] of [
	[
		"jev-decider",
		"Deploy log: staging is healthy, latency p95 210ms, error rate 0.02%.",
		{ healthy: { type: "bool", instructions: "Is the service healthy?", criteria: { true: "Yes", false: "No" } } },
	],
	[
		"jev-dropper",
		'Goal: fix the failing login test.\n\nPool:\n[item 0 (a)]\nTest fails: expected 200 got 401 at /login\n\n[item 1 (b)]\nDeployed staging at 12:04\n\n[item 2 (c)]\nLogin returns 401 when the token is expired, which is the failing case',
		{
			keep_0: { type: "bool", instructions: "Is item 0 still needed to fix the failing login test?", criteria: { true: "Yes", false: "No" } },
			imp_0: { type: "score", instructions: "How important is item 0?", criteria: ["irrelevant", "minor", "useful", "important", "critical"] },
		},
	],
	[
		"jev-file-relevance",
		'File: src/auth.ts\nCharacters 0-64 of 64\n\nexport function login(token: string) {\n  if (isExpired(token)) return 401;\n}',
		{ expiry: { type: "bool", instructions: "Does this file return 401 for an expired token?", criteria: { true: "Yes", false: "No" } } },
	],
	[
		"jev-bash-gate",
		"Working directory: /repo\nCommand: rm -rf node_modules && npm ci",
		{ safe: { type: "bool", instructions: "Is this command safe to run right now, with no destructive, irreversible or unexpected side effects?", criteria: { true: "Yes", false: "No" } } },
	],
	[
		"jev-model-router",
		"Task: rename a variable across 40 files\n\nCandidate models:\n[0] anthropic/claude-haiku-4-5\n[1] anthropic/claude-opus-5-5",
		{ model: { type: "choice", instructions: "Which candidate model should handle this task?", criteria: { "anthropic/claude-haiku-4-5": "cheap fast model", "anthropic/claude-opus-5-5": "expensive strong model" } } },
	],
]) {
	const { sources } = resolve(process.cwd(), extension, false);
	const started = Date.now();
	const result = await classify(ctx, state, questions);
	const answers = Object.entries(result.answers)
		.map(([id, answer]) => `${id}=${formatAnswer(answer)}`)
		.join("  ");
	console.log(
		`live ${extension.padEnd(18)} ${result.provider}/${result.model} [${sources.join(", ") || "no settings"}] ${Date.now() - started}ms  ${answers}`,
	);
}


if (process.argv.includes("--route")) {
	// Call the virtual model's route() directly with a stub registry.
	const virtuals = new Map();
	stub.registerVirtualModel = (definition) => virtuals.set(`${definition.provider}/${definition.id}`, definition);
	const module = await jiti.import(join(root, "extensions", "model-router.ts"));
	(module.default ?? module)(stub);
	const definition = virtuals.get("jev/auto");
	if (!definition) throw new Error("jev/auto was not registered");

	// The real shape: claude-bridge publishes no rates, the free router has no counterpart
	// in pi's anthropic catalog, and the bridge models must borrow theirs.
	const model = (provider, id, name, cost, extra) => ({
		provider,
		id,
		name,
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: cost, output: cost * 5, cacheRead: cost / 10, cacheWrite: cost },
		...extra,
	});
	const bridge = (id, cost) => ({
		provider: "claude-bridge",
		id,
		name: id,
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
		anthropicCost: cost,
	});
	const ANTHROPIC_RATES = {
		"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	};
	const catalog = [
		{ model: bridge("claude-opus-5-5", 4) },
		{ model: bridge("claude-sonnet-5-5", 2) },
		{ model: { ...bridge("claude-haiku-4-5", 1), reasoning: false, thinkingLevelMap: { off: "off" } } },
		{ model: model("openrouter", "space-bunny-alpha", "Space Bunny Alpha", 0, { reasoning: false }) },
	];
	const routeCtx = {
		cwd: root,
		appendEntry: (customType, data) => { recorded.push({ customType, data }); },
		ui: { notify: (message, level) => { notified.push({ message, level }); } },
		isProjectTrusted: () => process.env.TRUSTED === "1",
		settingsOverride: { profiles: { "openrouter/space-bunny-alpha": { notes: "minimax-m3.1, unreleased, free. Code quality on par with DeepSeek V4 Flash (AA 34), just under GLM 5.3 Flash (AA 42), below both otherwise.", index: 37, costPerTask: 0 } } },
		// Real pi exposes the enabled set as ctx.scopedModels; the getter is the older shape.
		scopedModels: catalog,
		getScopedModels: () => catalog,
		modelRegistry: {
			...jevRegistry,
			find: (provider, id) => {
				if (provider === "anthropic" && ANTHROPIC_RATES[id]) {
					return { provider, id, cost: ANTHROPIC_RATES[id] };
				}
				return catalog.find((m) => m.model.provider === provider && m.model.id === id)?.model;
			},
		},
	};
	const message = (text) => ({ role: "user", content: text });
	// Pi exposes the enabled models as ctx.scopedModels; a context with neither that nor
	// getScopedModels must fall back to the enabledModels patterns in settings.
	{
		const bare = {
			cwd: root,
			isProjectTrusted: () => false,
			modelRegistry: routeCtx.modelRegistry,
		};
		const started = Date.now();
		const routed = await definition.route(
			{ reason: "user", messages: [{ role: "user", content: "rename a variable across 40 files" }], thinkingLevel: "medium" },
			bare,
		);
		console.log(`route bare ctx (settings fallback) -> ${routed.model.provider}/${routed.model.id} @ ${routed.thinkingLevel} (${Date.now() - started}ms)`);
	}

	// Stickiness: the same proposal, priced against a warm Opus cache, at three turn
	// sizes. A transcript carries real usage, so the router can size the turn itself.
	if (process.env.CHECK_WHY || process.env.STICKINESS) {
		// Canned answers so the proposal is known: Opus slightly ahead, Sonnet close
		// behind and cheaper, which is the case the stickiness rule exists for.
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(init.body);
			const answers = {};
			const fits = JSON.parse(process.env.FITS ?? "[3.0,1.2,2.9,1.0]");
			for (const [index, fit] of fits.entries()) {
				answers[`fit_${index}`] = {
					type: "score",
					score: fit,
					confidence: 0.8,
					legend: {},
					probabilities: { cannot: 0, poorly: 0, adequately: 1 - fit / 4, well: fit / 4, expertly: 0 },
				};
			}
			const lengthLevels = ["one answer and done", "one task, finished here", "a few steps with check-ins", "a multi-step piece of work", "a project over many turns"];
			const lengthPick = Number(process.env.LENGTH_LEVEL ?? 3);
			answers.length = {
				type: "score",
				score: lengthPick,
				confidence: 0.9,
				legend: {},
				probabilities: Object.fromEntries(lengthLevels.map((label, index) => [label, index === lengthPick ? 0.9 : 0.025])),
			};
			answers.depth = {
				type: "score",
				score: 2,
				confidence: 0.8,
				legend: {},
				probabilities: { off: 0, low: 0.2, medium: 0.7, high: 0.1, xhigh: 0, max: 0 },
			};
			void body;
			return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const opus = catalog[0].model;
		const transcript = (outputTokens) => [
			{ role: "user", content: "keep going" },
			{
				role: "assistant",
				provider: opus.provider,
				model: opus.id,
				content: [{ type: "text", text: "ok" }],
				usage: { input: 2000, output: outputTokens, cacheRead: 38000, cacheWrite: 0, totalTokens: 0, cost: {} },
			},
		];
		for (const outputTokens of [800]) {
			const started = Date.now();
			const routed = await definition.route(
				{ reason: "user", messages: transcript(outputTokens), previous: { model: opus, thinkingLevel: "medium" }, thinkingLevel: "medium" },
				routeCtx,
			);
			console.log(`stick output=${String(outputTokens).padStart(5)} -> ${routed.model.id} @ ${routed.thinkingLevel} (${Date.now() - started}ms)`);
		}
		// CHECK_WHY reuses the canned answers after this block.
		if (!process.env.CHECK_WHY) globalThis.fetch = realFetch;
	}

	// A rate-limited model leaves the candidate list, a retry of the request that hit it
	// re-routes instead of repeating the failure, and the model comes back when the window
	// the error names has passed.
	if (process.env.RATE_LIMIT) {
		const opusLabel = `${catalog[0].model.provider}/${catalog[0].model.id}`;
		const bridgeError = (resetAt) => ({
			type: "message_end",
			ctx: { ...routeCtx },
			message: {
				role: "assistant",
				provider: catalog[0].model.provider,
				model: catalog[0].model.id,
				stopReason: "error",
				errorMessage: `Claude rate limit (five_hour) — quota exceeded, resets 1:40:00 AM: You've hit your session limit [resetsAt=${resetAt}]`,
			},
		});
		const onMessageEnd = handlers.get("message_end");
		if (!onMessageEnd) throw new Error("the router registered no message_end handler");

		const turn = (output) => [
			{ role: "user", content: "keep going" },
			{
				role: "assistant",
				provider: catalog[0].model.provider,
				model: catalog[0].model.id,
				content: [{ type: "text", text: "x" }],
				usage: { input: 100, output, cacheRead: 0, cacheWrite: 0, totalTokens: 100 + output, cost: { total: 0 } },
			},
		];
		const routeOnce = async (request) => {
			recorded.length = 0;
			const routed = await definition.route(request, routeCtx);
			const entry = recorded.at(-1)?.data ?? {};
			return {
				routed,
				entry,
				pool: (entry.candidates ?? []).map((c) => c.label),
				down: (entry.suppressed ?? []).map((c) => c.label),
			};
		};
		const check = (label, ok, detail) => console.log(`limited ${label.padEnd(26)} ${ok ? "ok" : "FAILED"}  ${detail}`);

		// A limit two hours out: the model leaves the candidate list and the state says why.
		onMessageEnd(bridgeError(Math.floor(Date.now() / 1000) + 7200));
		const limited = await routeOnce({ reason: "user", thinkingLevel: "medium", messages: turn(500) });
		check("excluded while limited", !limited.pool.includes(opusLabel) && limited.down.includes(opusLabel), `pool: ${limited.pool.join(", ") || "none"}`);
		check("reason names the limit", /rate limited: claude-bridge\/claude-opus-5-5/.test(limited.entry.decided?.why ?? ""), limited.entry.decided?.why);

		// A retry is the case that matters: staying on the model that just refused fails the
		// same way, so it has to re-route.
		const retried = await routeOnce({
			reason: "retry",
			thinkingLevel: "medium",
			messages: turn(500),
			failed: { model: catalog[0].model, thinkingLevel: "medium" },
		});
		check(
			"retry re-routes",
			retried.routed.model.id !== catalog[0].model.id && /re-routed/.test(retried.entry.decided?.why ?? ""),
			`-> ${retried.routed.model.id} @ ${retried.routed.thinkingLevel}, ${retried.entry.decided?.why}`,
		);

		// A retry that failed for some other reason still stays put, cache and all.
		const retriedElsewhere = await routeOnce({
			reason: "retry",
			thinkingLevel: "medium",
			messages: turn(500),
			failed: { model: catalog[1].model, thinkingLevel: "medium" },
		});
		check(
			"other retry stays",
			retriedElsewhere.routed.model.id === catalog[1].model.id,
			`-> ${retriedElsewhere.routed.model.id} (${retriedElsewhere.entry.decided?.why})`,
		);

		// The window the error named has passed: no timer, the next route simply sees it again.
		onMessageEnd(bridgeError(Math.floor(Date.now() / 1000) - 60));
		const restored = await routeOnce({ reason: "user", thinkingLevel: "medium", messages: turn(500) });
		check("back when the window lifts", restored.pool.includes(opusLabel) && restored.down.length === 0, `pool: ${restored.pool.join(", ") || "none"}`);
	}

	// A session with history: the state should carry the precedent, so Jev can tell a
	// follow-up to a small task from a new piece of work.
	if (process.env.SHOW_HISTORY) {
		const assistant = (model, output, id) => ({
			role: "assistant",
			provider: "claude-bridge",
			model: "claude-sonnet-5-5",
			content: [{ type: "text", text: `answer ${id ?? ""}`.trim() }],
			usage: {
				input: 2000,
				output,
				cacheRead: 38000,
				cacheWrite: 0,
				totalTokens: 40000 + output,
				// claude-bridge reports no cost, so the router has to price it from borrowed rates.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const messages = [
			{ role: "user", content: "what is the capital of France?" },
			assistant("claude-sonnet-5-5", 60, 1),
			{ role: "user", content: "now rename that variable across the 40 files that use it" },
			assistant("claude-sonnet-5-5", 900, 2),
			assistant("claude-sonnet-5-5", 1400, 3),
			assistant("claude-sonnet-5-5", 2200, 4),
			{ role: "user", content: "also check the tests still pass" },
		];
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			console.log(body.state.split("\n").slice(0, 8).join("\n"));
			const response = await realFetch(url, init);
			const answers = (await response.clone().json()).answers;
			for (const [id, answer] of Object.entries(answers)) {
				const top = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
				console.log(`   ${id.padEnd(7)} ${top ? `${top[0]} ${(top[1] * 100).toFixed(0)}%` : answer.score?.toFixed(2)}`);
			}
			return response;
		};
		const started = Date.now();
		const routed = await definition.route({ reason: "user", messages, previous: { model: catalog[1].model, thinkingLevel: "medium" }, thinkingLevel: "medium" }, routeCtx);
		globalThis.fetch = realFetch;
		console.log(`history 3 prompts -> ${routed.model.id} @ ${routed.thinkingLevel} (${Date.now() - started}ms)`);
		for (const entry of recorded.slice(-1)) {
			console.log(`recorded ${entry.customType}: ${JSON.stringify(entry.data, null, 1).slice(0, 1600)}`);
		}
		console.log(`notified: ${notified.length ? notified.map((n) => n.message.replace(/\n/g, " | ")).join(" ; ") : "(none)"}`);
	}

	if (process.env.SHOW_STATE) {
		// Print the state the router builds, including the Artificial Analysis block.
		const seen = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			seen.push(body.state);
			if (process.env.SHOW_HISTORY) {
				const history = body.state.split("\n").slice(0, 6).join("\n");
				console.log(history);
			}
			console.log(`   task: ${body.state.split("\n")[1]}`);
			const response = await originalFetch(url, init);
			const answers = (await response.clone().json()).answers;
			for (const [id, answer] of Object.entries(answers)) {
				if (id === "depth") continue;
				const top = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
				console.log(`   ${id.padEnd(7)} mean ${answer.score.toFixed(2)}  top ${top[0]} ${(top[1] * 100).toFixed(0)}%`);
			}
			const depth = answers.depth;
			const topLevel = Object.entries(depth.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
			console.log(`   depth   top ${topLevel[0]} ${(topLevel[1] * 100).toFixed(0)}%`);
			return response;
		};
		for (const task of ["rename a variable across 40 files", "what is the capital of France?"]) {
			await definition.route({ reason: "user", messages: [message(task)], thinkingLevel: "medium" }, routeCtx);
		}
		globalThis.fetch = originalFetch;
		console.log(seen.at(-1));
	}
	// The recorded reason has to describe the model change, not the proposal: a switch
	// reported as a stay is worse than no report.
	if (process.env.CHECK_WHY) {
		const scenarios = [
			// A cheaper model over a long project: the cache write amortises, so it wins.
			{ label: "switch on price", fits: "[3.0,1.2,2.95,1.0]", previous: 0, length: 4, output: 2000, switched: true },
			// The same switch on work that ends this turn: the write cannot pay for itself.
			{ label: "stay, write too big", fits: "[3.0,1.2,2.95,1.0]", previous: 0, length: 0, output: 2000, switched: false },
			// A clearly stronger model takes over from the free one despite the write.
			{ label: "switch on capability", fits: "[1.0,3.0,1.2,0.5]", previous: 3, length: 0, output: 20000, switched: true },
			// Nothing to decide: the current model was the proposal.
			{ label: "already the pick", fits: "[3.0,1.2,1.2,0.5]", previous: 0, length: 3, output: 2000, switched: false },
		];
		for (const scenario of scenarios) {
			recorded.length = 0;
			process.env.FITS = scenario.fits;
			process.env.LENGTH_LEVEL = String(scenario.length);
			const previous = catalog[scenario.previous].model;
			const routed = await definition.route(
				{
					reason: "user",
					thinkingLevel: "medium",
					messages: [
						{ role: "user", content: "keep going" },
						{
							role: "assistant",
							provider: previous.provider,
							model: previous.id,
							content: [{ type: "text", text: "ok" }],
							usage: {
								input: 2000,
								output: scenario.output,
								cacheRead: 38000,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { total: 0 },
							},
						},
					],
					previous: { model: previous, thinkingLevel: "medium" },
				},
				routeCtx,
			);
			const why = recorded.at(-1)?.data?.decided?.why ?? "(nothing recorded)";
			const changed = `${routed.model.provider}/${routed.model.id}` !== `${previous.provider}/${previous.id}`;
			const claimsSwitch = /^switched/.test(why);
			// "stayed" or "was Jev's pick anyway" both mean no change.
			const claimsStay = /^(stayed|the current model was)/.test(why);
			const ok = changed === scenario.switched && (changed ? claimsSwitch : claimsStay);
			console.log(
				`why ${scenario.label.padEnd(22)} ${changed ? "switched" : "stayed  "} -> ${why}${ok ? "" : "   <-- WRONG"}`,
			);
		}
		delete process.env.LENGTH_LEVEL;
		delete process.env.FITS;
	}

	for (const [label, request] of [
		["user, simple task", { reason: "user", messages: [message("rename a variable across 40 files")], thinkingLevel: "medium" }],
		["user, trivial task", { reason: "user", messages: [message("what is the capital of France?")], thinkingLevel: "medium" }],
		["user, hard task", { reason: "user", messages: [message("design a distributed lock protocol and prove it correct under partitions")], thinkingLevel: "medium" }],
		["continuation", { reason: "continuation", messages: [], previous: { model: catalog[1].model, thinkingLevel: "high" }, thinkingLevel: "medium" }],
		["direct", { reason: "direct", messages: [], thinkingLevel: "medium" }],
	]) {
		const started = Date.now();
		const routed = await definition.route(request, routeCtx);
		console.log(`route ${label.padEnd(18)} -> ${routed.model.provider}/${routed.model.id} @ ${routed.thinkingLevel} (${Date.now() - started}ms)`);
	}
}

if (process.argv.includes("--gate")) {
	// Drive the bash tool_call hook the way pi does when the model asks for a command.
	const module = await jiti.import(join(root, "extensions", "bash-gate.ts"));
	(module.default ?? module)(stub);
	const hook = handlers.get("tool_call");
	if (!hook) throw new Error("bash-gate did not register a tool_call handler");

	const notifications = [];
	const gateCtx = (mode, confirm = false) => ({
		cwd: root,
		mode,
		hasUI: mode === "tui",
		isProjectTrusted: () => false,
		signal: undefined,
		sessionManager: { getBranch: () => [] },
		modelRegistry: jevRegistry,
	appendEntry: (customType, data) => { recorded.push({ customType, data }); },
	ui: { notify: (message, level) => { notified.push({ message, level }); } },
		ui: { notify: (message) => notifications.push(message), confirm: async () => confirm },
	});
	const call = (command) => ({ type: "tool_call", toolName: "bash", toolCallId: "t", input: { command } });
	const allowedCtx = (mode) => ({
		...gateCtx(mode, true),
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "jev-bash-gate.allowed", data: { prefixes: ["grep *", "npm run *", "*rm -rf /tmp/*"] } }],
		},
	});

	for (const [mode, confirm] of [["print", false], ["tui", false], ["tui", true]]) {
		for (const command of ["ls -la", "npm test", "grep -rn TODO src", "rm -rf /tmp/jev-gate-nothing", "rm -rf node_modules", "rm -rf ~", "git push --force origin main", "chmod -R 777 /"]) {
			notifications.length = 0;
			const started = Date.now();
			const result = await hook(call(command), gateCtx(mode, confirm));
			const outcome = result?.block ? `BLOCKED (${result.reason.split("\n")[0].slice(0, 60)})` : "ran";
			console.log(
				`gate mode=${mode.padEnd(5)} confirm=${String(confirm).padEnd(5)} ${command.padEnd(30)} ${outcome.padEnd(70)} ${Date.now() - started}ms${notifications.length ? ` notified: ${notifications[0].split("\n")[0].slice(0, 40)}` : ""}`,
			);
		}
	}

	console.log("");
	for (const command of ["grep -rn TODO src", "grep", "npm run build", "npm run typecheck", "rm -rf /tmp/x", "rm -rf node_modules", "rm -rf ~"]) {
		const started = Date.now();
		const result = await hook(call(command), allowedCtx("tui"));
		const outcome = result?.block ? `BLOCKED: ${result.reason.split("\n")[1] ?? ""}` : "ran";
		console.log(`gate session-allowed | ${command.padEnd(24)} ${outcome} ${Date.now() - started}ms`);
	}
}

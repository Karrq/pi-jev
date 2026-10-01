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

const schemaMode = process.argv.includes("--schema");
const registered = { tools: [], commands: [], events: [], virtualModels: [], schema: [] };
const tools = new Map();
const stub = {
	registerTool: (tool) => {
		tools.set(tool.name, tool);
		registered.tools.push({ name: tool.name, description: tool.description.slice(0, 60) });
		if (schemaMode) registered.schema.push(tool);
	},
	registerCommand: (name, options) => registered.commands.push(`${name}: ${options.description}`),
	registerVirtualModel: (model) => registered.virtualModels.push(`${model.provider}/${model.id} (${model.name}) levels=${model.thinkingLevels.join(",")}`),
	on: (event) => registered.events.push(event),
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
	getScopedModels: () => [
		{ provider: "anthropic", id: "claude-haiku-4-5", model: { id: "claude-haiku-4-5" } },
		{ provider: "anthropic", id: "claude-opus-5-5", model: { id: "claude-opus-5-5" } },
	],
	scopedModels: [],
	model: undefined,
	ui: { notify: (message, level) => console.log(`  [ui.${level}] ${message.split("\n")[0]}`), confirm: async () => false },
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

// Live check: one small request per extension through the same client the tools use.
const { resolve } = await jiti.import(join(root, "src/config.ts"));
const { systemOne } = await jiti.import(join(root, "src/client.ts"));
const { formatAnswer } = await jiti.import(join(root, "src/types.ts"));

for (const [extension, state, questions] of [
	[
		"jev-decider",
		"Deploy log: staging is healthy, latency p95 210ms, error rate 0.02%.",
		{ healthy: { type: "noul", instructions: "Is the service healthy?" } },
	],
	[
		"jev-dropper",
		'Goal: fix the failing login test.\n\nPool:\n[item 0 (a)]\nTest fails: expected 200 got 401 at /login\n\n[item 1 (b)]\nDeployed staging at 12:04\n\n[item 2 (c)]\nLogin returns 401 when the token is expired, which is the failing case',
		{
			keep_0: { type: "noul", instructions: "Is item 0 still needed to fix the failing login test?" },
			imp_0: { type: "score", instructions: "How important is item 0?", criteria: ["irrelevant", "minor", "useful", "important", "critical"] },
		},
	],
	[
		"jev-file-relevance",
		'File: src/auth.ts\nCharacters 0-64 of 64\n\nexport function login(token: string) {\n  if (isExpired(token)) return 401;\n}',
		{ expiry: { type: "noul", instructions: "Does this file return 401 for an expired token?" } },
	],
	[
		"jev-bash-gate",
		"Working directory: /repo\nCommand: rm -rf node_modules && npm ci",
		{ safe: { type: "noul", instructions: "Is this command safe to run right now, with no destructive, irreversible or unexpected side effects?" } },
	],
	[
		"jev-model-router",
		"Task: rename a variable across 40 files\n\nCandidate models:\n[0] anthropic/claude-haiku-4-5\n[1] anthropic/claude-opus-5-5",
		{ model: { type: "choice", instructions: "Which candidate model should handle this task?", criteria: { "anthropic/claude-haiku-4-5": "cheap fast model", "anthropic/claude-opus-5-5": "expensive strong model" } } },
	],
]) {
	const { endpoint, sources } = resolve(process.cwd(), extension, false);
	const started = Date.now();
	const result = await systemOne(endpoint, state, questions);
	const answers = Object.entries(result.answers)
		.map(([id, answer]) => `${id}=${formatAnswer(answer)}`)
		.join("  ");
	console.log(
		`live ${extension.padEnd(18)} ${endpoint.name} -> ${endpoint.url} [${sources.join(", ") || "no settings"}] ${Date.now() - started}ms  ${answers}`,
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

	const catalog = [
		{ provider: "anthropic", id: "claude-haiku-4-5", model: { provider: "anthropic", id: "claude-haiku-4-5", name: "haiku" } },
		{ provider: "anthropic", id: "claude-opus-5-5", model: { provider: "anthropic", id: "claude-opus-5-5", name: "opus" } },
	];
	const routeCtx = {
		cwd: root,
		isProjectTrusted: () => false,
		getScopedModels: () => catalog,
		modelRegistry: {
			find: (provider, id) => catalog.find((m) => m.provider === provider && m.id === id)?.model,
		},
	};
	const message = (text) => ({ role: "user", content: text });
	for (const [label, request] of [
		["user, simple task", { reason: "user", messages: [message("rename a variable across 40 files")], thinkingLevel: "medium" }],
		["user, hard task", { reason: "user", messages: [message("design a distributed lock protocol and prove it correct under partitions")], thinkingLevel: "medium" }],
		["continuation", { reason: "continuation", messages: [], previous: { model: catalog[0].model, thinkingLevel: "high" }, thinkingLevel: "medium" }],
		["direct", { reason: "direct", messages: [], thinkingLevel: "medium" }],
	]) {
		const started = Date.now();
		const routed = await definition.route(request, routeCtx);
		console.log(`route ${label.padEnd(18)} -> ${routed.model.provider}/${routed.model.id} @ ${routed.thinkingLevel} (${Date.now() - started}ms)`);
	}
}

if (process.argv.includes("--gate")) {
	// Drive the bash tool_call hook the way pi does when the model asks for a command.
	const handlers = new Map();
	stub.on = (event, handler) => handlers.set(event, handler);
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

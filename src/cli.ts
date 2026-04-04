#!/usr/bin/env node
/**
 * pi-team: multi-agent debate/collaboration harness built on pi RPC mode.
 *
 * Subcommands:
 *   run      Start a session in the foreground (orchestrator only)
 *   start    Create a tmux session with a 3-pane layout (orchestrator, inject, log)
 *   inject   Connect to a running session's injection socket and forward stdin
 *   stop     Kill a tmux session and clean up
 *   list     List sessions under the sessions dir
 *
 * Agent spec format (--agent): name:provider/model[:thinking]
 *   Examples:
 *     claude:anthropic/claude-sonnet-4-5
 *     codex:openai-codex/gpt-5.4:xhigh
 *     gem:google/gemini-3-pro-preview:high
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Orchestra } from "./orchestra.js";
import { Observer } from "./observer.js";
import { InjectServer, runInjectClient } from "./inject-server.js";
import { createLayout, killSession, sessionExists, tmuxInstalled } from "./tmux.js";
import { startHttpInject } from "./http-inject.js";
import { listPlans } from "./usage/plans.js";
import type { AgentSpec, OrchestraConfig } from "./types.js";

const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "team", "sessions");

interface ParsedArgs {
	command: string;
	flags: Map<string, string[]>;
	positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command = "help", ...rest] = argv;
	const flags = new Map<string, string[]>();
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				if (!flags.has(key)) flags.set(key, []);
				flags.get(key)!.push(next);
				i++;
			} else {
				if (!flags.has(key)) flags.set(key, []);
				flags.get(key)!.push("true");
			}
		} else {
			positional.push(a);
		}
	}
	return { command, flags, positional };
}

function parseAgentSpec(spec: string): AgentSpec {
	// name:provider/model[:thinking][@plan]
	// Examples:
	//   claude:anthropic/claude-sonnet-4-5
	//   codex:openai-codex/gpt-5.4:xhigh
	//   claude:anthropic/claude-sonnet-4-5@anthropic-max-20x
	//   codex:openai-codex/gpt-5.4:xhigh@openai-plus
	let planId: string | undefined;
	const atIdx = spec.lastIndexOf("@");
	if (atIdx !== -1) {
		planId = spec.slice(atIdx + 1);
		spec = spec.slice(0, atIdx);
	}

	const firstColon = spec.indexOf(":");
	if (firstColon === -1) throw new Error(`bad agent spec: "${spec}"`);
	const name = spec.slice(0, firstColon);
	const rest = spec.slice(firstColon + 1);

	// rest is provider/model[:thinking]
	const slash = rest.indexOf("/");
	if (slash === -1) throw new Error(`bad agent spec: "${spec}" (expected name:provider/model)`);
	const provider = rest.slice(0, slash);
	const afterSlash = rest.slice(slash + 1);
	const thinkingSplit = afterSlash.lastIndexOf(":");
	const thinkingCandidates = ["off", "minimal", "low", "medium", "high", "xhigh"];
	let model = afterSlash;
	let thinking: AgentSpec["thinking"] | undefined;
	if (thinkingSplit !== -1) {
		const candidate = afterSlash.slice(thinkingSplit + 1);
		if (thinkingCandidates.includes(candidate)) {
			model = afterSlash.slice(0, thinkingSplit);
			thinking = candidate as AgentSpec["thinking"];
		}
	}
	return { name, provider, model, thinking, planId };
}

/**
 * Parse --plan name=plan-id flag values into a map and fold them into agents
 * that haven't already specified a plan via the @ suffix.
 */
function applyPlanFlags(agents: AgentSpec[], planFlags: string[] | undefined): AgentSpec[] {
	if (!planFlags) return agents;
	const planMap = new Map<string, string>();
	for (const raw of planFlags) {
		const eq = raw.indexOf("=");
		if (eq === -1) throw new Error(`bad --plan value: "${raw}" (expected name=plan-id)`);
		planMap.set(raw.slice(0, eq), raw.slice(eq + 1));
	}
	return agents.map((a) => (a.planId ? a : { ...a, planId: planMap.get(a.name) ?? a.planId }));
}

function help(): void {
	process.stdout.write(
		`pi-team — multi-agent debate/collaboration harness

USAGE
  pi-team start    --name <name> --agent <spec> --agent <spec> [--topic <text> | --topic-file <path>]
                   [--plan <name=plan-id>] [--max-turns N]
  pi-team run      (same flags as start, but foreground, no tmux)
  pi-team inject   --name <name>
  pi-team stop     --name <name>
  pi-team list
  pi-team plans
  pi-team help

AGENT SPEC
  name:provider/model[:thinking][@plan-id]
    claude:anthropic/claude-sonnet-4-5
    codex:openai-codex/gpt-5.4:xhigh
    claude:anthropic/claude-sonnet-4-5@anthropic-max-20x
    codex:openai-codex/gpt-5.4:xhigh@openai-plus

PLAN-AWARE COST TRACKING
  Without --plan (or @plan suffix), pi-team shows dollar cost from pi’s
  per-token pricing — which is wrong if you’re on a subscription. Declare
  your plan per agent to get real 5-hour and weekly window usage instead:

    pi-team start --name x \\
      --agent claude:anthropic/claude-sonnet-4-5 \\
      --agent codex:openai-codex/gpt-5.4:xhigh \\
      --plan claude=anthropic-max-20x \\
      --plan codex=openai-plus \\
      --topic-file ./topic.md

  Run 'pi-team plans' to list available plan ids.

EXAMPLES
  # Start an emotion-concepts debate between Claude and Codex, observable via tmux
  pi-team start \\
    --name emotions \\
    --agent claude:anthropic/claude-sonnet-4-5@anthropic-max-20x \\
    --agent codex:openai-codex/gpt-5.4:xhigh@openai-plus \\
    --max-turns 10 \\
    --topic-file ./debate-prompt.md

  tmux attach -t piteam-emotions
  pi-team inject --name emotions
  pi-team stop --name emotions
`,
	);
}

function cmdPlans(): void {
	for (const id of listPlans()) {
		process.stdout.write(`${id}\n`);
	}
}

function resolveTopic(flags: Map<string, string[]>): string {
	const topicFile = flags.get("topic-file")?.[0];
	if (topicFile) return readFileSync(topicFile, "utf8");
	const topic = flags.get("topic")?.[0];
	if (topic) return topic;
	throw new Error("missing --topic or --topic-file");
}

function buildConfig(flags: Map<string, string[]>): OrchestraConfig {
	const name = flags.get("name")?.[0];
	if (!name) throw new Error("missing --name");
	const agentSpecs = flags.get("agent") ?? [];
	if (agentSpecs.length < 2) throw new Error("need at least two --agent specs");
	const parsed = agentSpecs.map(parseAgentSpec);
	const agents = applyPlanFlags(parsed, flags.get("plan"));
	const topic = resolveTopic(flags);
	const maxTurns = Number(flags.get("max-turns")?.[0] ?? "20");
	const turnDelayMs = Number(flags.get("turn-delay-ms")?.[0] ?? "0");
	const sessionsDir = flags.get("sessions-dir")?.[0] ?? DEFAULT_SESSIONS_DIR;
	const mode = (flags.get("mode")?.[0] ?? "round-robin") as OrchestraConfig["mode"];
	return { name, agents, topic, maxTurns, turnDelayMs, sessionsDir, mode };
}

async function cmdRun(flags: Map<string, string[]>): Promise<void> {
	const config = buildConfig(flags);
	await runFromConfig(config, flags);
}

async function cmdStart(flags: Map<string, string[]>): Promise<void> {
	if (!tmuxInstalled()) {
		throw new Error("tmux is required for 'start'; use 'run' for foreground");
	}
	const config = buildConfig(flags);
	if (sessionExists(`piteam-${config.name}`)) {
		throw new Error(
			`tmux session "piteam-${config.name}" already exists. Kill with: pi-team stop --name ${config.name}`,
		);
	}

	// Write config so the background `run` process can read it
	const sessionDir = join(config.sessionsDir, config.name);
	const { mkdirSync } = await import("node:fs");
	mkdirSync(sessionDir, { recursive: true });
	const configPath = join(sessionDir, "config.json");
	writeFileSync(configPath, JSON.stringify(config, null, 2));

	// Resolve the path to this script for the tmux pane commands
	const scriptPath = process.argv[1];
	const node = process.execPath;
	const httpPortFlag = flags.get("http-port")?.[0];
	const httpPortArgs = httpPortFlag ? ` --http-port ${httpPortFlag}` : "";
	const runCmd = `${node} ${scriptPath} run --config-file ${configPath}${httpPortArgs}`;
	const injectCmd = `${node} ${scriptPath} inject --name ${config.name}`;
	const logPath = join(sessionDir, "events.log");

	// Ensure log file exists so tail -f doesn't fail
	writeFileSync(logPath, `# pi-team session ${config.name} — started ${new Date().toISOString()}\n`);

	createLayout({
		sessionName: `piteam-${config.name}`,
		orchestratorCmd: runCmd,
		injectCmd: `sleep 1 && ${injectCmd}`,
		logPath,
	});

	process.stdout.write(
		`\n\x1b[1mpi-team session "${config.name}" started in tmux.\x1b[0m\n\n` +
			`  Watch:   tmux attach -t piteam-${config.name}\n` +
			`  Inject:  pi-team inject --name ${config.name}   (from any shell)\n` +
			`  Stop:    pi-team stop --name ${config.name}\n` +
			`  Log:     ${logPath}\n` +
			`  Dir:     ${sessionDir}\n\n`,
	);
}

async function cmdInject(flags: Map<string, string[]>): Promise<void> {
	const name = flags.get("name")?.[0];
	if (!name) throw new Error("missing --name");
	const sessionsDir = flags.get("sessions-dir")?.[0] ?? DEFAULT_SESSIONS_DIR;
	const socketPath = join(sessionsDir, name, "inject.sock");
	// Wait briefly for socket if run just started
	for (let i = 0; i < 20; i++) {
		if (existsSync(socketPath)) break;
		await new Promise((r) => setTimeout(r, 300));
	}
	if (!existsSync(socketPath)) {
		throw new Error(`no injection socket at ${socketPath} — is the session running?`);
	}
	process.stdout.write(
		`\x1b[2m[connected to ${name}. Type a message and press Enter. Ctrl+D to quit.]\x1b[0m\n`,
	);
	await runInjectClient(socketPath);
}

async function cmdStop(flags: Map<string, string[]>): Promise<void> {
	const name = flags.get("name")?.[0];
	if (!name) throw new Error("missing --name");
	killSession(`piteam-${name}`);
	process.stdout.write(`stopped piteam-${name}\n`);
}

function cmdList(flags: Map<string, string[]>): void {
	const sessionsDir = flags.get("sessions-dir")?.[0] ?? DEFAULT_SESSIONS_DIR;
	if (!existsSync(sessionsDir)) {
		process.stdout.write(`(no sessions at ${sessionsDir})\n`);
		return;
	}
	const entries = readdirSync(sessionsDir);
	if (entries.length === 0) {
		process.stdout.write(`(no sessions)\n`);
		return;
	}
	for (const name of entries) {
		const dir = join(sessionsDir, name);
		if (!statSync(dir).isDirectory()) continue;
		const active = sessionExists(`piteam-${name}`);
		process.stdout.write(`${active ? "● " : "  "}${name}   ${dir}\n`);
	}
}

async function cmdRunWithConfigFile(flags: Map<string, string[]>): Promise<void> {
	const cf = flags.get("config-file")?.[0];
	if (!cf) {
		return cmdRun(flags);
	}
	const config = JSON.parse(readFileSync(cf, "utf8")) as OrchestraConfig;
	// Use the loaded config directly — it already contains AgentSpec objects
	// with planId preserved. Don't round-trip through string-based flags.
	await runFromConfig(config, flags);
}

async function runFromConfig(
	config: OrchestraConfig,
	flags: Map<string, string[]>,
): Promise<void> {
	const orchestra = new Orchestra(config);
	const sessionDir = join(config.sessionsDir, config.name);
	const logPath = join(sessionDir, "events.log");
	const socketPath = join(sessionDir, "inject.sock");

	new Observer(orchestra, logPath);

	const injectServer = new InjectServer(orchestra, socketPath);
	injectServer.start();

	const httpPort = Number(flags.get("http-port")?.[0] ?? process.env.PITEAM_HTTP_PORT ?? "0");
	let httpHandle: { stop: () => void } | null = null;
	if (httpPort > 0) {
		httpHandle = startHttpInject({
			orchestra,
			port: httpPort,
			sessionDir,
			token: process.env.PITEAM_HTTP_TOKEN,
			onStop: async () => {
				await orchestra.stop();
			},
		});
		process.stdout.write(`\x1b[2m· http inject on :${httpPort}\x1b[0m\n`);
	}

	const runfile = join(sessionDir, "runfile.json");
	writeFileSync(
		runfile,
		JSON.stringify(
			{ pid: process.pid, socket: socketPath, httpPort, started: Date.now(), config },
			null,
			2,
		),
	);

	const shutdown = async () => {
		process.stdout.write("\n\x1b[2m· shutting down\x1b[0m\n");
		injectServer.stop();
		httpHandle?.stop();
		await orchestra.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await orchestra.start();
	} catch (err) {
		process.stderr.write(`\n\x1b[31mfatal:\x1b[0m ${(err as Error).message}\n`);
		injectServer.stop();
		httpHandle?.stop();
		await orchestra.stop();
		process.exit(1);
	}
	injectServer.stop();
	httpHandle?.stop();
	await orchestra.stop();
	process.exit(0);
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	try {
		switch (parsed.command) {
			case "run":
				await cmdRunWithConfigFile(parsed.flags);
				break;
			case "start":
				await cmdStart(parsed.flags);
				break;
			case "inject":
				await cmdInject(parsed.flags);
				break;
			case "stop":
				await cmdStop(parsed.flags);
				break;
			case "list":
				cmdList(parsed.flags);
				break;
			case "plans":
				cmdPlans();
				break;
			case "help":
			case "--help":
			case "-h":
				help();
				break;
			default:
				help();
				process.exit(1);
		}
	} catch (err) {
		process.stderr.write(`\x1b[31merror:\x1b[0m ${(err as Error).message}\n`);
		process.exit(1);
	}
}

main();

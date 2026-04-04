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
	// name:provider/model[:thinking]
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
	return { name, provider, model, thinking };
}

function help(): void {
	process.stdout.write(
		`pi-team — multi-agent debate/collaboration harness

USAGE
  pi-team start    --name <name> --agent <spec> --agent <spec> [--topic <text> | --topic-file <path>]
                   [--max-turns N] [--mode round-robin]
  pi-team run      (same flags as start, but foreground, no tmux)
  pi-team inject   --name <name>
  pi-team stop     --name <name>
  pi-team list
  pi-team help

AGENT SPEC
  name:provider/model[:thinking]
    claude:anthropic/claude-sonnet-4-5
    codex:openai-codex/gpt-5.4:xhigh
    gem:google/gemini-3-pro-preview:high

EXAMPLES
  # Start an emotion-concepts debate between Claude and Codex, observable via tmux
  pi-team start \\
    --name emotions \\
    --agent claude:anthropic/claude-sonnet-4-5 \\
    --agent codex:openai-codex/gpt-5.4:xhigh \\
    --max-turns 10 \\
    --topic-file ./debate-prompt.md

  # Attach to watch and inject:
  tmux attach -t emotions

  # Or inject from another terminal without attaching:
  pi-team inject --name emotions

  # Stop the session:
  pi-team stop --name emotions
`,
	);
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
	const agents = agentSpecs.map(parseAgentSpec);
	const topic = resolveTopic(flags);
	const maxTurns = Number(flags.get("max-turns")?.[0] ?? "20");
	const turnDelayMs = Number(flags.get("turn-delay-ms")?.[0] ?? "0");
	const sessionsDir = flags.get("sessions-dir")?.[0] ?? DEFAULT_SESSIONS_DIR;
	const mode = (flags.get("mode")?.[0] ?? "round-robin") as OrchestraConfig["mode"];
	return { name, agents, topic, maxTurns, turnDelayMs, sessionsDir, mode };
}

async function cmdRun(flags: Map<string, string[]>): Promise<void> {
	const config = buildConfig(flags);
	const orchestra = new Orchestra(config);
	const sessionDir = join(config.sessionsDir, config.name);
	const logPath = join(sessionDir, "events.log");
	const socketPath = join(sessionDir, "inject.sock");

	new Observer(orchestra, logPath);

	const injectServer = new InjectServer(orchestra, socketPath);
	injectServer.start();

	// Optional HTTP inject endpoint for remote/containerized integrations
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

	// Write a runfile so `inject` / `stop` can find this session
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
		process.exit(1);
	}
	injectServer.stop();
	httpHandle?.stop();
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
	const fakeFlags = new Map<string, string[]>();
	fakeFlags.set("name", [config.name]);
	for (const a of config.agents) {
		const spec = `${a.name}:${a.provider}/${a.model}${a.thinking ? `:${a.thinking}` : ""}`;
		const cur = fakeFlags.get("agent") ?? [];
		cur.push(spec);
		fakeFlags.set("agent", cur);
	}
	fakeFlags.set("topic", [config.topic]);
	fakeFlags.set("max-turns", [String(config.maxTurns)]);
	fakeFlags.set("sessions-dir", [config.sessionsDir]);
	// Preserve --http-port if passed on the command line
	const httpPort = flags.get("http-port")?.[0];
	if (httpPort) fakeFlags.set("http-port", [httpPort]);
	await cmdRun(fakeFlags);
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

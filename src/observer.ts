/**
 * Observer: consumes Orchestra events and renders them live to stdout.
 *
 * Colors per agent + dim timestamps + indent wrap. Designed to look decent
 * inside a tmux pane. Also writes plain-text events to a log file for
 * offline review (tmux scrollback is nice, files are persistent).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Orchestra } from "./orchestra.js";
import { formatSnapshot } from "./usage/reporter.js";
import type { UsageSnapshot } from "./usage/types.js";
import type { TeamEvent } from "./types.js";

const AGENT_COLORS = [
	"\x1b[38;5;39m", // cyan-blue
	"\x1b[38;5;208m", // orange
	"\x1b[38;5;141m", // purple
	"\x1b[38;5;42m", // green
	"\x1b[38;5;220m", // yellow
	"\x1b[38;5;198m", // pink
];
const HUMAN_COLOR = "\x1b[38;5;15m\x1b[1m"; // bold white
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function timestamp(): string {
	return new Date().toISOString().slice(11, 19);
}

export class Observer {
	private colorByAgent = new Map<string, string>();
	private streamingAgent: string | null = null;

	constructor(
		orchestra: Orchestra,
		private readonly logPath?: string,
	) {
		if (this.logPath) {
			mkdirSync(dirname(this.logPath), { recursive: true });
		}
		// Assign colors stably per agent based on config order
		for (let i = 0; i < orchestra.config.agents.length; i++) {
			const name = orchestra.config.agents[i].name;
			this.colorByAgent.set(name, AGENT_COLORS[i % AGENT_COLORS.length]);
		}

		orchestra.on("event", (e: TeamEvent) => this.onEvent(e));
		orchestra.on("delta", (agentName: string, text: string) => this.onDelta(agentName, text));
		orchestra.on("tool", (agentName: string, toolName: string, phase: "start" | "end") =>
			this.onTool(agentName, toolName, phase),
		);
		orchestra.on("usage", (snap: UsageSnapshot) => this.onUsage(snap));
	}

	private onUsage(snap: UsageSnapshot): void {
		const line = formatSnapshot(snap, { color: true });
		process.stdout.write(`${DIM}  ⤷ ${RESET}${line}\n`);
		this.writeLog(`usage: ${formatSnapshot(snap, { color: false })}`);
	}

	private colorFor(from: string): string {
		if (from === "human") return HUMAN_COLOR;
		return this.colorByAgent.get(from) ?? "";
	}

	private writeLog(line: string): void {
		if (!this.logPath) return;
		// Strip ANSI for log
		const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
		try {
			appendFileSync(this.logPath, `${plain}\n`);
		} catch {
			/* ignore */
		}
	}

	private onEvent(e: TeamEvent): void {
		switch (e.type) {
			case "message": {
				const m = e.message!;
				const color = this.colorFor(m.from);
				const header = `${DIM}[${timestamp()}]${RESET} ${color}${BOLD}${m.from}${RESET}${color} ›${RESET}`;
				// For agent messages where we just streamed deltas, content is already
				// printed via onDelta. Only print full body for injections and seed topic.
				if (m.from === "human" || m.role === "user") {
					process.stdout.write(`\n${header} ${color}${m.content}${RESET}\n\n`);
					this.writeLog(`[${timestamp()}] ${m.from}: ${m.content}`);
				} else {
					// finalize the streaming line
					if (this.streamingAgent === m.from) {
						process.stdout.write(`${RESET}\n`);
						this.streamingAgent = null;
					}
					// Full message log entry
					this.writeLog(`[${timestamp()}] ${m.from}: ${m.content}`);
				}
				return;
			}
			case "turn_start": {
				const color = this.colorFor(e.agent!);
				process.stdout.write(
					`\n${DIM}[${timestamp()}]${RESET} ${color}${BOLD}${e.agent}${RESET}${color} ›${RESET} `,
				);
				this.streamingAgent = e.agent!;
				return;
			}
			case "turn_end": {
				if (this.streamingAgent === e.agent) {
					process.stdout.write(`${RESET}\n`);
					this.streamingAgent = null;
				}
				return;
			}
			case "agent_error": {
				process.stdout.write(`\n\x1b[31m[error]\x1b[0m ${e.agent}: ${e.error}\n`);
				this.writeLog(`[error] ${e.agent}: ${e.error}`);
				return;
			}
			case "human_inject": {
				const m = e.message!;
				process.stdout.write(
					`\n${HUMAN_COLOR}↘ human (injected)${RESET} ${m.content}${RESET}\n\n`,
				);
				this.writeLog(`[${timestamp()}] [INJECT] human: ${m.content}`);
				return;
			}
			case "info": {
				process.stdout.write(`${DIM}· ${e.info}${RESET}\n`);
				this.writeLog(`[${timestamp()}] · ${e.info}`);
				return;
			}
			case "stop": {
				process.stdout.write(`\n${DIM}· session stopped${RESET}\n`);
				return;
			}
		}
	}

	private onDelta(agentName: string, text: string): void {
		if (this.streamingAgent !== agentName) {
			// Different agent started streaming (shouldn't happen in round-robin but safe)
			if (this.streamingAgent) {
				process.stdout.write(`${RESET}\n`);
			}
			const color = this.colorFor(agentName);
			process.stdout.write(
				`\n${DIM}[${timestamp()}]${RESET} ${color}${BOLD}${agentName}${RESET}${color} ›${RESET} `,
			);
			this.streamingAgent = agentName;
		}
		const color = this.colorFor(agentName);
		// Indent continuation lines so attribution stays visible
		const indented = text.replace(/\n/g, `\n${color}│${RESET} `);
		process.stdout.write(`${color}${indented}${RESET}`);
	}

	private onTool(agentName: string, toolName: string, phase: "start" | "end"): void {
		if (phase === "start") {
			const color = this.colorFor(agentName);
			process.stdout.write(`\n${color}  ⚙ ${toolName}${RESET}`);
			this.writeLog(`[${timestamp()}] ${agentName} tool_start: ${toolName}`);
		} else {
			this.writeLog(`[${timestamp()}] ${agentName} tool_end: ${toolName}`);
		}
	}
}

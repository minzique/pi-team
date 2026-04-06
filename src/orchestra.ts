/**
 * Orchestra: the central coordinator for a multi-agent team session.
 *
 * Responsibilities:
 * - Spawn one Agent per AgentSpec
 * - Route messages between them via the shared Transcript
 * - Accept human injections at turn boundaries
 * - Stream events to observers (stdout, log, etc.)
 * - Handle graceful shutdown
 */

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { Transcript } from "./transcript.js";
import { UsageTracker } from "./usage/tracker.js";
import type { UsageSnapshot } from "./usage/types.js";
import type { AgentSpec, OrchestraConfig, TeamEvent, TeamMessage } from "./types.js";

export interface OrchestraEvents {
	event: (e: TeamEvent) => void;
	delta: (agentName: string, text: string) => void;
	tool: (agentName: string, toolName: string, phase: "start" | "end") => void;
}

export class Orchestra extends EventEmitter {
	readonly config: OrchestraConfig;
	readonly transcript: Transcript;
	readonly agents: Agent[] = [];
	readonly usage: UsageTracker;
	private agentLastSeen = new Map<string, number>();
	private agentSessionPaths = new Map<string, string>();
	private agentBriefings = new Map<string, string>();
	private pendingInjections: string[] = [];
	private running = false;
	private turn = 0;
	private readonly sessionDir: string;

	constructor(config: OrchestraConfig) {
		super();
		this.config = config;
		this.sessionDir = join(config.sessionsDir, config.name);
		mkdirSync(this.sessionDir, { recursive: true });
		this.transcript = new Transcript(join(this.sessionDir, "transcript.jsonl"));
		this.usage = new UsageTracker();
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.emitEvent({ type: "info", timestamp: Date.now(), info: `starting session "${this.config.name}"` });

		// Spawn agents in parallel
		for (const spec of this.config.agents) {
			const agent = this.createAgent(spec);
			this.agents.push(agent);
			this.agentLastSeen.set(spec.name, 0);
		}

		await Promise.all(this.agents.map((a) => a.start()));
		this.emitEvent({
			type: "info",
			timestamp: Date.now(),
			info: `agents ready: ${this.agents.map((a) => a.name).join(", ")}`,
		});

		// Seed the transcript with the topic
		const seeded = this.transcript.append({
			from: "human",
			role: "user",
			content: this.config.topic,
		});
		this.emitEvent({ type: "message", timestamp: seeded.timestamp, message: seeded });

		// Briefing phase: agents explore with tools, then debate without
		if (this.config.briefingPhase) {
			await this.runBriefing();
		}

		// Main loop
		try {
			await this.runLoop();
		} finally {
			this.running = false;
			this.emitEvent({ type: "stop", timestamp: Date.now() });
		}
	}

	private createAgent(spec: AgentSpec): Agent {
		const sessionPath = join(this.sessionDir, `agent-${spec.name}.session.jsonl`);
		this.agentSessionPaths.set(spec.name, sessionPath);
		this.usage.register({
			name: spec.name,
			provider: spec.provider,
			model: spec.model,
			sessionPath,
			planId: spec.planId ?? "api",
		});
		const agent = new Agent({ spec, sessionPath });
		agent.on("delta", (name: string, text: string) => {
			this.emit("delta", name, text);
		});
		agent.on("tool_start", (name: string, tool: string) => {
			this.emit("tool", name, tool, "start");
		});
		agent.on("tool_end", (name: string, tool: string) => {
			this.emit("tool", name, tool, "end");
		});
		agent.on("exit", (name: string, code: number | null) => {
			this.emitEvent({
				type: "agent_error",
				timestamp: Date.now(),
				agent: name,
				error: `pi process exited with code ${code}`,
			});
			this.running = false;
		});
		return agent;
	}

	/**
	 * Briefing phase: each agent gets one research turn with full tool access.
	 * We spawn temporary pi instances with tools enabled (regardless of the
	 * agent's debate-time tool setting), capture their research output, then
	 * tear them down. The research is injected as private context when the
	 * agent takes its first debate turn.
	 */
	private async runBriefing(): Promise<void> {
		const timeoutMs = this.config.briefingTimeoutMs ?? 5 * 60 * 1000;
		const defaultPrompt =
			"You are about to participate in a multi-agent debate. Before it begins, " +
			"use your tools to research the topic below. Read relevant source files, " +
			"understand the architecture, and gather evidence for your position. " +
			"Write a concise research summary (key findings, relevant code paths, " +
			"your initial position) that you'll reference during the debate.\n\n" +
			"TOPIC:\n" +
			this.config.topic;
		const briefingPrompt = this.config.briefingPrompt ?? defaultPrompt;

		this.emitEvent({
			type: "info",
			timestamp: Date.now(),
			info: `briefing phase: ${this.agents.length} agents researching with tools (timeout ${Math.round(timeoutMs / 1000)}s each)`,
		});

		for (const spec of this.config.agents) {
			const briefingSessionPath = join(this.sessionDir, `briefing-${spec.name}.session.jsonl`);
			const briefingAgent = new Agent({
				spec,
				sessionPath: briefingSessionPath,
				// Override tools: full access during briefing regardless of debate config
				toolsOverride: undefined,
			});

			// Wire up events so the observer can log briefing activity
			briefingAgent.on("delta", (name: string, text: string) => {
				this.emit("delta", name, text);
			});
			briefingAgent.on("tool_start", (name: string, tool: string) => {
				this.emit("tool", name, tool, "start");
			});
			briefingAgent.on("tool_end", (name: string, tool: string) => {
				this.emit("tool", name, tool, "end");
			});

			this.emitEvent({
				type: "info",
				timestamp: Date.now(),
				info: `briefing: ${spec.name} starting research`,
			});

			try {
				await briefingAgent.start();
				const research = await briefingAgent.prompt(
					spec.briefing ?? briefingPrompt,
					timeoutMs,
				);
				this.agentBriefings.set(spec.name, research);
				this.emitEvent({
					type: "info",
					timestamp: Date.now(),
					info: `briefing: ${spec.name} done (${research.length} chars)`,
				});
			} catch (err) {
				this.emitEvent({
					type: "agent_error",
					timestamp: Date.now(),
					agent: spec.name,
					error: `briefing failed: ${(err as Error).message}`,
				});
				// Non-fatal: agent proceeds to debate without research
			} finally {
				briefingAgent.stop();
			}
		}

		this.emitEvent({
			type: "info",
			timestamp: Date.now(),
			info: `briefing phase complete. ${this.agentBriefings.size}/${this.config.agents.length} agents produced research.`,
		});
	}

	private async runLoop(): Promise<void> {
		while (this.running) {
			if (this.config.maxTurns > 0 && this.turn >= this.config.maxTurns) {
				this.emitEvent({
					type: "info",
					timestamp: Date.now(),
					info: `reached max turns (${this.config.maxTurns})`,
				});
				break;
			}

			// Drain any pending human injections into the transcript BEFORE this turn,
			// so the active agent sees them.
			this.drainInjections();

			const agentIdx = this.turn % this.agents.length;
			const agent = this.agents[agentIdx];

			const lastSeen = this.agentLastSeen.get(agent.name) ?? 0;
			let promptText = this.transcript.renderForAgent(agent.name, lastSeen);
			if (!promptText.trim()) {
				// Nothing new for this agent — skip its turn to avoid prompting with empty input
				this.turn++;
				continue;
			}

			// Inject briefing research on the agent's first debate turn
			const briefing = this.agentBriefings.get(agent.name);
			if (briefing) {
				promptText =
					"[YOUR RESEARCH NOTES FROM THE BRIEFING PHASE]\n" +
					briefing +
					"\n\n[END RESEARCH NOTES — now debate based on your research and the messages below]\n\n" +
					promptText;
				// Only inject once
				this.agentBriefings.delete(agent.name);
			}

			this.emitEvent({ type: "turn_start", timestamp: Date.now(), agent: agent.name });

			let replyText: string;
			try {
				replyText = await agent.prompt(promptText);
			} catch (err) {
				this.emitEvent({
					type: "agent_error",
					timestamp: Date.now(),
					agent: agent.name,
					error: (err as Error).message,
				});
				break;
			}

			this.agentLastSeen.set(agent.name, this.transcript.lastSeq());
			const msg = this.transcript.append({
				from: agent.name,
				role: "assistant",
				content: replyText,
			});
			this.emitEvent({ type: "message", timestamp: msg.timestamp, message: msg });

			// Refresh usage snapshot for this agent and emit it
			const sessionPath = this.agentSessionPaths.get(agent.name);
			if (sessionPath) {
				this.usage.syncAgent(agent.name, sessionPath);
				const snap = this.usage.snapshot(agent.name);
				if (snap) this.emit("usage", snap);
			}

			this.emitEvent({ type: "turn_end", timestamp: Date.now(), agent: agent.name });

			this.turn++;

			if (this.config.turnDelayMs > 0) {
				await new Promise((r) => setTimeout(r, this.config.turnDelayMs));
			}
		}
	}

	private drainInjections(): void {
		while (this.pendingInjections.length > 0) {
			const content = this.pendingInjections.shift()!;
			const msg = this.transcript.append({ from: "human", role: "user", content });
			this.emitEvent({ type: "human_inject", timestamp: msg.timestamp, message: msg });
		}
	}

	/**
	 * Queue a human message. Will be delivered to the next agent at the next
	 * turn boundary. Every subsequent agent will see it because renderForAgent
	 * includes all messages since their last turn.
	 */
	inject(content: string): void {
		this.pendingInjections.push(content);
		// Don't emit an info event here — it would interleave with a streaming agent's
		// output. The injection will appear as a human_inject event at the next turn boundary.
	}

	async stop(): Promise<void> {
		this.running = false;
		await Promise.all(this.agents.map((a) => a.abort()));
		for (const a of this.agents) a.stop();
	}

	private emitEvent(event: TeamEvent): void {
		this.emit("event", event);
	}

	lastMessages(n: number): TeamMessage[] {
		const all = this.transcript.all();
		return all.slice(Math.max(0, all.length - n));
	}

	usageSnapshots(): UsageSnapshot[] {
		return this.usage.snapshotAll();
	}
}

/**
 * Agent: a thin wrapper around a `pi --mode rpc` subprocess.
 *
 * Each agent runs its own pi instance with its own model and session file.
 * The orchestrator calls `prompt(text)` and awaits the assistant's full reply.
 *
 * Wire format: JSONL. Every line to stdin is a command, every line from stdout
 * is either a response (to a command) or an event (streamed during execution).
 * We wait for `agent_end` to know a prompt turn is fully complete, then fetch
 * the last assistant text via `get_last_assistant_text`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSpec } from "./types.js";

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
}

export interface AgentOptions {
	spec: AgentSpec;
	/** Path for this agent's pi session jsonl. Created if missing. */
	sessionPath: string;
	/** Optional append-system-prompt file path */
	systemPromptFile?: string;
	/** Environment overrides for the pi subprocess */
	env?: Record<string, string>;
	/**
	 * Override the spec's tool setting for this instance. Used by the
	 * briefing phase to spawn a tools-enabled agent from a no-tools spec.
	 */
	toolsOverride?: string[] | false | undefined;
}

/**
 * Events emitted:
 *   - "delta" (agentName, text): streaming token from the assistant
 *   - "tool_start" (agentName, toolName, args)
 *   - "tool_end" (agentName, toolName, isError)
 *   - "error" (agentName, message)
 *   - "exit" (agentName, code)
 */
export class Agent extends EventEmitter {
	readonly name: string;
	readonly spec: AgentSpec;
	private proc!: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextReqId = 1;
	private pending = new Map<string, PendingRequest>();
	private streaming = false;
	private currentTurnText = "";
	private turnResolver: ((text: string) => void) | null = null;
	private turnRejector: ((err: Error) => void) | null = null;

	constructor(private opts: AgentOptions) {
		super();
		this.name = opts.spec.name;
		this.spec = opts.spec;
	}

	async start(): Promise<void> {
		mkdirSync(dirname(this.opts.sessionPath), { recursive: true });
		const args = [
			"--mode",
			"rpc",
			"--provider",
			this.spec.provider,
			"--model",
			this.spec.model,
			"--session",
			this.opts.sessionPath,
		];
		if (this.spec.thinking) {
			args.push("--thinking", this.spec.thinking);
		}
		const tools = this.opts.toolsOverride !== undefined ? this.opts.toolsOverride : this.spec.tools;
		if (tools === false) {
			args.push("--no-tools");
		} else if (Array.isArray(tools) && tools.length > 0) {
			args.push("--tools", tools.join(","));
		}
		if (this.opts.systemPromptFile) {
			args.push("--append-system-prompt", this.opts.systemPromptFile);
		}

		this.proc = spawn("pi", args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...(this.opts.env ?? {}) },
		});

		this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			// pi can be chatty to stderr during startup; only emit as error if prefixed
			if (/error|Error|ERROR/.test(text)) {
				this.emit("stderr", this.name, text);
			}
		});
		this.proc.on("exit", (code) => {
			this.emit("exit", this.name, code);
			for (const pending of this.pending.values()) {
				pending.reject(new Error(`pi process for "${this.name}" exited with code ${code}`));
			}
			this.pending.clear();
			if (this.turnRejector) {
				this.turnRejector(new Error(`agent "${this.name}" exited mid-turn`));
			}
		});

		// Wait for the process to be ready. We send a cheap get_state ping.
		await this.waitForReady();
	}

	private async waitForReady(): Promise<void> {
		// pi RPC mode is ready as soon as it reads stdin. Send get_state and wait
		// up to 30s for a response. If it fails, start() rejects.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				await this.sendCommand("get_state", {}, 5_000);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		throw new Error(`agent "${this.name}" did not become ready within 30s`);
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		while (true) {
			const nl = this.buffer.indexOf("\n");
			if (nl === -1) break;
			let line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as Record<string, unknown>;
				this.handleRpcMessage(msg);
			} catch (e) {
				// Not JSON — pi sometimes prints warnings to stdout. Ignore.
			}
		}
	}

	private handleRpcMessage(msg: Record<string, unknown>): void {
		const type = msg.type as string;

		// Response to a command
		if (type === "response") {
			const id = msg.id as string | undefined;
			if (id && this.pending.has(id)) {
				const p = this.pending.get(id)!;
				this.pending.delete(id);
				if (msg.success) {
					p.resolve(msg.data);
				} else {
					p.reject(new Error((msg.error as string) ?? "rpc error"));
				}
			}
			return;
		}

		// Streaming events — we care about text deltas and turn boundaries
		if (type === "agent_start") {
			this.streaming = true;
			this.currentTurnText = "";
			return;
		}

		if (type === "message_update") {
			const evt = msg.assistantMessageEvent as { type: string; delta?: string } | undefined;
			if (evt?.type === "text_delta" && evt.delta) {
				this.currentTurnText += evt.delta;
				this.emit("delta", this.name, evt.delta);
			}
			return;
		}

		if (type === "tool_execution_start") {
			this.emit("tool_start", this.name, msg.toolName, msg.args);
			return;
		}

		if (type === "tool_execution_end") {
			this.emit("tool_end", this.name, msg.toolName, msg.isError);
			return;
		}

		if (type === "agent_end") {
			this.streaming = false;
			const text = this.currentTurnText;
			this.currentTurnText = "";
			if (this.turnResolver) {
				this.turnResolver(text);
				this.turnResolver = null;
				this.turnRejector = null;
			}
			return;
		}
	}

	private sendCommand<T = unknown>(
		type: string,
		payload: Record<string, unknown>,
		timeoutMs = 120_000,
	): Promise<T> {
		const id = `req-${this.nextReqId++}`;
		const cmd = { id, type, ...payload };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`rpc timeout on ${type}`));
				}
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (data) => {
					clearTimeout(timer);
					resolve(data as T);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
		});
	}

	/**
	 * Send a user message and await the full assistant response text.
	 * Returns the concatenated assistant text for this turn (excluding tools).
	 */
	async prompt(message: string, timeoutMs = 20 * 60 * 1000): Promise<string> {
		if (this.streaming) {
			throw new Error(`agent "${this.name}" is already streaming`);
		}
		const textPromise = new Promise<string>((resolve, reject) => {
			this.turnResolver = resolve;
			this.turnRejector = reject;
		});

		const timer = setTimeout(() => {
			if (this.turnRejector) {
				const rej = this.turnRejector;
				this.turnResolver = null;
				this.turnRejector = null;
				rej(new Error(`turn timeout for "${this.name}"`));
			}
		}, timeoutMs);

		try {
			await this.sendCommand("prompt", { message });
			const text = await textPromise;
			return text;
		} finally {
			clearTimeout(timer);
		}
	}

	async abort(): Promise<void> {
		try {
			await this.sendCommand("abort", {}, 5_000);
		} catch {
			/* ignore */
		}
	}

	async getSessionStats(): Promise<unknown> {
		return this.sendCommand("get_session_stats", {});
	}

	stop(): void {
		try {
			this.proc.stdin.end();
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				this.proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}, 2000);
	}
}

/**
 * Shared transcript for a team session.
 *
 * Stores every message (human injection, agent reply, system event) in
 * memory and appends to a JSONL file on disk for crash recovery.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TeamMessage } from "./types.js";

export class Transcript {
	private messages: TeamMessage[] = [];
	private nextSeq = 1;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf8");
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line) as TeamMessage;
					this.messages.push(msg);
					if (msg.seq >= this.nextSeq) this.nextSeq = msg.seq + 1;
				} catch {
					/* skip malformed */
				}
			}
		}
	}

	append(msg: Omit<TeamMessage, "seq" | "timestamp">): TeamMessage {
		const full: TeamMessage = {
			seq: this.nextSeq++,
			timestamp: Date.now(),
			...msg,
		};
		this.messages.push(full);
		appendFileSync(this.path, `${JSON.stringify(full)}\n`);
		return full;
	}

	all(): readonly TeamMessage[] {
		return this.messages;
	}

	/** Messages since (exclusive) the given seq. If seq is 0, returns all. */
	since(seq: number): TeamMessage[] {
		return this.messages.filter((m) => m.seq > seq);
	}

	lastSeq(): number {
		return this.messages.length > 0 ? this.messages[this.messages.length - 1].seq : 0;
	}

	/**
	 * Render messages for a specific agent's perspective: its own messages are
	 * already in its pi session, so we only send messages from others since its
	 * last turn, formatted with attribution.
	 */
	renderForAgent(agentName: string, sinceSeq: number): string {
		const others = this.since(sinceSeq).filter((m) => m.from !== agentName);
		if (others.length === 0) return "";
		return others
			.map((m) => {
				if (m.from === "human") return `[human]: ${m.content}`;
				return `[${m.from}]: ${m.content}`;
			})
			.join("\n\n---\n\n");
	}
}

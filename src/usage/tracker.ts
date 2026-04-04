/**
 * UsageTracker: reads per-agent pi session JSONL files, extracts turn usage,
 * and computes rolling-window aggregates against each agent's declared plan.
 *
 * Strategy:
 *   - Each agent's pi writes to agent-<name>.session.jsonl
 *   - Every "message" entry with role="assistant" has a `usage` object
 *     containing token counts, cost, provider, model, and timestamp
 *   - After each turn, the orchestrator calls tracker.syncAgent(name) which
 *     re-reads the agent's session file, extracts new turns, and recomputes
 *     the snapshot
 *
 * We deliberately do NOT tail the file in real-time (fs.watch). Pi's RPC
 * mode already tells us exactly when turns end via agent_end, which is the
 * only time we need a fresh snapshot. Polling at turn boundaries is simpler
 * and avoids racing with pi's writer.
 */

import { readFileSync, existsSync } from "node:fs";
import { getPlan } from "./plans.js";
import type { PlanLimits, PlanWindow, TurnUsage, UsageSnapshot, WindowSnapshot } from "./types.js";

export interface TrackerAgent {
	name: string;
	provider: string;
	model: string;
	sessionPath: string;
	planId: string;
}

export class UsageTracker {
	private turnsByAgent = new Map<string, TurnUsage[]>();
	private plansByAgent = new Map<string, PlanLimits>();

	register(agent: TrackerAgent): void {
		this.turnsByAgent.set(agent.name, []);
		this.plansByAgent.set(agent.name, getPlan(agent.planId));
	}

	/**
	 * Re-parse the agent's session jsonl and refresh its turn list.
	 * Idempotent; safe to call after every turn.
	 */
	syncAgent(agentName: string, sessionPath: string): void {
		if (!existsSync(sessionPath)) return;
		const turns: TurnUsage[] = [];
		const raw = readFileSync(sessionPath, "utf8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type !== "message") continue;
			const m = entry.message as Record<string, unknown> | undefined;
			if (!m || m.role !== "assistant") continue;
			const usage = m.usage as Record<string, unknown> | undefined;
			if (!usage) continue;
			const timestamp = parseTimestamp(entry.timestamp) ?? Date.now();
			turns.push({
				agentName,
				timestamp,
				provider: String(m.provider ?? ""),
				model: String(m.model ?? ""),
				tokens: {
					input: Number(usage.input ?? 0),
					output: Number(usage.output ?? 0),
					cacheRead: Number(usage.cacheRead ?? 0),
					cacheWrite: Number(usage.cacheWrite ?? 0),
					total: Number(usage.totalTokens ?? 0),
				},
				dollarCost: Number((usage.cost as Record<string, unknown> | undefined)?.total ?? 0),
			});
		}
		this.turnsByAgent.set(agentName, turns);
	}

	snapshot(agentName: string): UsageSnapshot | null {
		const turns = this.turnsByAgent.get(agentName);
		const plan = this.plansByAgent.get(agentName);
		if (!turns || !plan) return null;

		const sessionTokens = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		};
		let sessionDollarCost = 0;
		let latestProvider = plan.provider;
		let latestModel = "";
		for (const t of turns) {
			sessionTokens.input += t.tokens.input;
			sessionTokens.output += t.tokens.output;
			sessionTokens.cacheRead += t.tokens.cacheRead;
			sessionTokens.cacheWrite += t.tokens.cacheWrite;
			sessionTokens.total += t.tokens.total;
			sessionDollarCost += t.dollarCost;
			latestProvider = t.provider || latestProvider;
			latestModel = t.model || latestModel;
		}

		const now = Date.now();
		const shortSnap = plan.short ? computeWindow(turns, plan.short, now) : undefined;
		const longSnap = plan.long ? computeWindow(turns, plan.long, now) : undefined;

		const messagesShort = plan.short
			? turns.filter((t) => t.timestamp >= now - plan.short!.durationMs).length
			: turns.length;
		const messagesLong = plan.long
			? turns.filter((t) => t.timestamp >= now - plan.long!.durationMs).length
			: turns.length;

		return {
			agentName,
			provider: latestProvider,
			model: latestModel,
			planId: plan.id,
			planMode: plan.mode,
			sessionTokens,
			sessionDollarCost,
			windows: { short: shortSnap, long: longSnap },
			messagesShort,
			messagesLong,
		};
	}

	snapshotAll(): UsageSnapshot[] {
		return Array.from(this.turnsByAgent.keys())
			.map((name) => this.snapshot(name))
			.filter((s): s is UsageSnapshot => s !== null);
	}
}

function computeWindow(
	turns: TurnUsage[],
	window: PlanWindow,
	now: number,
): WindowSnapshot {
	const windowStart = now - window.durationMs;
	const inWindow = turns.filter((t) => t.timestamp >= windowStart);

	// Cap is model-specific. Use the most-used model in the window to pick the cap.
	const modelCounts = new Map<string, number>();
	for (const t of inWindow) {
		modelCounts.set(t.model, (modelCounts.get(t.model) ?? 0) + 1);
	}
	const dominantModel = maxBy(Array.from(modelCounts.entries()), ([, c]) => c)?.[0] ?? "";
	const modelCap = window.capByModel[dominantModel];

	let used: number;
	if (window.unit === "messages") {
		used = inWindow.length;
	} else if (window.unit === "tokens") {
		used = inWindow.reduce((sum, t) => sum + t.tokens.total, 0);
	} else {
		// hours — approximate by assuming each assistant turn represents some
		// fraction of an hour. Without true session-duration data, we use
		// total output tokens as a proxy, calibrated at 2000 output tokens
		// ≈ 1 minute of "active use" (rough but honest).
		const outputTokens = inWindow.reduce((sum, t) => sum + t.tokens.output, 0);
		used = outputTokens / 2000 / 60; // hours
	}

	// Earliest turn in window tells us when the oldest will roll out
	const oldest = inWindow.length > 0 ? inWindow[0].timestamp : now;
	const nextResetAt = oldest + window.durationMs;

	return {
		durationMs: window.durationMs,
		used,
		cap: modelCap?.min ?? 0,
		capMax: modelCap?.max,
		unit: window.unit,
		windowStart,
		nextResetAt,
	};
}

function parseTimestamp(raw: unknown): number | null {
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const t = Date.parse(raw);
		return Number.isNaN(t) ? null : t;
	}
	return null;
}

function maxBy<T>(items: T[], key: (item: T) => number): T | undefined {
	let best: T | undefined;
	let bestKey = -Infinity;
	for (const item of items) {
		const k = key(item);
		if (k > bestKey) {
			bestKey = k;
			best = item;
		}
	}
	return best;
}

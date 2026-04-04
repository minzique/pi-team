/**
 * Usage tracking types.
 *
 * Two things we care about:
 *
 * 1. TurnUsage — what a single agent turn cost, sourced from pi's session
 *    JSONL (input/output/cache tokens + dollar cost + timestamp + model).
 *
 * 2. WindowUsage — aggregation of turns into rolling time windows, compared
 *    against the agent's declared subscription plan. This is the thing users
 *    actually care about on subscriptions: "how much of my 5-hour budget am
 *    I burning through right now?"
 *
 * Dollar cost is always computed (from pi's pricing) but is MEANINGLESS for
 * subscription users. The plan-aware view is the primary display.
 */

export interface TurnUsage {
	agentName: string;
	timestamp: number;
	provider: string;
	model: string;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	dollarCost: number;
}

export interface WindowSnapshot {
	/** Window length in ms */
	durationMs: number;
	/** Used count in the window's native unit */
	used: number;
	/** Hard cap (minimum of plan's min–max range — conservative) */
	cap: number;
	/** Optional upper cap (max of plan's range — optimistic) */
	capMax?: number;
	/** Unit the window measures */
	unit: "messages" | "tokens" | "hours";
	/** Window edge (oldest event still counted) in ms timestamp */
	windowStart: number;
	/** When the oldest event will roll out (earliest cap-freeing event) */
	nextResetAt: number;
}

export interface UsageSnapshot {
	agentName: string;
	provider: string;
	model: string;
	planId: string;
	planMode: "api" | "subscription";
	/** Session totals from pi */
	sessionTokens: TurnUsage["tokens"];
	sessionDollarCost: number;
	/** Rolling windows, only present for subscription plans */
	windows: {
		short?: WindowSnapshot;
		long?: WindowSnapshot;
	};
	/** Message count in the last 5h window (always available, cheap to compute) */
	messagesShort: number;
	messagesLong: number;
}

export interface PlanWindow {
	durationMs: number;
	unit: "messages" | "tokens" | "hours";
	/**
	 * Per-model caps. Ranges are min–max because OpenAI/Anthropic publish
	 * ranges that vary by task complexity. We use min for "conservative" and
	 * max for "optimistic" views.
	 */
	capByModel: Record<string, { min: number; max: number }>;
}

export interface PlanLimits {
	id: string;
	provider: string;
	tier: string;
	mode: "api" | "subscription";
	/** 5-hour rolling window, if the plan has one */
	short?: PlanWindow;
	/** Weekly rolling window, if the plan has one */
	long?: PlanWindow;
	/** Human-readable description */
	description?: string;
}

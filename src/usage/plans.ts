/**
 * Plan catalog.
 *
 * Hardcoded subscription limits for the plans we care about. Numbers come
 * from publicly documented sources:
 *
 *   - OpenAI Codex: https://developers.openai.com/codex/pricing/
 *   - Anthropic Claude: https://support.anthropic.com/en/articles/11145838
 *
 * These are ranges — the real cap depends on task complexity, context size,
 * and server load. We track both the min (conservative) and max (optimistic)
 * bounds. For Anthropic, published caps are *hours of use per week* for
 * subscription tiers; for Codex, they're *messages per 5h window* with
 * separate weekly caps.
 *
 * When a model isn't listed, it falls back to the plan's default. When a
 * plan isn't listed at all, we default to "api" mode (pay-per-token, show
 * dollar cost, no window tracking).
 */

import type { PlanLimits } from "./types.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * OpenAI Codex via ChatGPT subscriptions.
 *
 * Local messages and cloud tasks share the 5h window. We track local-message
 * caps here since pi agents run locally. Numbers are the "Local Messages / 5h"
 * ranges published on the Codex pricing page.
 */
export const openaiPlus: PlanLimits = {
	id: "openai-plus",
	provider: "openai-codex",
	tier: "plus",
	mode: "subscription",
	description: "ChatGPT Plus ($20/mo) — includes Codex CLI access",
	short: {
		durationMs: FIVE_HOURS_MS,
		unit: "messages",
		capByModel: {
			"gpt-5.4": { min: 33, max: 168 },
			"gpt-5.4-mini": { min: 110, max: 560 },
			"gpt-5.3-codex": { min: 45, max: 225 },
			"gpt-5.3-codex-mini": { min: 150, max: 760 },
			"gpt-5.1-codex-mini": { min: 150, max: 760 },
			"gpt-5.2-codex": { min: 45, max: 225 },
		},
	},
	// Plus has no separately-published weekly cap; the 5h window is the practical limit.
};

export const openaiPro: PlanLimits = {
	id: "openai-pro",
	provider: "openai-codex",
	tier: "pro",
	mode: "subscription",
	description: "ChatGPT Pro ($200/mo) — 6x Plus limits (currently 2x promo)",
	short: {
		durationMs: FIVE_HOURS_MS,
		unit: "messages",
		capByModel: {
			// 6x the Plus ranges
			"gpt-5.4": { min: 198, max: 1008 },
			"gpt-5.4-mini": { min: 660, max: 3360 },
			"gpt-5.3-codex": { min: 270, max: 1350 },
			"gpt-5.3-codex-mini": { min: 900, max: 4560 },
			"gpt-5.1-codex-mini": { min: 900, max: 4560 },
			"gpt-5.2-codex": { min: 270, max: 1350 },
		},
	},
};

export const openaiBusiness: PlanLimits = {
	id: "openai-business",
	provider: "openai-codex",
	tier: "business",
	mode: "subscription",
	description: "ChatGPT Business ($25/user/mo) — ~2x Plus with team features",
	short: {
		durationMs: FIVE_HOURS_MS,
		unit: "messages",
		capByModel: {
			"gpt-5.4": { min: 66, max: 336 },
			"gpt-5.4-mini": { min: 220, max: 1120 },
			"gpt-5.3-codex": { min: 90, max: 450 },
			"gpt-5.3-codex-mini": { min: 300, max: 1520 },
			"gpt-5.1-codex-mini": { min: 300, max: 1520 },
			"gpt-5.2-codex": { min: 90, max: 450 },
		},
	},
};

/**
 * Anthropic Claude subscriptions.
 *
 * Anthropic publishes per-model *hours of use* per week, plus a shared 5-hour
 * session window with model-specific message caps. The official docs use
 * hours; we track both as rough message-count approximations derived from
 * typical-task assumptions. These ARE the least precise of all plans — the
 * real enforcement is opaque.
 */
export const anthropicPro: PlanLimits = {
	id: "anthropic-pro",
	provider: "anthropic",
	tier: "pro",
	mode: "subscription",
	description: "Claude Pro ($20/mo) — Sonnet + Haiku; limited Opus",
	short: {
		durationMs: FIVE_HOURS_MS,
		unit: "messages",
		capByModel: {
			"claude-sonnet-4-5": { min: 45, max: 225 },
			"claude-sonnet-4-6": { min: 45, max: 225 },
			"claude-opus-4-6": { min: 5, max: 25 },
			"claude-opus-4-5": { min: 5, max: 25 },
			"claude-haiku-4-5": { min: 150, max: 700 },
		},
	},
	long: {
		durationMs: ONE_WEEK_MS,
		unit: "hours",
		capByModel: {
			"claude-sonnet-4-5": { min: 40, max: 40 },
			"claude-sonnet-4-6": { min: 40, max: 40 },
			"claude-opus-4-6": { min: 5, max: 5 },
			"claude-opus-4-5": { min: 5, max: 5 },
			"claude-haiku-4-5": { min: 80, max: 80 },
		},
	},
};

export const anthropicMax5x: PlanLimits = {
	id: "anthropic-max-5x",
	provider: "anthropic",
	tier: "max-5x",
	mode: "subscription",
	description: "Claude Max 5x ($100/mo) — 5x the Pro limits",
	short: {
		durationMs: FIVE_HOURS_MS,
		unit: "messages",
		capByModel: {
			"claude-sonnet-4-5": { min: 225, max: 1125 },
			"claude-sonnet-4-6": { min: 225, max: 1125 },
			"claude-opus-4-6": { min: 25, max: 125 },
			"claude-opus-4-5": { min: 25, max: 125 },
			"claude-haiku-4-5": { min: 750, max: 3500 },
		},
	},
	long: {
		durationMs: ONE_WEEK_MS,
		unit: "hours",
		capByModel: {
			"claude-sonnet-4-5": { min: 200, max: 200 },
			"claude-sonnet-4-6": { min: 200, max: 200 },
			"claude-opus-4-6": { min: 25, max: 25 },
			"claude-opus-4-5": { min: 25, max: 25 },
			"claude-haiku-4-5": { min: 400, max: 400 },
		},
	},
};

export const anthropicMax20x: PlanLimits = {
	id: "anthropic-max-20x",
	provider: "anthropic",
	tier: "max-20x",
	mode: "subscription",
	description: "Claude Max 20x ($200/mo) — 20x the Pro limits",
	short: {
		durationMs: FIVE_HOURS_MS,
		unit: "messages",
		capByModel: {
			"claude-sonnet-4-5": { min: 900, max: 4500 },
			"claude-sonnet-4-6": { min: 900, max: 4500 },
			"claude-opus-4-6": { min: 100, max: 500 },
			"claude-opus-4-5": { min: 100, max: 500 },
			"claude-haiku-4-5": { min: 3000, max: 14000 },
		},
	},
	long: {
		durationMs: ONE_WEEK_MS,
		unit: "hours",
		capByModel: {
			"claude-sonnet-4-5": { min: 800, max: 800 },
			"claude-sonnet-4-6": { min: 800, max: 800 },
			"claude-opus-4-6": { min: 100, max: 100 },
			"claude-opus-4-5": { min: 100, max: 100 },
			"claude-haiku-4-5": { min: 1600, max: 1600 },
		},
	},
};

/**
 * API (pay-per-token) — no window tracking, dollar cost is meaningful.
 */
export const apiPlan: PlanLimits = {
	id: "api",
	provider: "*",
	tier: "pay-per-token",
	mode: "api",
	description: "Pay-per-token via direct API key — dollar cost is real",
};

export const PLAN_CATALOG: Record<string, PlanLimits> = {
	"openai-plus": openaiPlus,
	"openai-pro": openaiPro,
	"openai-business": openaiBusiness,
	"anthropic-pro": anthropicPro,
	"anthropic-max-5x": anthropicMax5x,
	"anthropic-max-20x": anthropicMax20x,
	api: apiPlan,
};

export function getPlan(id: string | undefined): PlanLimits {
	if (!id) return apiPlan;
	return PLAN_CATALOG[id] ?? apiPlan;
}

export function listPlans(): string[] {
	return Object.keys(PLAN_CATALOG);
}

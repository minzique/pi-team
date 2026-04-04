/**
 * Format a UsageSnapshot as a compact single-line status string, suitable
 * for display in the observer after each turn.
 *
 * Examples:
 *   claude │ sonnet-4-5      │ 5h: 12/45–225 msg (26%) · wk: 0.4/40h
 *   codex  │ gpt-5.4 high    │ 5h: 5/33–168 msg (15%)
 *   api    │ haiku-4-5       │ 1.2K in / 340 out  $0.0042
 */

import type { UsageSnapshot, WindowSnapshot } from "./types.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[38;5;42m";

export interface ReporterOptions {
	color?: boolean;
	/** Use optimistic (max) bound for percent calculation instead of conservative (min). */
	optimistic?: boolean;
}

export function formatSnapshot(snap: UsageSnapshot, opts: ReporterOptions = {}): string {
	const color = opts.color ?? true;
	const c = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);

	const agentLabel = c(BOLD, snap.agentName.padEnd(8));
	const modelLabel = shortenModel(snap.model).padEnd(18);

	if (snap.planMode === "api") {
		// Pay-per-token display: tokens + dollar cost
		const { input, output } = snap.sessionTokens;
		const tokens = `${formatNum(input)} in / ${formatNum(output)} out`;
		const cost = `$${snap.sessionDollarCost.toFixed(4)}`;
		return `${agentLabel} │ ${modelLabel} │ ${tokens}  ${c(DIM, cost)}`;
	}

	// Subscription display: windows
	const parts: string[] = [];
	if (snap.windows.short) {
		parts.push(formatWindow("5h", snap.windows.short, color, opts.optimistic ?? false));
	}
	if (snap.windows.long) {
		parts.push(formatWindow("wk", snap.windows.long, color, opts.optimistic ?? false));
	}

	const planLabel = c(DIM, snap.planId);
	return `${agentLabel} │ ${modelLabel} │ ${parts.join(" · ")}  ${planLabel}`;
}

function formatWindow(
	label: string,
	w: WindowSnapshot,
	color: boolean,
	optimistic: boolean,
): string {
	const cap = optimistic && w.capMax ? w.capMax : w.cap;
	const used = w.unit === "hours" ? w.used : Math.round(w.used);
	const capStr = w.capMax && w.cap !== w.capMax ? `${w.cap}–${w.capMax}` : String(cap);
	const unit = w.unit === "messages" ? "msg" : w.unit === "tokens" ? "tok" : "h";

	const percent = cap > 0 ? Math.min(100, (w.used / cap) * 100) : 0;
	const pctStr = `${percent.toFixed(0)}%`;

	const usedStr = w.unit === "hours" ? used.toFixed(1) : String(used);
	const body = `${label}: ${usedStr}/${capStr} ${unit} (${pctStr})`;

	if (!color) return body;
	if (percent >= 90) return `\x1b[38;5;196m${body}${RESET}`;
	if (percent >= 75) return `\x1b[38;5;220m${body}${RESET}`;
	if (percent >= 50) return `${GREEN}${body}${RESET}`;
	return `${DIM}${body}${RESET}`;
}

function shortenModel(model: string): string {
	// Drop common prefixes for display
	return model
		.replace(/^claude-/, "")
		.replace(/-20\d{6}$/, "");
}

function formatNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

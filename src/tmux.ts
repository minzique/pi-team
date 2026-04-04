/**
 * Tmux UI helper: creates a 3-pane layout for observing a team session.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │                                              │
 *   │  pane 0: orchestrator stream (main view)     │
 *   │  ─ colored agent messages + deltas           │
 *   │                                              │
 *   ├─────────────────────────┬────────────────────┤
 *   │ pane 1: inject prompt   │ pane 2: meta/tail  │
 *   │ (user types here)       │ (log tail)         │
 *   └─────────────────────────┴────────────────────┘
 *
 * Users attach with `tmux attach -t <name>` and detach with Ctrl+b d.
 */

import { execSync, spawnSync } from "node:child_process";

export function tmuxInstalled(): boolean {
	const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
	return r.status === 0;
}

export function sessionExists(name: string): boolean {
	const r = spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
	return r.status === 0;
}

export function killSession(name: string): void {
	if (sessionExists(name)) {
		spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
	}
}

export interface TmuxLayoutOptions {
	sessionName: string;
	orchestratorCmd: string;
	injectCmd: string;
	logPath: string;
}

/**
 * Create a new detached tmux session running the orchestrator in pane 0,
 * the inject client in pane 1, and a log tail in pane 2.
 */
export function createLayout(opts: TmuxLayoutOptions): void {
	if (sessionExists(opts.sessionName)) {
		throw new Error(`tmux session "${opts.sessionName}" already exists`);
	}
	// Large default size so wrap looks OK even if first attach is small
	execSync(
		`tmux new-session -d -s ${shell(opts.sessionName)} -x 220 -y 55 ${shell(opts.orchestratorCmd)}`,
		{ stdio: "inherit" },
	);
	// Split horizontally (bottom pane)
	execSync(`tmux split-window -v -p 25 -t ${shell(opts.sessionName)} ${shell(opts.injectCmd)}`, {
		stdio: "inherit",
	});
	// Split the bottom pane vertically for a log tail
	execSync(
		`tmux split-window -h -p 50 -t ${shell(opts.sessionName)} ${shell(`tail -f ${opts.logPath}`)}`,
		{ stdio: "inherit" },
	);
	// Return focus to main orchestrator pane
	execSync(`tmux select-pane -t ${shell(`${opts.sessionName}.0`)}`, { stdio: "inherit" });
}

function shell(s: string): string {
	// POSIX single-quote escape
	return `'${s.replace(/'/g, "'\\''")}'`;
}

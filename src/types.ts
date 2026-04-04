/**
 * Shared types for pi-team.
 *
 * The orchestrator maintains a single shared transcript. Each message has a
 * `from` field identifying the speaker (agent name or "human"). Each agent has
 * its own internal pi session; the orchestrator routes messages between them.
 */

export interface AgentSpec {
	/** Short name, used as attribution prefix. e.g. "claude", "codex" */
	name: string;
	/** Provider id, e.g. "anthropic", "openai-codex", "google" */
	provider: string;
	/** Model id, e.g. "claude-sonnet-4-5", "gpt-5.4" */
	model: string;
	/** Optional thinking level */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Optional system prompt append (character / persona) */
	systemPromptAppend?: string;
	/** Optional initial message this agent is told before the topic. */
	briefing?: string;
}

export interface TeamMessage {
	/** Monotonic id within the transcript */
	seq: number;
	/** Unix ms */
	timestamp: number;
	/** "human" for user injections, or an agent name */
	from: string;
	/** "user" (anything not-from-an-agent from the agent's POV) or "assistant" */
	role: "user" | "assistant" | "system";
	/** Text content */
	content: string;
}

export interface OrchestraConfig {
	/** Unique session name. Used for tmux session and storage dir. */
	name: string;
	/** Storage root, default ~/.pi/team/sessions */
	sessionsDir: string;
	/** Agents participating, in turn order for round-robin */
	agents: AgentSpec[];
	/** Turn-taking strategy */
	mode: "round-robin" | "free";
	/** Max turns before auto-stop. 0 = unlimited */
	maxTurns: number;
	/** Initial topic / prompt the first agent receives */
	topic: string;
	/** Optional shared context prepended to every agent's system prompt */
	sharedContext?: string;
	/** Idle timeout ms between turns (for rate-limiting) */
	turnDelayMs: number;
}

export interface TeamEvent {
	type: "message" | "turn_start" | "turn_end" | "agent_error" | "stop" | "human_inject" | "info";
	timestamp: number;
	agent?: string;
	message?: TeamMessage;
	error?: string;
	info?: string;
}

/**
 * Injection server: a Unix domain socket that accepts human messages and
 * forwards them to the running Orchestra. Lets the user hop in live from a
 * separate tmux pane (or remote shell) without disturbing the orchestrator's
 * stdout stream.
 *
 * Protocol: newline-delimited text. Every line is one injection. Empty lines
 * ignored. The socket file is created under the session dir.
 */

import { createServer, type Server } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import type { Orchestra } from "./orchestra.js";

export class InjectServer {
	private server: Server | null = null;

	constructor(
		private readonly orchestra: Orchestra,
		private readonly socketPath: string,
	) {}

	start(): void {
		if (existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				/* ignore */
			}
		}
		this.server = createServer((conn) => {
			let buffer = "";
			conn.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, "");
					buffer = buffer.slice(nl + 1);
					if (line.trim()) {
						this.orchestra.inject(line);
						conn.write("ok\n");
					}
					nl = buffer.indexOf("\n");
				}
			});
			conn.on("end", () => {
				if (buffer.trim()) this.orchestra.inject(buffer.trim());
			});
			conn.on("error", () => {
				/* ignore */
			});
		});
		this.server.listen(this.socketPath);
	}

	stop(): void {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		if (existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Client-side: read lines from stdin (with a `team › ` prompt) and send them
 * to the socket. Used by `pi-team inject <socket>`.
 */
export async function runInjectClient(socketPath: string): Promise<void> {
	const { createConnection } = await import("node:net");
	const readline = await import("node:readline");

	const conn = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		conn.once("connect", () => resolve());
		conn.once("error", reject);
	});

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	rl.setPrompt("team › ");
	rl.prompt();

	rl.on("line", (line) => {
		if (line.trim()) {
			conn.write(`${line}\n`);
		}
		rl.prompt();
	});

	rl.on("close", () => {
		conn.end();
		process.exit(0);
	});

	conn.on("data", () => {
		// server ack; don't echo
	});

	conn.on("end", () => {
		rl.close();
	});
}

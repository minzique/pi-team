/**
 * HTTP inject endpoint: thin wrapper so external systems (ops-agent, curl,
 * webhooks) can post human messages into a running team session without
 * touching the Unix socket directly.
 *
 * Endpoints:
 *   POST /inject        body = raw text or { "message": "..." }
 *   GET  /state         returns {agents, turn, lastMessages}
 *   GET  /transcript    returns JSONL of full transcript
 *   POST /stop          gracefully stops the orchestra
 *
 * All responses JSON. Defaults to binding on 127.0.0.1 (localhost-only). Set
 * host to "0.0.0.0" or another interface to expose over the network — when
 * you do, you should also set PITEAM_HTTP_TOKEN so untrusted clients on the
 * LAN can't POST /inject and feed arbitrary text into the agents.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Orchestra } from "./orchestra.js";

/** Hard cap on POST /inject body to stop runaway streaming from eating memory. */
const MAX_BODY_BYTES = 1_000_000; // 1 MB

interface HttpInjectOptions {
	orchestra: Orchestra;
	port: number;
	sessionDir: string;
	token?: string;
	/** Interface to bind. Defaults to "127.0.0.1" (localhost-only). */
	host?: string;
	onStop?: () => Promise<void>;
}

export function startHttpInject(opts: HttpInjectOptions): { stop: () => void } {
	const server = createServer(async (req, res) => {
		try {
			if (opts.token) {
				const auth = req.headers.authorization;
				if (auth !== `Bearer ${opts.token}`) {
					return json(res, 401, { error: "unauthorized" });
				}
			}

			const url = req.url ?? "/";
			if (req.method === "POST" && url === "/inject") {
				const body = await readBody(req);
				let message: string;
				try {
					const parsed = JSON.parse(body);
					message = typeof parsed === "string" ? parsed : parsed.message;
				} catch {
					message = body;
				}
				if (!message || !message.trim()) {
					return json(res, 400, { error: "empty message" });
				}
				opts.orchestra.inject(message);
				return json(res, 200, { ok: true, queued: message.length });
			}

			if (req.method === "GET" && url === "/state") {
				return json(res, 200, {
					session: opts.orchestra.config.name,
					agents: opts.orchestra.config.agents.map((a) => ({
						name: a.name,
						provider: a.provider,
						model: a.model,
						planId: a.planId ?? "api",
					})),
					lastMessages: opts.orchestra.lastMessages(5),
					usage: opts.orchestra.usageSnapshots(),
				});
			}

			if (req.method === "GET" && url === "/usage") {
				return json(res, 200, {
					session: opts.orchestra.config.name,
					snapshots: opts.orchestra.usageSnapshots(),
				});
			}

			if (req.method === "GET" && url === "/transcript") {
				const path = join(opts.sessionDir, "transcript.jsonl");
				try {
					const raw = readFileSync(path, "utf8");
					res.writeHead(200, { "content-type": "application/x-ndjson" });
					res.end(raw);
				} catch (err) {
					json(res, 500, { error: (err as Error).message });
				}
				return;
			}

			if (req.method === "POST" && url === "/stop") {
				if (opts.onStop) await opts.onStop();
				return json(res, 200, { ok: true });
			}

			if (req.method === "GET" && url === "/") {
				return json(res, 200, {
					service: "pi-team",
					session: opts.orchestra.config.name,
					endpoints: [
						"POST /inject",
						"GET /state",
						"GET /usage",
						"GET /transcript",
						"POST /stop",
					],
				});
			}

			json(res, 404, { error: "not found" });
		} catch (err) {
			json(res, 500, { error: (err as Error).message });
		}
	});
	const host = opts.host ?? "127.0.0.1";
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.error(`[http-inject] port ${opts.port} is already in use on ${host}`);
		} else {
			console.error(`[http-inject] server error: ${err.message}`);
		}
	});
	server.listen(opts.port, host);
	return { stop: () => server.close() };
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (c: Buffer) => {
			total += c.length;
			if (total > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

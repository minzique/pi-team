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
 * All responses JSON. No auth — intended to run on a trusted network or
 * behind a reverse proxy. Set PITEAM_HTTP_TOKEN to require a bearer token.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Orchestra } from "./orchestra.js";

interface HttpInjectOptions {
	orchestra: Orchestra;
	port: number;
	sessionDir: string;
	token?: string;
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
	server.listen(opts.port, "0.0.0.0");
	return { stop: () => server.close() };
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, postCallback } from "../run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const RUN_TOKEN = "eyJhbGciOiJFZERTQSJ9.run-token-payload.signature";
const OAUTH_TOKEN = "sk-ant-oat01-member-oauth-token";
const API_KEY = "sk-ant-api03-must-never-be-used";
// Shell metacharacters that would run commands if the prompt ever reached a shell.
const PROMPT =
	"Who am I? $(touch PWNED) `touch PWNED` ; touch PWNED && echo \"quoted\" 'single' \n--help";

/** @type {string} */
let dir;
/** @type {{ headers: import("node:http").IncomingHttpHeaders; body: any; url?: string }[]} */
let callbacks;
/** @type {number[]} */
let callbackStatuses;
/** @type {import("node:http").Server} */
let server;
/** @type {string} */
let callbackUrl;

before(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			callbacks.push({ headers: request.headers, body: JSON.parse(body), url: request.url });
			response.statusCode = callbackStatuses.shift() ?? 200;
			response.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	callbackUrl = `http://127.0.0.1:${address.port}/runs/run-42/result`;
});

after(() => server.close());

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "dev-claude-test-"));
	callbacks = [];
	callbackStatuses = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * Writes an executable fake `claude` that records into `record.json`.
 * @param {import("./fake-claude.mjs").FakeBehavior} [behavior]
 */
async function fakeBin(behavior = {}) {
	const bin = join(dir, "claude.mjs");
	const impl = pathToFileURL(join(here, "fake-claude.mjs")).href;
	await writeFile(
		bin,
		`#!/usr/bin/env node\nimport { fakeClaude } from ${JSON.stringify(impl)};\n` +
			`await fakeClaude(${JSON.stringify(join(dir, "record.json"))}, ${JSON.stringify(behavior)});\n`,
		{ mode: 0o755 },
	);
	return bin;
}

async function record() {
	return JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
}

/**
 * Runs the runner in-process with a GitHub-like environment and captures its output.
 * @param {Record<string, string>} overrides
 * @param {import("./fake-claude.mjs").FakeBehavior} [behavior]
 */
async function run(overrides = {}, behavior = {}) {
	/** @type {string[]} */
	const out = [];
	/** @type {string[]} */
	const err = [];
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: dir,
		RUNNER_TEMP: dir,
		GITHUB_OUTPUT: join(dir, "github-output"),
		GITHUB_STEP_SUMMARY: join(dir, "step-summary"),
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_REPOSITORY: "anna/tumai-claude-runner",
		GITHUB_RUN_ID: "123456",
		// The runner must not pass any of these on.
		ANTHROPIC_API_KEY: API_KEY,
		ANTHROPIC_AUTH_TOKEN: "gateway-token",
		ANTHROPIC_BASE_URL: "https://evil.example",
		CLAUDE_CODE_USE_BEDROCK: "1",
		UNRELATED_SECRET: "keep-me-out",
		CLAUDE_BIN: await fakeBin(behavior),
		CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
		DEV_CLAUDE_PROMPT: PROMPT,
		DEV_CLAUDE_RUN_ID: "run-42",
		DEV_CLAUDE_RUN_TOKEN: RUN_TOKEN,
		DEV_CLAUDE_MCP_URL: "https://dev-mcp.example.org/mcp",
		DEV_CLAUDE_CALLBACK_URL: callbackUrl,
		...overrides,
	};
	const code = await main(env, { out: (line) => out.push(line), err: (line) => err.push(line) });
	return { code, out, err, log: [...out, ...err].join("\n") };
}

describe("runner", () => {
	it("runs Claude Code locked to dev-mcp and reports success", async () => {
		const { code, out } = await run();
		assert.equal(code, 0);

		const seen = await record();
		assert.deepEqual(seen.mcpConfig, {
			mcpServers: {
				tumai: {
					type: "http",
					url: "https://dev-mcp.example.org/mcp",
					headers: { Authorization: `Bearer ${RUN_TOKEN}` },
				},
			},
		});
		const flag = (/** @type {string} */ name) => seen.args[seen.args.indexOf(name) + 1];
		assert.equal(seen.args[0], "--print");
		assert.equal(flag("--output-format"), "json");
		assert.equal(flag("--tools"), "");
		assert.equal(flag("--allowedTools"), "mcp__tumai__*");
		assert.equal(flag("--permission-mode"), "dontAsk");
		assert.equal(flag("--permission-prompts"), "none");
		assert.equal(flag("--max-turns"), "10");
		assert.ok(seen.args.includes("--strict-mcp-config"));
		assert.ok(!seen.args.includes("--model"));
		assert.deepEqual(seen.cwdEntries, [], "Claude Code starts in an empty directory");
		assert.equal(existsSync(seen.configPath), false, "the MCP config is deleted afterwards");

		assert.deepEqual(callbacks, [
			{
				url: "/runs/run-42/result",
				headers: callbacks[0]?.headers,
				body: {
					run_id: "run-42",
					status: "succeeded",
					result:
						"You are <@U0123ABCD> (lead) in run run-42. Available tools: create_mailbox, whoami.",
					error: null,
					github_run_url: "https://github.com/anna/tumai-claude-runner/actions/runs/123456",
				},
			},
		]);
		assert.equal(callbacks[0]?.headers.authorization, `Bearer ${RUN_TOKEN}`);
		assert.match(await readFile(join(dir, "github-output"), "utf8"), /^status=succeeded$/m);
		assert.match(
			await readFile(join(dir, "step-summary"), "utf8"),
			/Dev Claude: succeeded[\s\S]*You are/,
		);
		assert.ok(out.includes("Dev Claude result: succeeded"));
	});

	it("passes the prompt on stdin only, byte for byte, never through a shell", async () => {
		await run();
		const seen = await record();
		assert.equal(seen.stdin, PROMPT);
		assert.ok(!seen.args.some((/** @type {string} */ arg) => arg.includes("touch PWNED")));
		assert.equal(existsSync(join(dir, "PWNED")), false);
		assert.equal(existsSync(join(seen.cwd, "PWNED")), false);
	});

	it("gives Claude Code an allowlisted environment without API keys or the run token", async () => {
		await run();
		const { env } = await record();
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"UNRELATED_SECRET",
			"DEV_CLAUDE_RUN_TOKEN",
			"DEV_CLAUDE_PROMPT",
		]) {
			assert.equal(env[key], undefined, `${key} must not reach Claude Code`);
		}
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_TOKEN);
		assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
		assert.equal(env.DISABLE_UPDATES, "1");
		assert.ok(!JSON.stringify(env).includes(API_KEY));
	});

	it("masks both tokens first and never prints them otherwise", async () => {
		const { out, log } = await run(
			{},
			// Even if Claude Code printed a token, it must not reach the log or dev-claude.
			{ exitCode: 1, stdout: "", stderr: `boom: ${RUN_TOKEN} ${OAUTH_TOKEN}` },
		);
		assert.deepEqual(out.slice(0, 2), [`::add-mask::${RUN_TOKEN}`, `::add-mask::${OAUTH_TOKEN}`]);
		const rest = log
			.replace(`::add-mask::${RUN_TOKEN}`, "")
			.replace(`::add-mask::${OAUTH_TOKEN}`, "");
		assert.ok(!rest.includes(RUN_TOKEN));
		assert.ok(!rest.includes(OAUTH_TOKEN));
		assert.ok(!JSON.stringify(callbacks[0]?.body).includes(RUN_TOKEN));
		assert.match(callbacks[0]?.body.error, /\*\*\* \*\*\*/);
	});

	it("reports a crash as failed and fails the job", async () => {
		const { code } = await run({}, { exitCode: 1, stdout: "", stderr: "Invalid API key\n" });
		assert.equal(code, 1);
		assert.deepEqual(callbacks[0]?.body, {
			run_id: "run-42",
			status: "failed",
			result: null,
			error: "Claude Code exited with code 1: Invalid API key",
			github_run_url: "https://github.com/anna/tumai-claude-runner/actions/runs/123456",
		});
		assert.match(await readFile(join(dir, "github-output"), "utf8"), /^status=failed$/m);
	});

	it("reports an error result (e.g. max turns) as failed", async () => {
		const stdout = JSON.stringify({
			type: "result",
			subtype: "error_max_turns",
			is_error: true,
			errors: ["Reached maximum number of turns (10)"],
		});
		const { code } = await run({}, { stdout });
		assert.equal(code, 1);
		assert.equal(callbacks[0]?.body.status, "failed");
		assert.equal(
			callbacks[0]?.body.error,
			"Claude Code failed: Reached maximum number of turns (10)",
		);
	});

	it("stops Claude Code after the timeout and reports it", async () => {
		const { code } = await run({ DEV_CLAUDE_TIMEOUT_SECONDS: "0.3" }, { delayMs: 5_000 });
		assert.equal(code, 1);
		assert.equal(callbacks[0]?.body.error, "Claude Code did not finish in time.");
	});

	it("passes a model and turn limit, and rejects values that could smuggle in flags", async () => {
		await run({ DEV_CLAUDE_MODEL: "sonnet", DEV_CLAUDE_MAX_TURNS: "4" });
		const { args } = await record();
		assert.equal(args[args.indexOf("--model") + 1], "sonnet");
		assert.equal(args[args.indexOf("--max-turns") + 1], "4");

		await rm(join(dir, "record.json"));
		const { code, err } = await run({ DEV_CLAUDE_MODEL: "--dangerously-skip-permissions" });
		assert.equal(code, 1);
		assert.equal(existsSync(join(dir, "record.json")), false, "Claude Code never started");
		assert.match(err.join("\n"), /::error::Invalid runner inputs/);
		assert.equal(callbacks.at(-1)?.body.status, "failed");
		assert.match(callbacks.at(-1)?.body.error, /model is not a model name/);
	});

	it("refuses to send the run token over plain http", async () => {
		const { code } = await run({ DEV_CLAUDE_MCP_URL: "http://dev-mcp.example.org/mcp" });
		assert.equal(code, 1);
		assert.equal(existsSync(join(dir, "record.json")), false);
		assert.match(callbacks[0]?.body.error, /mcp_url must be an https URL/);
	});

	it("keeps workflow commands in Claude's answer from being executed", async () => {
		const stdout = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "::add-mask::everything\n::error::fake",
		});
		const { out } = await run({}, { stdout });
		const start = out.findIndex((line) => line.startsWith("::stop-commands::"));
		const guard = out[start]?.replace("::stop-commands::", "");
		assert.ok(guard && guard.length >= 32);
		assert.equal(out[start + 1], "::add-mask::everything\n::error::fake");
		assert.equal(out[start + 2], `::${guard}::`);
	});

	it("fails the job when the result can't be reported", async () => {
		callbackStatuses.push(401);
		const { code, err } = await run();
		assert.equal(code, 1);
		assert.equal(callbacks.length, 1, "4xx responses are not retried");
		assert.match(err.join("\n"), /Could not report the result to Dev Claude \(HTTP 401\)/);
	});

	it("only logs the result when there is no callback URL", async () => {
		const { code, out } = await run({ DEV_CLAUDE_CALLBACK_URL: "" });
		assert.equal(code, 0);
		assert.equal(callbacks.length, 0);
		assert.ok(out.some((line) => line.startsWith("You are <@U0123ABCD>")));
	});
});

describe("postCallback", () => {
	it("retries server errors and succeeds", async () => {
		callbackStatuses.push(502, 503);
		const result = await postCallback(new URL(callbackUrl), RUN_TOKEN, { ok: 1 }, { delayMs: 1 });
		assert.deepEqual(result, { ok: true, detail: "HTTP 200" });
		assert.equal(callbacks.length, 3);
	});

	it("gives up after the last attempt", async () => {
		callbackStatuses.push(500, 500, 500);
		const result = await postCallback(new URL(callbackUrl), RUN_TOKEN, {}, { delayMs: 1 });
		assert.deepEqual(result, { ok: false, detail: "HTTP 500" });
	});
});

describe("entrypoint", () => {
	it("exits non-zero with a GitHub error annotation when inputs are missing", () => {
		const result = spawnSync(process.execPath, [join(root, "run.mjs")], {
			env: { PATH: process.env.PATH ?? "" },
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /::error::Invalid runner inputs:%0A- prompt is empty/);
	});
});

describe("workflow files", () => {
	/**
	 * The text of every `run:` block in a workflow or action file.
	 * @param {string} yaml
	 */
	function runBlocks(yaml) {
		const lines = yaml.split("\n");
		/** @type {string[]} */
		const blocks = [];
		lines.forEach((line, index) => {
			const match = /^(\s*)(?:- )?run: (\S.*)$/.exec(line);
			if (!match) return;
			const indent = (match[1] ?? "").length;
			const body = [match[2] ?? ""];
			for (const next of lines.slice(index + 1)) {
				if (next.trim() && next.search(/\S/) <= indent) break;
				body.push(next);
			}
			blocks.push(body.join("\n"));
		});
		return blocks;
	}

	for (const file of ["action.yml", ".github/workflows/dev-claude.yml"]) {
		it(`${file} never expands expressions inside shell scripts`, async () => {
			const yaml = await readFile(join(root, file), "utf8");
			const blocks = runBlocks(yaml);
			assert.ok(blocks.length > 0);
			for (const block of blocks) {
				assert.ok(!block.includes("${{"), `expression inside run: ${block}`);
			}
		});
	}

	it("the member workflow masks the run token before calling the action and has no permissions", async () => {
		const yaml = await readFile(join(root, ".github/workflows/dev-claude.yml"), "utf8");
		assert.match(yaml, /^permissions: \{\}$/m);
		const mask = yaml.indexOf("::add-mask::");
		const action = yaml.indexOf("uses: tum-ai/claude-runner@v1");
		assert.ok(mask > 0 && action > mask, "mask step must come before the action");
		assert.match(yaml, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
	});

	it("CI only runs in the source repo, not in members' copies", async () => {
		const yaml = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
		assert.match(yaml, /^ {4}if: github\.repository == 'tum-ai\/claude-runner'$/m);
	});
});

// @ts-check
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {object} FakeBehavior
 * @property {number} [exitCode]
 * @property {string} [stdout] Defaults to a successful `--output-format json` result.
 * @property {string} [stderr]
 * @property {number} [delayMs] Wait before answering (timeouts).
 */

/**
 * Stand-in for the `claude` CLI: records exactly how the runner started it (arguments,
 * environment, working directory, stdin and the MCP config file, which the runner deletes
 * afterwards) and then answers as `behavior` says.
 * @param {string} recordPath
 * @param {FakeBehavior} behavior
 */
export async function fakeClaude(recordPath, behavior) {
	const args = process.argv.slice(2);
	const stdin = readFileSync(0, "utf8");
	const configPath = args[args.indexOf("--mcp-config") + 1];
	writeFileSync(
		recordPath,
		JSON.stringify({
			args,
			env: process.env,
			cwd: process.cwd(),
			cwdEntries: readdirSync(process.cwd()),
			stdin,
			configPath,
			mcpConfig: configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null,
		}),
	);
	if (behavior.delayMs) {
		await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
	}
	if (behavior.stderr) process.stderr.write(behavior.stderr);
	process.stdout.write(
		behavior.stdout ??
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				num_turns: 2,
				result:
					"You are <@U0123ABCD> (lead) in run run-42. Available tools: create_mailbox, whoami.",
			}),
	);
	process.exitCode = behavior.exitCode ?? 0;
}

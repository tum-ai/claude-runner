# Your Dev Claude runner

This repository lets you use `@claude` in TUM.ai's Slack. When you ask Dev Claude for something,
TUM.ai's Dev Claude app starts the workflow in this repository. It runs the genuine Claude Code
CLI **on your own Claude plan**, in **your** GitHub Actions, with access to nothing but TUM.ai's
admin tools (dev-mcp). Claude gets no shell, no files and no web access here.

## Setup (about 3 minutes)

You need a GitHub account, the [`gh` CLI](https://cli.github.com) and
[Claude Code](https://code.claude.com/docs/en/setup) installed.

```bash
gh repo create tumai-claude-runner --private --template tum-ai/claude-runner
claude setup-token        # sign in in the browser, copy the token it prints
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <your-github-user>/tumai-claude-runner   # paste it (hidden)
```

Then click **Install Dev Claude** on the setup page and select `tumai-claude-runner`.

The token goes straight from your terminal into your GitHub repository's secrets. It never passes
through TUM.ai. The only file that matters in your copy is
`.github/workflows/dev-claude.yml`; the rest is the action's source, which your workflow loads from
`tum-ai/claude-runner` rather than from your copy.

## What TUM.ai can and can't do

- **Can:** start this workflow (the Dev Claude GitHub App has `Actions: write` on this repository
  only) and pass it your request plus a short-lived run token that says who you are.
- **Can't:** read your secrets or change this workflow file; the app gets neither the `Secrets`
  nor the `Workflows` permission. GitHub never shows secret values to anyone, including you.
- Runs use your Actions minutes (a run takes about 1–2 minutes) and your Claude plan's usage.
- Runs use Claude Opus 5.5 at medium effort. To change that for your own runs, set `model` or
  `effort` under `with:` in `.github/workflows/dev-claude.yml`.

The workflow runs with `permissions: {}`, never checks out code, masks the run token before
anything is logged, and passes your Claude token only to Claude Code, with `ANTHROPIC_API_KEY`
removed so a run can never switch to API billing.

## Pin the action (optional)

`uses: tum-ai/claude-runner@v1` follows TUM.ai's reviewed releases, so fixes reach you without
you touching this repository. If you'd rather trust no future change, pin a full commit SHA in
`.github/workflows/dev-claude.yml`:

```yaml
uses: tum-ai/claude-runner@<40-character commit SHA> # v1.x.y
```

You can also hard-code `mcp_url` there so the workflow only ever talks to TUM.ai's dev-mcp.

## Something broke?

- **Token expired or revoked:** run `claude setup-token` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN
  -R <your-github-user>/tumai-claude-runner` again.
- **Want to stop:** uninstall the Dev Claude GitHub App or delete this repository.

---

## For maintainers

`tum-ai/claude-runner` is two things: the public **template repository** members create their
runner from, and the **composite action** (`action.yml` + `run.mjs` at the root) their workflow
calls as `tum-ai/claude-runner@v1`. The Slack app lives in `tum-ai/dev-claude`.

```
dev-claude ──workflow_dispatch(run_id, prompt, run_token, mcp_url, callback_url)──► member's repo
member workflow: mask run token ─► tum-ai/claude-runner@v1
  install @anthropic-ai/claude-code@<pinned> ─► run.mjs ─► claude -p (prompt on stdin)
      └─ MCP: dev-mcp /mcp with "Authorization: Bearer <run token>" ─► whoami, create_mailbox, …
  run.mjs ─► POST callback_url { run_id, status, result, error, github_run_url } (Bearer run token)
```

### Security model

- **Inputs are data.** `action.yml` passes every input through `env:`, never `${{ }}` inside a
  script; `run.mjs` starts Claude Code without a shell and writes the prompt to its stdin. A test
  checks both workflow files for expressions inside `run:` blocks.
- **Tokens stay hidden.** The member workflow masks the run token from the event payload before
  the action's `with:` values are logged; the action and `run.mjs` mask both tokens again and
  redact them from anything they print or send.
- **Only the member's plan.** Claude Code gets an allowlisted environment: no
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or cloud-provider switches,
  which would outrank `CLAUDE_CODE_OAUTH_TOKEN` or send it elsewhere.
- **Only dev-mcp.** `--tools ""` removes every built-in tool (no Bash, files or web),
  `--strict-mcp-config` loads only our MCP config, `--allowedTools "mcp__tumai__*"` with
  `--permission-mode dontAsk` and `--permission-prompts none` denies anything else, and
  `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps the member's own claude.ai connectors out. Claude Code
  starts in an empty directory with `--setting-sources user`, so no repository settings, hooks or
  `CLAUDE.md` load. dev-mcp decides which of its tools the member sees.
- **Pinned CLI.** `@anthropic-ai/claude-code` at an exact version (input `claude_code_version`,
  default `2.1.274`, the npm `stable` tag when pinned), with updates disabled. `--bare` is not used
  because it ignores `CLAUDE_CODE_OAUTH_TOKEN`.
- **Failures are visible.** The job fails when Claude Code fails or the callback can't be
  delivered, so dev-claude can detect a missing report from the GitHub run status.

Whoever controls this repository controls code that sees members' tokens at runtime: protect
`main` and the `v*` tags like production (required reviews, tag protection).

### Development

Node 24 · pnpm 11 · plain ESM JavaScript with JSDoc types (checked by `tsc`) so the action needs no
build · Biome · `node --test`. CI runs only in `tum-ai/claude-runner`, not in members' copies.

```bash
pnpm install
pnpm gate        # lint + typecheck + tests (the tests use a fake `claude` binary)
```

Releasing: tag `v1.x.y` on `main` and move the `v1` tag to it. Keep the repository public and
marked as a template repository in its settings.

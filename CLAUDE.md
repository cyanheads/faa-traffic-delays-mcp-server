# Developer Protocol

**Server:** faa-traffic-delays-mcp-server
**Package:** `@cyanheads/faa-traffic-delays-mcp-server`
**Version:** 0.2.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

The server wraps two FAA upstreams: the NAS Status dashboard's undocumented JSON backend (`https://nasstatus.faa.gov/api/*`) and the ATCSCC advisories database (`https://www.fly.faa.gov/adv/adv_otherdis` for one advisory, `https://www.fly.faa.gov/adv/adv_list` for the advisories issued on a UTC date). Six tools, no resources, no prompts. [`docs/design.md`](docs/design.md) is the design record — tool contracts, upstream shapes, design decisions, and known limitations; read the relevant section before changing a tool.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Field-test the first live Airspace Flow Program** — the en-route row shape is inferred from the dashboard bundle (`docs/design.md` Known Limitations); exercise `faa_delays_list_active_events` with the `field-test` skill when one is active
2. **Refresh the airport directory** — `bun run refresh:airports` at maintenance releases picks up the current FAA NASR cycle
3. **Add tests** — scaffold tests for new or changed definitions using the `add-test` skill
4. **Run `devcheck`** — lint, format, typecheck, and security audit
5. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
6. **Run the `polish-docs-meta` skill** — reconcile README, metadata, and agent protocol after the surface changes
7. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

Use the existing definitions as the server-specific examples:

- [get-airport-status.tool.ts](src/mcp-server/tools/definitions/get-airport-status.tool.ts) validates every airport code against the bundled NASR directory before any upstream request (`ctx.fail('unknown_airport', …)`), fetches the primary and secondary feeds with `Promise.allSettled`, rethrows only the primary leg (or any leg once `ctx.signal.aborted`), and reports a degraded secondary leg through `ctx.enrich.notice()`.
- [list-active-events.tool.ts](src/mcp-server/tools/definitions/list-active-events.tool.ts) declares required enrichment fields (`totalActive`, `shown`, `countsByType`, `appliedEventTypes`, `enRouteFeed`) written in one `ctx.enrich({ … })` call, with `enrichmentTrailer` labels and renders for `content[]`.
- [get-advisory.tool.ts](src/mcp-server/tools/definitions/get-advisory.tool.ts) normalizes inputs in `z.preprocess` (`"ADVZY 082"` → `82`, `MM/DD/YYYY` → `YYYY-MM-DD`), accepts the advisory reference's own field name via `inputAliases`, returns a missing advisory as `found: false` with `guidance` rather than an error, and discloses a cut text with `ctx.enrich.truncated()`.

Server-specific conventions:

- **Upstream fetch boundary.** Both HTTP services go through [`FaaHttpClient`](src/services/upstream/faa-http-client.ts): plain `fetch` with a 200-only accept-list (a 404 on a known path means the contract changed; a 200 can be an HTML maintenance page), `withRetry` under a 20 s deadline, a per-host `createPacer`, an 8 s per-attempt timer, and a per-host body ceiling (`maxBodyBytes`) the streamed read stops at. Never swap in `fetchWithTimeout` — it would classify a contract change as `NotFound`.
- **Failure reasons come from the service.** Services throw with `data.reason` (`feed_unavailable`, `upstream_rate_limited`, `retry_deadline_exceeded`, `pacer_shed`, `feed_contract_changed`, `advisory_service_unavailable`, `advisory_contract_changed`). Every calling tool declares each reason it can receive, with `thrownBy: 'service'` and a recovery that names that tool.
- **Tolerant parsing.** Feed bodies are `unknown`, read field by field in [`feed-parsers.ts`](src/services/nas-status/feed-parsers.ts). A wrong top-level shape is `feed_contract_changed`; a row without its key is skipped and counted (`skippedRows` → a `notice`); a wrong-typed field is omitted and logged once, never coerced.
- **Cache, not `ctx.state`.** The feeds are public and identical for every tenant, so they live in the in-process [`TtlCache`](src/services/upstream/ttl-cache.ts) with single-flight loading (feeds 60 s, pacing airports 6 h, advisories 6 h; advisory misses and per-date advisory indexes 60 s until their UTC date has been over an hour, then 6 h). The shared fetch never takes one caller's signal and logs through the global `logger` with a `RequestContext`; an expired entry is never served when a refresh fails. The advisory caches store a `structuredClone` of each parsed value, so an entry never holds a slice of the fetched page.
- **FAA-authored text in `format()`.** Render reasons, NOTAMs, comments, announcements, and advisory text through [`format-helpers.ts`](src/mcp-server/tools/format-helpers.ts) (`inline`, `cell`, `blockquote`, `fenced`), never raw. A value the FAA did not report is named or left out, never shown as a placeholder.
- **Advisory URLs are server-built.** Feed and index links carry unencoded spaces or relative paths and are only mined for `advn` and `adv_date` ([`advisory-ref.ts`](src/services/advisory/advisory-ref.ts)); no caller- or upstream-supplied URL reaches `fetch` or the output.
- **Airport directory.** [`nasr-airports.generated.ts`](src/services/airport-directory/nasr-airports.generated.ts) is generated by `bun run refresh:airports` from the FAA NASR subscription — never hand-edited, never fetched at runtime. It declares the table `NASR_AIRPORTS_TSV: string` so `tsc` does not repeat it as a literal type in the `.d.ts`.

### Server config

No server-specific environment variables. FAA hosts, cache TTLs, retry budgets, and pacer limits are constants in the services, so there is no `src/config/`. Adding a variable means a `server-config.ts` with `parseEnvConfig` plus entries in `.env.example`, `server.json`, `manifest.json`, both plugin manifests, and the README configuration table.

### Server identity and instructions

[src/index.ts](src/index.ts) sets `name` and `title` to `faa-traffic-delays-mcp-server` (the package name is scoped, so both are explicit) and carries the server `instructions` string — the orientation an agent reads on `initialize`. Keep it in step with the tool descriptions when the surface changes. `setup()` builds both upstream clients with a `faa-traffic-delays-mcp-server/<version>` User-Agent; `teardown()` disposes their pacers.

### Session mode

No handler requests additional input, so `createApp()` declares `sessionMode: 'stateless'` — the posture travels with the code rather than with each deployment. `MCP_SESSION_MODE` still overrides it. Introducing `ctx.requestInput` means switching to `stateful` here, and declaring `require: 'stateful'` if the handler cannot degrade.

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich(...)` or `.notice()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.fail` | Typed failure from the definition's `errors[]` contract (`ctx.fail('unknown_airport', …)`). |
| `ctx.signal` | `AbortSignal` for cancellation. Each caller races the shared single-flight fetch against its own signal. |
| `ctx.requestId` / `ctx.traceId` | Correlation ids, copied into the `RequestContext` the services log under. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point, server instructions, upstream client lifecycle
  services/
    upstream/
      faa-http-client.ts                # Shared fetch boundary: pacer, retry, per-attempt timer, status classification
      ttl-cache.ts                      # In-process TTL cache with single-flight loading
    nas-status/
      nas-status-service.ts             # NAS Status feed client (airport/en-route events, ops plan, announcements, pacing airports)
      feed-parsers.ts                   # Tolerant feed parsers
      types.ts                          # Normalized feed domain types
    advisory/
      advisory-service.ts               # ATCSCC advisories database client, advisory page and per-date index parsers
      advisory-ref.ts                   # Advisory references mined from feed and index links; server-built advisory and index URLs
    airport-directory/
      airport-directory.ts              # NASR directory lookup (name, place, ARTCC, coordinates) and ICAO → FAA crosswalk
      nasr-airports.generated.ts        # Generated by `bun run refresh:airports` — do not edit
  mcp-server/
    tools/
      definitions/
        index.ts                        # allToolDefinitions barrel
        [tool-name].tool.ts             # Tool definitions
      schemas.ts                        # Shared output schemas (advisory ref, delay profile, event types)
      advisory-date.ts                  # Advisory date input shared by faa_delays_get_advisory and faa_delays_list_advisories
      notices.ts                        # Shared notice fragments (stale delay, skipped rows)
      format-helpers.ts                 # Markdown rendering for FAA-authored text
scripts/
  refresh-airport-directory.ts          # Regenerates the NASR airport directory module
tests/
  fixtures/                             # FAA feed, advisory page, and advisory index fixtures
  helpers/                              # Fetch fakes and feed-failure helpers
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `get-airport-status.tool.ts` |
| Tool names | snake_case, `faa_delays_` prefix | `faa_delays_get_airport_status` |
| Directories | kebab-case | `src/services/nas-status/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Get the full text of one ATCSCC advisory…'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release on the version tag and attach the `.mcpb` bundle (release step) |
| `bun run publish-mcp` | Publish `server.json` to the MCP Registry (release step) |
| `bun run refresh:airports` | Regenerate the NASR airport directory from the current FAA cycle (maintenance; needs network and the system `unzip`). `-- --zip <path>` reads an already-downloaded `APT_CSV.zip` |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for request-scoped logging; shared single-flight fetches log through `logger` with a `RequestContext`
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Every service failure reason a tool can receive is declared on that tool with `thrownBy: 'service'` and a recovery naming the tool
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] FAA-authored text rendered through `format-helpers.ts`; a value the FAA did not report is named or left out, never a placeholder
- [ ] Upstream fields optional unless they are a row's key; parsers omit wrong-typed fields rather than coerce them
- [ ] Tests include at least one sparse payload case with omitted upstream fields, driven by the fixtures in `tests/fixtures/` and `createFetchMock`
- [ ] Registered in `allToolDefinitions` (`src/mcp-server/tools/definitions/index.ts`)
- [ ] `src/index.ts` `instructions` and `docs/design.md` updated when the surface changes
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes

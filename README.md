<div align="center">
  <h1>faa-traffic-delays-mcp-server</h1>
  <p><b>Track FAA ground stops, delay programs, airport delays, the operations plan, and ATCSCC advisories via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/faa-traffic-delays-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/faa-traffic-delays-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faa-traffic-delays-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/faa-traffic-delays-mcp-server/releases/latest/download/faa-traffic-delays-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faa-traffic-delays-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFhLXRyYWZmaWMtZGVsYXlzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faa-traffic-delays-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaa-traffic-delays-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Real-time air traffic management status from the FAA Air Traffic Control System Command Center (ATCSCC), read from the NAS Status feed behind [nasstatus.faa.gov](https://nasstatus.faa.gov) and the ATCSCC advisories database. Check US airports for ground stops, Ground Delay Programs, delays, and closures; list every active event nationwide, en-route Airspace Flow Programs included; and read the operations plan for later in the day and the full advisory behind each program. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `faa_delays_get_airport_status` | Current status of 1–25 US airports: ground stop, Ground Delay Program, delays, closures, deicing, and runway configuration with arrival rate |
| `faa_delays_list_active_events` | Every active event across the National Airspace System, Airspace Flow Programs included, sorted by severity with per-type counts |
| `faa_delays_get_operations_plan` | The Command Center's operations plan: programs and initiatives expected later today, with planned time and likelihood |
| `faa_delays_get_advisory` | Full text of one ATCSCC advisory by number and UTC date: program rate, scope, comments, and the plan's constraints |
| `faa_delays_list_reference` | Decode event types, traffic-management terms, ARTCC codes, the FAA pacing airports, and identifier formats |

## Capability reference

### `faa_delays_get_airport_status` <sub>tool</sub>

- `airports`: 1–25 codes, each a 3-character FAA identifier (`SEA`) or its ICAO code (`KSEA`, `PHNL`), case-insensitive, as an array or a comma-separated string; a code not in the bundled FAA NASR directory fails the whole call as `unknown_airport` (with `unknownCodes`) before any FAA request
- One row per airport, in request order: `status` (`closed`, `ground_stop`, `ground_delay_program`, `delays`, `restrictions_only`, `no_active_events`), `listedInFeed`, the resolved `airportName`, `requestedAs` for an ICAO input, and each active event — `groundStop`, `groundDelayProgram` with a per-15-minute `delayProfile`, `arrivalDelay` / `departureDelay` bands, `closure`, `closureNotam`, `deicing`
- `runwayConfiguration` (runways and `arrivalRatePerHour`) only for airports the feed lists; `isPacingAirport` and `timezone` are omitted with a `notice` when the FAA pacing-airport list can't be read

---

### `faa_delays_list_active_events` <sub>tool</sub>

- Optional `event_types` filter over `ground_stop`, `ground_delay_program`, `airspace_flow_program`, `arrival_delay`, `departure_delay`, `airport_closure`, `closure_notam`, `deicing` (aliases `gs`, `gdp`, `afp`); rows sorted by severity, with `reason`, delay figures, times, and an `advisory` reference where the FAA links one
- `totalActive` and `countsByType` cover the whole feed before the filter, and `shown` / `appliedEventTypes` echo what was returned; `airspace_flow_program` rows carry `afp` detail (constrained area, departure and arrival filters, altitudes, delay profile)
- `enRouteFeed` (`ok`, `unavailable`, `format_changed`) reports whether Airspace Flow Programs were read: an en-route failure omits them with a `notice` instead of failing the call, unless they are the only type requested

---

### `faa_delays_get_operations_plan` <sub>tool</sub>

- No input; `terminalPlanned` and `enRoutePlanned` items carry `text`, `timeQualifier` (`after`, `until`, `by`, `between`), `timeUtc` (`HHMM` with no date), and `likelihood` (`possible`, `probable`, `expected`)
- `announcements` lists current ATCSCC announcements (`[]` when none, absent with a `notice` when that list can't be read); `advisory` opens the full plan text with `faa_delays_get_advisory`

---

### `faa_delays_get_advisory` <sub>tool</sub>

- `advisory_number` (1–999) and `date` (UTC, `YYYY-MM-DD`; `MM/DD/YYYY` accepted), taken from an `advisory` reference's `number` and `date`; numbers restart at 1 each UTC day, and past advisories stay readable
- Returns `title`, `controlElement`, `subject`, `effectiveTime`, `sentAt`, and the full `text`; a number the database doesn't hold returns `found: false` with `guidance` rather than an error
- Text past 50,000 characters is cut and reported through `truncated` and `totalChars`; page failures surface as `advisory_service_unavailable` or `advisory_contract_changed`

---

### `faa_delays_list_reference` <sub>tool</sub>

- `topic`: `event_types`, `terms`, `artccs`, `pacing_airports`, or `identifiers`
- Only `pacing_airports` calls the FAA (live, cached 6 hours); `identifiers` also reports the bundled NASR airport directory's cycle date and airport count

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAA-specific:

- Reads the NAS Status feed (`nasstatus.faa.gov/api`) and the ATCSCC advisories database (`www.fly.faa.gov/adv`), keyless; FAA status and NASR airport data are US federal works in the public domain (17 U.S.C. §105), published by the Federal Aviation Administration
- Airport codes are checked against a bundled snapshot of the FAA NASR airport directory, with ICAO codes mapped to FAA identifiers by lookup (`KSEA` → `SEA`, `PHNL` → `HNL`), so a mistyped code fails instead of reading as a quiet airport
- Each feed is cached in process for 60 seconds (the pacing-airport list for 6 hours) with one shared in-flight request, and requests to each FAA host are paced; an expired snapshot is never served when a refresh fails
- Tolerant parsing of the undocumented feed: an unreadable row is skipped and counted in the `notice`, and a wrong-typed field is dropped rather than coerced

Agent-friendly output:

- Typed failure reasons: an outage (`feed_unavailable`), a slow or throttled FAA (`retry_deadline_exceeded`, `upstream_rate_limited`, `pacer_shed`), and a format change (`feed_contract_changed`, not retryable) stay distinct; each recovery hint names the tool to call next, and rate-limit errors carry `retryAfter` when it is known
- Graceful partial failure: a secondary FAA list that can't be read (pacing airports, en-route events, announcements) is omitted with a flag or `notice` instead of failing the call
- Freshness on every feed tool: `fetchedAt` for the snapshot, `updatedAt` on each event, and a `notice` when an arrival or departure delay entry was last updated more than 6 hours earlier, since the FAA feed can keep a delay entry after it lapses
- FAA-authored text (reasons, NOTAMs, comments, announcements, advisory text) is flattened, quoted, or fenced in `content[]` so it reads as data, and stays verbatim in `structuredContent`

Limitations:

- **Informational, not operational.** Not an operational source for flight planning: no substitute for an official preflight briefing or airline operations data.
- **Undocumented upstream.** `nasstatus.faa.gov/api/*` is the dashboard's private backend: no schema, terms, versioning, or published limits, and it can change without notice. The server fails with `feed_contract_changed` rather than guess.
- **Airport coverage is event-driven.** The feed lists only airports with an active event, so runway configuration and arrival rate are unavailable for airports without one, and `no_active_events` means no FAA program, not on-time flights. Per-flight EDCTs are not in the feed.
- **En-route row shape is inferred, not observed.** Airspace Flow Program rows follow the shape the NAS Status dashboard's own code reads; a mismatch degrades the national list with `enRouteFeed: "format_changed"` rather than failing it.
- **The airport directory is a snapshot.** An identifier the FAA assigns after the bundled NASR cycle is rejected as unknown until the next refresh. US airports only.

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "faa-traffic-delays-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/faa-traffic-delays-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "faa-traffic-delays-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/faa-traffic-delays-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "faa-traffic-delays-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/faa-traffic-delays-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: the FAA feeds are public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/faa-traffic-delays-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd faa-traffic-delays-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# every variable has a default; edit .env only to change transport, logging, or telemetry
```

## Configuration

The server reads no environment variables of its own: the FAA hosts, cache lifetimes, and request pacing are fixed in the services. These framework variables cover transport, logging, and telemetry.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

- **Refresh the airport directory** from the current FAA NASR cycle (needs network access and the system `unzip`):
  ```sh
  bun run refresh:airports
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), plus shared output schemas, notice fragments, and Markdown helpers for FAA-authored text. |
| `src/services/nas-status` | NAS Status feed client and tolerant feed parsers. |
| `src/services/advisory` | ATCSCC advisories database client, page parser, and advisory URL builder. |
| `src/services/airport-directory` | Bundled FAA NASR airport directory and ICAO → FAA crosswalk (generated module). |
| `src/services/upstream` | Shared FAA fetch boundary (pacing, retry, status classification) and the in-process cache. |
| `scripts/refresh-airport-directory.ts` | Regenerates the airport directory module (`bun run refresh:airports`). |
| `tests/` | Unit and integration tests, mirroring the `src/` structure, with synthetic FAA fixtures. |
| `docs/design.md` | Tool surface design, upstream API notes, design decisions, and known limitations. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging; FAA feeds are cached in process, not in `ctx.state`
- Register new tools in `allToolDefinitions` in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

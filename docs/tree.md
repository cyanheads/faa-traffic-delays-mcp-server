# faa-traffic-delays-mcp-server - Directory Structure

Generated on: 2026-10-01 03:05:02

```text
faa-traffic-delays-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── refresh-airport-directory.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-advisory.tool.ts
│   │       │   ├── get-airport-status.tool.ts
│   │       │   ├── get-operations-plan.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-active-events.tool.ts
│   │       │   └── list-reference.tool.ts
│   │       ├── format-helpers.ts
│   │       ├── notices.ts
│   │       └── schemas.ts
│   ├── services/
│   │   ├── advisory/
│   │   │   ├── advisory-ref.ts
│   │   │   └── advisory-service.ts
│   │   ├── airport-directory/
│   │   │   ├── airport-directory.ts
│   │   │   └── nasr-airports.generated.ts
│   │   ├── nas-status/
│   │   │   ├── feed-parsers.ts
│   │   │   ├── nas-status-service.ts
│   │   │   └── types.ts
│   │   └── upstream/
│   │       ├── faa-http-client.ts
│   │       └── ttl-cache.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── advisory-error.page
│   │   ├── advisory-gdp.page
│   │   ├── advisory-miss.page
│   │   ├── advisory-ops-plan.page
│   │   ├── airport-events.json
│   │   ├── enroute-events.json
│   │   ├── miscellaneous-info.json
│   │   ├── operations-plan.json
│   │   └── pacing-airports.json
│   ├── helpers/
│   │   ├── faa-fakes.ts
│   │   └── feed-failures.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── format-helpers.test.ts
│   │       ├── get-advisory.tool.test.ts
│   │       ├── get-airport-status.tool.test.ts
│   │       ├── get-operations-plan.tool.test.ts
│   │       ├── list-active-events.tool.test.ts
│   │       └── list-reference.tool.test.ts
│   ├── scripts/
│   │   └── refresh-airport-directory.test.ts
│   ├── services/
│   │   ├── advisory/
│   │   │   ├── advisory-ref.test.ts
│   │   │   └── advisory-service.test.ts
│   │   ├── airport-directory/
│   │   │   └── airport-directory.test.ts
│   │   ├── nas-status/
│   │   │   ├── feed-parsers.test.ts
│   │   │   └── nas-status-service.test.ts
│   │   └── upstream/
│   │       ├── faa-http-client.test.ts
│   │       └── ttl-cache.test.ts
│   └── smoke/
│       └── definitions.smoke.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

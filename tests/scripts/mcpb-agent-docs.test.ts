/**
 * @fileoverview Tests for the agent-doc matcher shared by scripts/clean-mcpb.ts (the bundle
 * strip step) and scripts/lint-packaging.ts (the post-bundle check): agent docs at a dependency's
 * package root are stripped, while the MCP SDK's runtime `dist/ext/skills/` modules and the
 * server's own root `skills/` survive. lint-packaging.ts is loaded by URL at run time — it carries
 * a fallback import of a module that exists only in the framework's own repository, which `tsc`
 * would otherwise try to resolve.
 * @module tests/scripts/mcpb-agent-docs.test
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

const ROOT = path.resolve(import.meta.dirname, '../..');

let lintPackaging: LintPackagingModule;

beforeAll(async () => {
  lintPackaging = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);
});

/** Runtime entries of the installed MCP SDK packages' `dist/ext/skills/` directories, read from disk. */
function installedSdkSkillModules(): string[] {
  return ['@modelcontextprotocol/server', '@modelcontextprotocol/core'].flatMap((pkg) => {
    const dir = `node_modules/${pkg}/dist/ext/skills`;
    return readdirSync(path.join(ROOT, dir)).map((file) => `${dir}/${file}`);
  });
}

const KEPT = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/skills/index.js',
  'node_modules/@cyanheads/mcp-ts-core/dist/index.js',
  'skills/faa-guide/SKILL.md',
  'dist/index.js',
];

const STRIPPED = [
  'node_modules/some-pkg/skills/',
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/some-pkg/skills/guide/references/codes.md',
  'node_modules/some-pkg/SKILL.md',
  'node_modules/some-pkg/docs/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/some-pkg/.claude/skills/guide/SKILL.md',
  'node_modules/some-pkg/.agents/notes.md',
  'node_modules/a/node_modules/b/skills/guide/SKILL.md',
  'node_modules/a/node_modules/@scope/b/framework-skills/x/references/y.md',
];

describe('agent-doc matcher', () => {
  it('is the same pattern in clean-mcpb.ts and lint-packaging.ts', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('keeps runtime skills/ modules nested inside a package, and the root skills/ tree', () => {
    expect(filterAgentDocEntries(KEPT)).toEqual([]);
  });

  it('keeps every installed MCP SDK dist/ext/skills/ module', () => {
    const modules = installedSdkSkillModules();
    expect(modules).toContain(
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    );
    expect(modules).toContain('node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs');
    expect(filterAgentDocEntries(modules)).toEqual([]);
    expect(lintPackaging.checkBundleEntries(modules, 'dist/test.mcpb')).toEqual([]);
  });

  it('strips agent-doc trees at a package root and SKILL.md anywhere in a package', () => {
    expect(filterAgentDocEntries(STRIPPED)).toEqual(STRIPPED);
  });

  it('reports bundled agent docs from lint-packaging and nothing for the kept entries', () => {
    expect(lintPackaging.checkBundleEntries(KEPT, 'dist/test.mcpb')).toEqual([]);
    const [error, ...rest] = lintPackaging.checkBundleEntries(
      [...KEPT, ...STRIPPED],
      'dist/test.mcpb',
    );
    expect(rest).toEqual([]);
    expect(error).toContain(
      `dist/test.mcpb contains ${STRIPPED.length} node_modules agent-doc entries`,
    );
  });
});

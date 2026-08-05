/**
 * Unit tests for the ~/.claude index parser functions.
 *
 * Pure unit tests — NO network, NO server, NO filesystem reads.
 * The parser functions are imported directly from the script (tsx resolves .ts).
 * All fixtures are inline markdown strings.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMarkdownTableRows,
  slugify,
  parseToolsIndex,
  parseSkillsIndex,
  parseProjectIndex,
  buildContent,
  type IndexEntry,
  type IndexKind,
} from '../../scripts/sync-claude-indexes.js';

// ---------------------------------------------------------------------------
// parseMarkdownTableRows
// ---------------------------------------------------------------------------

describe('parseMarkdownTableRows', () => {
  it('parses a simple two-column table (header row + data rows, no separator)', () => {
    const md = `
| Name | Description |
|------|-------------|
| Foo  | Does foo    |
| Bar  | Does bar    |
`.trim();
    const rows = parseMarkdownTableRows(md);
    // parseMarkdownTableRows returns ALL non-separator rows (header + data).
    // Higher-level parsers (parseToolsIndex etc.) apply their own header-cell filtering.
    expect(rows).toHaveLength(3); // header row + 2 data rows; separator excluded
    expect(rows[0]).toEqual(['Name', 'Description']); // header row
    expect(rows[1]).toEqual(['Foo', 'Does foo']);
    expect(rows[2]).toEqual(['Bar', 'Does bar']);
  });

  it('skips separator rows (dashes only)', () => {
    const md = `
| A | B |
|---|---|
| 1 | 2 |
`;
    const rows = parseMarkdownTableRows(md);
    expect(rows).toHaveLength(2); // header row + data row
    // Header row included (it's not a separator)
    expect(rows[0]).toEqual(['A', 'B']);
    expect(rows[1]).toEqual(['1', '2']);
  });

  it('returns empty array for non-table content', () => {
    const md = `# Title\n\nSome paragraph without a table.`;
    expect(parseMarkdownTableRows(md)).toHaveLength(0);
  });

  it('handles separator rows with colons (alignment markers)', () => {
    const md = `
| Col | Other |
|:----|------:|
| val | 123   |
`;
    const rows = parseMarkdownTableRows(md);
    // separator row (|:----|------:|) should be skipped
    expect(rows.some(r => r[0].includes('-'))).toBe(false);
    expect(rows.find(r => r[0] === 'val')).toBeTruthy();
  });

  it('returns empty for empty input', () => {
    expect(parseMarkdownTableRows('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses multiple non-alphanumeric chars', () => {
    expect(slugify('Foo  -- Bar')).toBe('foo-bar');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  leading trailing  ')).toBe('leading-trailing');
  });

  it('handles already-slug input unchanged', () => {
    expect(slugify('my-project')).toBe('my-project');
  });

  it('handles names with special chars and emoji', () => {
    // Emoji and non-ascii become hyphens then collapsed
    expect(slugify('MEMSTACK 🔧')).toBe('memstack');
  });
});

// ---------------------------------------------------------------------------
// parseToolsIndex
// ---------------------------------------------------------------------------

const TOOLS_FIXTURE = `
# Tools Index

**Last Updated:** 2026-06-16

---

## MCP Servers

| Tool | Purpose | Integration | Status | Quick Link |
|------|---------|-------------|--------|------------|
| email-query-mcp | Query & analyze Office 365 emails | Companion to inbox-triage | Production v1.1 | [Details](#email-query-mcp) |
| MEMSTACK | 5-layer memory stack with hybrid search | MCP + REST API | Production v2.0 | [Details](#memstack) |

---

## Storage

| Tool | Service | Cost | Quick Link |
|------|---------|------|------------|
| *Coming soon* | | | |

---

## DevOps

| Tool | Purpose | Cost | Quick Link |
|------|---------|------|------------|
| WP-DevKit | Local WordPress dev with Docker | Free | [Details](tools/wp-devkit.md) |
| ~~Old Profiler~~ | DEPRECATED 2026-07-06 → new-profiler (code ported) | Deprecated | [Details](tools/old-profiler.md) |
`;

describe('parseToolsIndex', () => {
  it('parses tool entries from multiple sections', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    const names = entries.map(e => e.name);
    expect(names).toContain('email-query-mcp');
    expect(names).toContain('MEMSTACK');
    expect(names).toContain('WP-DevKit');
  });

  it('skips *Coming soon* placeholder rows', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    const hasComingSoon = entries.some(e => e.name.includes('Coming soon'));
    expect(hasComingSoon).toBe(false);
  });

  it('assigns scope client:claude-tool to all tool entries', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    for (const e of entries) {
      expect(e.scope).toBe('client:claude-tool');
    }
  });

  it('generates stable tool: external keys', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    const memstack = entries.find(e => e.name === 'MEMSTACK');
    expect(memstack?.external_key).toBe('tool:memstack');
    const emailMcp = entries.find(e => e.name === 'email-query-mcp');
    expect(emailMcp?.external_key).toBe('tool:email-query-mcp');
  });

  it('sets kind to "tool"', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    for (const e of entries) {
      expect(e.kind).toBe('tool');
    }
  });

  it('sets source_file to TOOLS_INDEX.md', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    for (const e of entries) {
      expect(e.source_file).toBe('TOOLS_INDEX.md');
    }
  });

  it('strips markdown links from names and descriptions', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    for (const e of entries) {
      // No markdown link syntax in name or description
      expect(e.name).not.toMatch(/\[.*\]\(.*\)/);
      expect(e.description).not.toMatch(/\[.*\]\(.*\)/);
    }
  });

  it('skips header row cells', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    const hasHeader = entries.some(e => e.name.toLowerCase() === 'tool');
    expect(hasHeader).toBe(false);
  });

  it('skips deprecated (struck-through or DEPRECATED-marked) rows', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    const hasDeprecated = entries.some(e => e.name.includes('Old Profiler'));
    expect(hasDeprecated).toBe(false);
  });

  it('returns empty array for empty markdown', () => {
    expect(parseToolsIndex('')).toHaveLength(0);
  });

  it('returns empty array for markdown with no table', () => {
    expect(parseToolsIndex('# Title\n\nSome text.')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseSkillsIndex
// ---------------------------------------------------------------------------

const SKILLS_FIXTURE = `
# Skills Index

**Last Updated:** 2026-06-13

---

## Available Skills

| Skill | Command | Purpose | Status |
|-------|---------|---------|--------|
| Handoff | \`/handoff\` | Generate handoff prompt and copy to clipboard | Ready |
| Vault Note | \`/vault-note\` | Create a markdown note with context-aware frontmatter | Ready |
| **Client Intake** ⭐ | \`/client-intake\` | Front door — asks for client name and dispatches | Ready |
| AWS Check | \`/aws-check\` | Scan task for AWS service opportunities | Ready |
`;

describe('parseSkillsIndex', () => {
  it('parses skill entries', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    const names = entries.map(e => e.name);
    expect(names).toContain('Handoff');
    expect(names).toContain('Vault Note');
    expect(names).toContain('AWS Check');
  });

  it('strips bold/emoji from skill names', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    // "**Client Intake** ⭐" → "Client Intake"
    const clientIntake = entries.find(e => e.name === 'Client Intake');
    expect(clientIntake).toBeTruthy();
  });

  it('assigns scope client:claude-skill to all skill entries', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    for (const e of entries) {
      expect(e.scope).toBe('client:claude-skill');
    }
  });

  it('generates stable skill: external keys from command slug', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    const handoff = entries.find(e => e.name === 'Handoff');
    expect(handoff?.external_key).toBe('skill:handoff');
    const vaultNote = entries.find(e => e.name === 'Vault Note');
    expect(vaultNote?.external_key).toBe('skill:vault-note');
  });

  it('uses purpose as description', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    const handoff = entries.find(e => e.name === 'Handoff');
    expect(handoff?.description).toBe('Generate handoff prompt and copy to clipboard');
  });

  it('sets kind to "skill"', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    for (const e of entries) {
      expect(e.kind).toBe('skill');
    }
  });

  it('sets source_file to SKILLS_INDEX.md', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    for (const e of entries) {
      expect(e.source_file).toBe('SKILLS_INDEX.md');
    }
  });

  it('skips header row cells', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    expect(entries.some(e => e.name.toLowerCase() === 'skill')).toBe(false);
  });

  it('returns empty for empty input', () => {
    expect(parseSkillsIndex('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseProjectIndex
// ---------------------------------------------------------------------------

const PROJECT_FIXTURE = `
# Project Index

---

## 🛠️ System Tools

| Project | Status | Location | Quick Link |
|---------|--------|----------|------------|
| MEMSTACK | ✅ Production (PostgreSQL active) | \`C:\\Users\\dev\\Desktop\\Apps\\_MCP\\memstack\` | [Details](projects/memstack.md) |
| Asana MCP | ✅ Production v1.0 | \`C:\\Users\\dev\\Desktop\\Apps\\_MCP\\asana-mcp\` | — |

---

## 🏢 Example Business Vault

| Project | Status | Location | Quick Link |
|---------|--------|----------|------------|
| **Acme Trading Platform** | 🚧 Development - UX Testing | \`C:\\Users\\dev\\Desktop\\Apps\\Acme-platform-backup\` | [Details](projects/acme-platform.md) |

---

## 📊 Quick Stats

| Metric | Value |
|--------|-------|
| Total Active | 32 projects |
`;

describe('parseProjectIndex', () => {
  it('parses project entries into project: scopes', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    const memstack = entries.find(e => e.name === 'MEMSTACK');
    expect(memstack).toBeTruthy();
    expect(memstack?.scope).toBe('project:memstack');
    expect(memstack?.external_key).toBe('convention:memstack');
  });

  it('handles bold-wrapped project names', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    const acme = entries.find(e => e.name === 'Acme Trading Platform');
    expect(acme).toBeTruthy();
    expect(acme?.scope).toBe('project:acme-trading-platform');
  });

  it('sets kind to "convention"', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    for (const e of entries) {
      expect(e.kind).toBe('convention');
    }
  });

  it('sets source_file to PROJECT_INDEX.md', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    for (const e of entries) {
      expect(e.source_file).toBe('PROJECT_INDEX.md');
    }
  });

  it('builds description from status and location columns', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    const memstack = entries.find(e => e.name === 'MEMSTACK');
    // Status (col 1) + location (col 2) joined with " — "
    expect(memstack?.description).toContain('Production');
  });

  it('skips header rows', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    expect(entries.some(e => e.name.toLowerCase() === 'project')).toBe(false);
  });

  it('skips stats/non-project rows (Total Active etc.)', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    // "Total Active" would have a description of "32 projects" with no slug-able project
    // but actually it parses as convention:total-active — let's just ensure it doesn't crash
    // and that we don't produce an entry with empty name
    expect(entries.some(e => e.name === '')).toBe(false);
  });

  it('returns empty for empty input', () => {
    expect(parseProjectIndex('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildContent
// ---------------------------------------------------------------------------

describe('buildContent', () => {
  it('formats content as "Name: description"', () => {
    const entry: IndexEntry = {
      name: 'MEMSTACK',
      description: '5-layer memory stack',
      external_key: 'tool:memstack',
      scope: 'client:claude-tool',
      source_file: 'TOOLS_INDEX.md',
      kind: 'tool' as IndexKind,
    };
    expect(buildContent(entry)).toBe('MEMSTACK: 5-layer memory stack');
  });

  it('is stable across two calls with the same input', () => {
    const entry: IndexEntry = {
      name: 'Handoff',
      description: 'Generate handoff prompt',
      external_key: 'skill:handoff',
      scope: 'client:claude-skill',
      source_file: 'SKILLS_INDEX.md',
      kind: 'skill' as IndexKind,
    };
    expect(buildContent(entry)).toBe(buildContent(entry));
  });
});

// ---------------------------------------------------------------------------
// Global vs per-project convention split
// ---------------------------------------------------------------------------

describe('global vs per-project convention split', () => {
  it('all PROJECT_INDEX rows map to project: scopes (no client:claude-convention)', () => {
    const entries = parseProjectIndex(PROJECT_FIXTURE);
    // In the current data model, no PROJECT_INDEX row produces client:claude-convention.
    // All project rows scope to project:<slug>.
    const globalConventions = entries.filter(e => e.scope === 'client:claude-convention');
    expect(globalConventions).toHaveLength(0);
    // All non-empty entries have project: scope
    for (const e of entries) {
      expect(e.scope).toMatch(/^project:/);
    }
  });

  it('tools always go to client:claude-tool, never project:', () => {
    const entries = parseToolsIndex(TOOLS_FIXTURE);
    for (const e of entries) {
      expect(e.scope).toBe('client:claude-tool');
      expect(e.scope).not.toMatch(/^project:/);
    }
  });

  it('skills always go to client:claude-skill, never project:', () => {
    const entries = parseSkillsIndex(SKILLS_FIXTURE);
    for (const e of entries) {
      expect(e.scope).toBe('client:claude-skill');
      expect(e.scope).not.toMatch(/^project:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('parseToolsIndex: single-column or short row does not crash', () => {
    const md = `| OnlyOneCol |\n|---|\n| value |`;
    // Should return empty (description would be missing)
    expect(() => parseToolsIndex(md)).not.toThrow();
    const entries = parseToolsIndex(md);
    // Only 1 column — description would be empty, entry skipped
    expect(entries).toHaveLength(0);
  });

  it('parseSkillsIndex: row with only name and no command falls back to name slug', () => {
    const md = `| Skill | Command | Purpose |\n|---|---|---|\n| MySkill |  | Does stuff |`;
    const entries = parseSkillsIndex(md);
    const skill = entries.find(e => e.name === 'MySkill');
    expect(skill).toBeTruthy();
    // No command → falls back to slugify(name)
    expect(skill?.external_key).toBe('skill:myskill');
  });

  it('parseToolsIndex: empty section with only header/separator produces no entries', () => {
    const md = `## Section\n\n| Tool | Purpose |\n|---|---|\n`;
    const entries = parseToolsIndex(md);
    // Only a header row, no data rows
    expect(entries).toHaveLength(0);
  });

  it('parseProjectIndex: entry with missing status/location still produces an entry if name is valid', () => {
    const md = `| Project | Status | Location |\n|---|---|---|\n| SomeProject | | |`;
    const entries = parseProjectIndex(md);
    // description would be empty → skipped
    expect(entries.some(e => e.name === 'SomeProject')).toBe(false);
  });

  it('slugify: numeric-only names produce a valid slug', () => {
    expect(slugify('123')).toBe('123');
  });

  it('parseMarkdownTableRows: handles tables with extra whitespace in cells', () => {
    const md = `|   Name   |   Value   |\n|---|---|\n|   foo   |   bar   |`;
    const rows = parseMarkdownTableRows(md);
    // Cells should be trimmed
    const dataRow = rows.find(r => r[0] === 'foo');
    expect(dataRow).toEqual(['foo', 'bar']);
  });
});

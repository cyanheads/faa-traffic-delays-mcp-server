/**
 * @fileoverview Tests for scripts/refresh-airport-directory.ts, run as a subprocess against a
 * temp copy of the script (so its output path lands in the temp tree, never in `src/`) with a
 * stubbed pacing-airports fetch and a synthetic APT_CSV.zip built from generated rows: CSV
 * parsing (quotes, doubled quotes, embedded newlines, CRLF, latin-1), row filtering, module
 * rendering and escaping, and every guard that must refuse to write.
 * @module tests/scripts/refresh-airport-directory.test
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_SOURCE = path.resolve(
  import.meta.dirname,
  '../../scripts/refresh-airport-directory.ts',
);
const tools = ['bun', 'zip', 'unzip'].every(
  (tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).error === undefined,
);

const HEADER = [
  'EFF_DATE',
  'SITE_NO',
  'ARPT_ID',
  'ICAO_ID',
  'ARPT_NAME',
  'CITY',
  'STATE_CODE',
  'COUNTRY_CODE',
];

interface Airport {
  city?: string;
  country?: string;
  effDate?: string;
  icao?: string;
  id: string;
  name?: string;
  state?: string;
}

const csvField = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function csvRow(airport: Airport): string {
  return [
    airport.effDate ?? '2026/09/03',
    '1',
    airport.id,
    airport.icao ?? '',
    airport.name ?? `Airport ${airport.id}`,
    airport.city ?? 'CITY',
    airport.state ?? 'WA',
    airport.country ?? 'US',
  ]
    .map(csvField)
    .join(',');
}

/** `count` unique synthetic US airports, ids `000`, `001`, … */
const bulk = (count: number): Airport[] =>
  Array.from({ length: count }, (_, i) => ({ id: i.toString(36).toUpperCase().padStart(3, '0') }));

let root: string;
let script: string;
let stub: string;
let output: string;

interface Result {
  module?: string;
  status: number | null;
  stderr: string;
  stdout: string;
}

function runScript(options: {
  airports: Airport[];
  eol?: string;
  header?: string[];
  pacing?: string[] | { body: string; status?: number };
  zipArgs?: string[];
}): Result {
  const workDir = mkdtempSync(path.join(root, 'work-'));
  const csvPath = path.join(workDir, 'APT_BASE.csv');
  const eol = options.eol ?? '\n';
  const lines = [(options.header ?? HEADER).join(','), ...options.airports.map(csvRow)];
  writeFileSync(csvPath, Buffer.from(`${lines.join(eol)}${eol}`, 'latin1'));
  const zipPath = path.join(workDir, 'APT_CSV.zip');
  expect(spawnSync('zip', ['-q', '-j', zipPath, csvPath]).status).toBe(0);

  const pacing = options.pacing ?? ['SEA'];
  const body = Array.isArray(pacing)
    ? JSON.stringify(pacing.map((airportId) => ({ airportId })))
    : pacing.body;
  const status = Array.isArray(pacing) ? 200 : (pacing.status ?? 200);
  const result = spawnSync(
    'bun',
    ['--preload', stub, script, ...(options.zipArgs ?? ['--zip', zipPath])],
    {
      encoding: 'utf8',
      env: { ...process.env, PACING_BODY: body, PACING_STATUS: String(status) },
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    ...(existsSync(output) && { module: readFileSync(output, 'utf8') }),
  };
}

/** Evaluates the generated module's two exports. */
function evaluate(moduleText: string): { effectiveDate: string; tsv: string } {
  const body = moduleText.replaceAll('export const', 'const');
  const load = new Function(
    `${body}; return { effectiveDate: NASR_EFFECTIVE_DATE, tsv: NASR_AIRPORTS_TSV };`,
  );
  return load() as { effectiveDate: string; tsv: string };
}

const SEATTLE: Airport = {
  city: 'SEATTLE',
  icao: 'KSEA',
  id: 'SEA',
  name: 'Seattle-Tacoma Intl',
  state: 'WA',
};

describe.skipIf(!tools)('refresh-airport-directory script', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'refresh-airports-'));
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'src/services/airport-directory'), { recursive: true });
    script = path.join(root, 'scripts/refresh-airport-directory.ts');
    copyFileSync(SCRIPT_SOURCE, script);
    output = path.join(root, 'src/services/airport-directory/nasr-airports.generated.ts');
    stub = path.join(root, 'stub-fetch.ts');
    writeFileSync(
      stub,
      `globalThis.fetch = async (url) => {
  if (String(url).includes('pacing-airports')) {
    return new Response(process.env.PACING_BODY, { status: Number(process.env.PACING_STATUS) });
  }
  throw new Error('unexpected network access: ' + url);
};\n`,
    );
  });

  beforeEach(() => {
    rmSync(output, { force: true });
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  describe('writing the module', () => {
    const airports: Airport[] = [
      SEATTLE,
      {
        city: 'ANCHORAGE',
        icao: 'PANC',
        id: 'ANC',
        name: 'Ted Stevens Anchorage Intl',
        state: 'AK',
      },
      { id: 'A00', name: 'Comma, "Quoted" Field', state: 'OR' },
      { id: 'A01', name: 'Line one\nLine two\tTabbed' },
      { id: 'A02', name: 'Café Field' },
      { id: 'A03', name: 'Back`tick $' + '{not} \\slash' },
      { country: 'CA', icao: 'CYVR', id: 'YVR', name: 'Vancouver' },
      { id: 'K0S9X', name: 'Four-plus character id' },
      { id: 'AB', name: 'Two character id' },
      ...bulk(5_000),
    ];

    it('writes a sorted, US-only, 3-character-id table and reports the count', () => {
      const result = runScript({ airports });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(
        /Wrote 5\d{3} airports \(2 with ICAO codes\), NASR cycle 2026-09-03/,
      );
      const { effectiveDate, tsv } = evaluate(result.module as string);
      const rows = tsv.split('\n').map((line) => line.split('\t'));

      expect(effectiveDate).toBe('2026-09-03');
      const ids = rows.map((row) => row[0] as string);
      expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
      expect(ids).toContain('SEA');
      expect(ids).not.toContain('YVR');
      expect(ids).not.toContain('K0S9X');
      expect(ids).not.toContain('AB');
      expect(rows.every((row) => row.length === 5)).toBe(true);
      expect(rows.find((row) => row[0] === 'SEA')).toEqual([
        'SEA',
        'KSEA',
        'Seattle-Tacoma Intl',
        'SEATTLE',
        'WA',
      ]);
      expect(rows.find((row) => row[0] === 'ANC')?.[1]).toBe('PANC');
    });

    it('parses quoted commas, doubled quotes, embedded newlines, and latin-1 bytes', () => {
      const { tsv } = evaluate(runScript({ airports }).module as string);
      const byId = new Map(tsv.split('\n').map((line) => [line.split('\t')[0], line.split('\t')]));

      expect(byId.get('A00')?.[2]).toBe('Comma, "Quoted" Field');
      expect(byId.get('A01')?.[2]).toBe('Line one Line two Tabbed');
      expect(byId.get('A02')?.[2]).toBe('Café Field');
    });

    it('escapes backslashes, backticks, and template placeholders so the module round-trips', () => {
      const result = runScript({ airports });
      const { tsv } = evaluate(result.module as string);

      expect(
        tsv
          .split('\n')
          .find((line) => line.startsWith('A03\t'))
          ?.split('\t')[2],
      ).toBe('Back`tick $' + '{not} \\slash');
    });

    it('accepts CRLF line endings', () => {
      const result = runScript({ airports, eol: '\r\n' });

      expect(result.status, result.stderr).toBe(0);
      const { tsv } = evaluate(result.module as string);
      expect(tsv.split('\n').find((line) => line.startsWith('SEA\t'))).toBe(
        'SEA\tKSEA\tSeattle-Tacoma Intl\tSEATTLE\tWA',
      );
    });

    it('ships a header that says the module is generated', () => {
      const module = runScript({ airports }).module as string;
      expect(module).toContain('do not edit by hand');
      expect(module).toContain('cycle 2026-09-03');
    });
  });

  describe('guards: refuse to write', () => {
    const refused = (result: Result, message: string | RegExp): void => {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(message);
      expect(result.module).toBeUndefined();
    };

    it('a table under 5,000 rows', () => {
      refused(
        runScript({ airports: [SEATTLE, { id: 'AAA' }] }),
        /Only 2 airports parsed \(minimum 5000\); not writing/,
      );
    });

    it('a pacing airport missing from the table', () => {
      refused(
        runScript({ airports: [SEATTLE, ...bulk(5_000)], pacing: ['SEA', 'ZZZ', 'QQQ'] }),
        /Pacing airports missing from the table: ZZZ, QQQ/,
      );
    });

    it('a pacing list that is not an array', () => {
      refused(
        runScript({ airports: [SEATTLE, ...bulk(5_000)], pacing: { body: '{"error":"x"}' } }),
        /pacing-airports did not return an array/,
      );
    });

    it('a pacing list with no identifiers', () => {
      refused(
        runScript({
          airports: [SEATTLE, ...bulk(5_000)],
          pacing: { body: '[{"timezone":"US/Pacific"}]' },
        }),
        /pacing-airports returned no airport identifiers/,
      );
    });

    it('a failing pacing request', () => {
      refused(
        runScript({ airports: [SEATTLE, ...bulk(5_000)], pacing: { body: 'down', status: 503 } }),
        /pacing-airports returned HTTP 503/,
      );
    });

    it('a duplicate ARPT_ID', () => {
      refused(
        runScript({ airports: [SEATTLE, { ...SEATTLE, icao: '' }] }),
        /Duplicate ARPT_ID SEA/,
      );
    });

    it('an ICAO code assigned to two airports', () => {
      refused(
        runScript({ airports: [SEATTLE, { icao: 'KSEA', id: 'BFI' }] }),
        /ICAO_ID KSEA is assigned to both SEA and BFI/,
      );
    });

    it('an ICAO code that collides with a 3-character identifier', () => {
      refused(
        runScript({ airports: [{ icao: 'ABC', id: 'SEA' }, { id: 'ABC' }] }),
        /ICAO_ID ABC \(of SEA\) collides with a 3-character identifier/,
      );
    });

    it('more than one EFF_DATE', () => {
      refused(
        runScript({ airports: [SEATTLE, { effDate: '2026/10/01', id: 'BFI' }] }),
        /Expected one EFF_DATE, found 2026\/09\/03, 2026\/10\/01/,
      );
    });

    it('no US rows at all', () => {
      refused(
        runScript({ airports: [{ country: 'CA', id: 'YVR' }] }),
        /Expected one EFF_DATE, found none/,
      );
    });

    it('an EFF_DATE in an unrecognized format', () => {
      refused(
        runScript({ airports: [{ effDate: '03-Sep-2026', id: 'SEA' }] }),
        /Unrecognized EFF_DATE 03-Sep-2026/,
      );
    });

    it.each(['ARPT_ID', 'ICAO_ID', 'COUNTRY_CODE', 'EFF_DATE', 'CITY'])(
      'a missing %s column',
      (column) => {
        const header = HEADER.map((name) => (name === column ? `RENAMED_${name}` : name));
        refused(
          runScript({ airports: [SEATTLE], header }),
          new RegExp(`APT_BASE.csv has no ${column} column`),
        );
      },
    );

    it('a --zip flag with no path', () => {
      refused(
        runScript({ airports: [SEATTLE], zipArgs: ['--zip'] }),
        /--zip needs a path to an APT_CSV.zip/,
      );
    });
  });

  it('counts facilities and reads an ICAO-less airport as an empty ICAO field', () => {
    const result = runScript({ airports: [{ id: 'AAA' }, ...bulk(5_000).slice(1), SEATTLE] });
    const { tsv } = evaluate(result.module as string);

    expect(result.status, result.stderr).toBe(0);
    expect(
      tsv
        .split('\n')
        .find((line) => line.startsWith('AAA\t'))
        ?.split('\t')[1],
    ).toBe('');
  });
});

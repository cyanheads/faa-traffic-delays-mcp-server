/**
 * @fileoverview Regenerates `src/services/airport-directory/nasr-airports.generated.ts` from the
 * FAA NASR 28-day subscription. Picks the newest cycle already in effect, downloads that cycle's
 * `APT_CSV.zip` with GET (the host answers HEAD with 503), extracts `APT_BASE.csv` with the system
 * `unzip`, keeps US rows with a 3-character location identifier, and writes the module sorted by
 * identifier. Refuses to write a table under 5,000 rows or one missing any FAA pacing airport.
 *
 * Usage: `bun run refresh:airports` (live), or `bun run refresh:airports -- --zip <path>` to read an
 * already-downloaded `APT_CSV.zip`.
 * @module scripts/refresh-airport-directory
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const INDEX_URL =
  'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const ZIP_BASE_URL = 'https://nfdc.faa.gov/webContent/28DaySub/extra/';
const PACING_URL = 'https://nasstatus.faa.gov/api/pacing-airports';
const OUTPUT_PATH = path.resolve(
  import.meta.dirname,
  '../src/services/airport-directory/nasr-airports.generated.ts',
);
const MIN_ROWS = 5000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const USER_AGENT = 'faa-traffic-delays-mcp-server/refresh-airport-directory';

interface AirportRow {
  city: string;
  faaId: string;
  icaoId: string;
  name: string;
  state: string;
}

/** Picks the newest `YYYY-MM-DD` cycle on the index page that is on or before today (UTC). */
async function resolveCurrentCycle(): Promise<string> {
  const res = await fetch(INDEX_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status !== 200) throw new Error(`NASR index returned HTTP ${res.status}`);
  const html = await res.text();
  const today = new Date().toISOString().slice(0, 10);
  const cycles = [...html.matchAll(/NASR_Subscription\/(\d{4}-\d{2}-\d{2})/g)]
    .map((m) => m[1] as string)
    .filter((date) => date <= today)
    .sort();
  const current = cycles.at(-1);
  if (!current) throw new Error('NASR index lists no cycle on or before today');
  return current;
}

/** `2026-09-03` → `03_Sep_2026_APT_CSV.zip`. */
function zipNameForCycle(cycle: string): string {
  const [year, month, day] = cycle.split('-');
  const monthName = MONTHS[Number(month) - 1];
  if (!year || !day || !monthName) throw new Error(`Unrecognized cycle date: ${cycle}`);
  return `${day}_${monthName}_${year}_APT_CSV.zip`;
}

async function downloadZip(cycle: string, dir: string): Promise<string> {
  const url = `${ZIP_BASE_URL}${zipNameForCycle(cycle)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status !== 200) throw new Error(`NASR download ${url} returned HTTP ${res.status}`);
  const zipPath = path.join(dir, 'APT_CSV.zip');
  await writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  return zipPath;
}

/** Extracts `APT_BASE.csv` with the system `unzip` and decodes it as latin-1. */
function readAptBase(zipPath: string): string {
  const result = spawnSync('unzip', ['-p', zipPath, 'APT_BASE.csv'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`unzip failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`unzip exited ${result.status}: ${result.stderr.toString('utf8').trim()}`);
  }
  return new TextDecoder('latin1').decode(result.stdout);
}

/** RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF or LF line ends. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Collapses whitespace so no field can break the TSV layout. */
function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function extractAirports(csv: string): { effectiveDate: string; rows: AirportRow[] } {
  const [header, ...records] = parseCsv(csv);
  if (!header) throw new Error('APT_BASE.csv is empty');
  const col = (name: string): number => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`APT_BASE.csv has no ${name} column`);
    return index;
  };
  const cols = {
    city: col('CITY'),
    country: col('COUNTRY_CODE'),
    effDate: col('EFF_DATE'),
    faaId: col('ARPT_ID'),
    icaoId: col('ICAO_ID'),
    name: col('ARPT_NAME'),
    state: col('STATE_CODE'),
  };

  const effectiveDates = new Set<string>();
  const byFaa = new Map<string, AirportRow>();
  const icaoOwners = new Map<string, string>();
  for (const record of records) {
    if (record.length === 1 && record[0] === '') continue;
    const faaId = clean(record[cols.faaId]).toUpperCase();
    if (clean(record[cols.country]) !== 'US' || !/^[A-Z0-9]{3}$/.test(faaId)) continue;
    effectiveDates.add(clean(record[cols.effDate]));
    const icaoId = clean(record[cols.icaoId]).toUpperCase();
    if (byFaa.has(faaId)) throw new Error(`Duplicate ARPT_ID ${faaId}`);
    if (icaoId) {
      const owner = icaoOwners.get(icaoId);
      if (owner) throw new Error(`ICAO_ID ${icaoId} is assigned to both ${owner} and ${faaId}`);
      icaoOwners.set(icaoId, faaId);
    }
    byFaa.set(faaId, {
      city: clean(record[cols.city]),
      faaId,
      icaoId,
      name: clean(record[cols.name]),
      state: clean(record[cols.state]),
    });
  }

  for (const [icaoId, faaId] of icaoOwners) {
    if (byFaa.has(icaoId)) {
      throw new Error(`ICAO_ID ${icaoId} (of ${faaId}) collides with a 3-character identifier`);
    }
  }
  if (effectiveDates.size !== 1) {
    throw new Error(`Expected one EFF_DATE, found ${[...effectiveDates].join(', ') || 'none'}`);
  }
  const effectiveDate = [...effectiveDates][0]?.replaceAll('/', '-') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    throw new Error(`Unrecognized EFF_DATE ${effectiveDate}`);
  }
  const rows = [...byFaa.values()].sort((a, b) => a.faaId.localeCompare(b.faaId));
  return { effectiveDate, rows };
}

async function fetchPacingAirports(): Promise<string[]> {
  const res = await fetch(PACING_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status !== 200) throw new Error(`pacing-airports returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('pacing-airports did not return an array');
  const ids = body
    .map((row: unknown) =>
      row && typeof row === 'object' && 'airportId' in row ? row.airportId : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) throw new Error('pacing-airports returned no airport identifiers');
  return ids;
}

/** Escapes a TSV field for a template literal whose tabs are written as `\t`. */
function escapeForTemplate(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
}

function renderModule(effectiveDate: string, rows: AirportRow[]): string {
  const lines = rows.map((row) =>
    [row.faaId, row.icaoId, row.name, row.city, row.state].map(escapeForTemplate).join('\\t'),
  );
  return `/**
 * @fileoverview FAA NASR airport directory snapshot (APT_BASE.csv, cycle ${effectiveDate}).
 * Generated by scripts/refresh-airport-directory.ts — do not edit by hand; run
 * \`bun run refresh:airports\` to regenerate.
 * @module services/airport-directory/nasr-airports.generated
 */

/** NASR cycle effective date of this snapshot (YYYY-MM-DD). */
export const NASR_EFFECTIVE_DATE = '${effectiveDate}';

/**
 * One US airport per line, tab-separated: FAA identifier, ICAO code (empty when NASR assigns
 * none), airport name, city, state. Sorted by FAA identifier.
 */
export const NASR_AIRPORTS_TSV = \`${lines.join('\n')}\`;
`;
}

function readZipArg(): string | undefined {
  const index = process.argv.indexOf('--zip');
  if (index === -1) return;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--zip needs a path to an APT_CSV.zip');
  return path.resolve(value);
}

async function main(): Promise<void> {
  const localZip = readZipArg();
  const workDir = await mkdtemp(path.join(tmpdir(), 'nasr-apt-'));
  try {
    const cycle = localZip ? undefined : await resolveCurrentCycle();
    const zipPath = localZip ?? (await downloadZip(cycle as string, workDir));
    const { effectiveDate, rows } = extractAirports(readAptBase(zipPath));
    if (cycle && cycle !== effectiveDate) {
      throw new Error(`Cycle ${cycle} downloaded, but APT_BASE.csv says EFF_DATE ${effectiveDate}`);
    }
    if (rows.length < MIN_ROWS) {
      throw new Error(`Only ${rows.length} airports parsed (minimum ${MIN_ROWS}); not writing`);
    }
    const known = new Set(rows.map((row) => row.faaId));
    const missingPacing = (await fetchPacingAirports()).filter((id) => !known.has(id));
    if (missingPacing.length > 0) {
      throw new Error(`Pacing airports missing from the table: ${missingPacing.join(', ')}`);
    }
    await writeFile(OUTPUT_PATH, renderModule(effectiveDate, rows));
    const withIcao = rows.filter((row) => row.icaoId).length;
    process.stdout.write(
      `Wrote ${rows.length} airports (${withIcao} with ICAO codes), NASR cycle ${effectiveDate}, to ${path.relative(process.cwd(), OUTPUT_PATH)}\n`,
    );
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

await main();

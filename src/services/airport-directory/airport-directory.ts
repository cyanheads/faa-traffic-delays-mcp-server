/**
 * @fileoverview Bundled FAA NASR airport directory: identifier lookup (name, place, responsible
 * ARTCC, coordinates), the ICAO → FAA crosswalk, and the airport-code normalization behind every
 * airport input. Parsed once, on first use, from the generated TSV module; no network access.
 * @module services/airport-directory/airport-directory
 */

import { NASR_AIRPORTS_TSV, NASR_EFFECTIVE_DATE } from './nasr-airports.generated.js';

/** One US airport from the NASR directory. */
export interface DirectoryAirport {
  /** Responsible ARTCC (ZSE); absent when NASR gives none. */
  artcc?: string;
  city: string;
  faaId: string;
  icaoId?: string;
  /** Decimal degrees to 4 places; absent when NASR gives no usable value. */
  latitude?: number;
  /** Decimal degrees to 4 places; absent when NASR gives no usable value. */
  longitude?: number;
  name: string;
  state: string;
}

interface DirectoryIndex {
  byFaa: Map<string, DirectoryAirport>;
  byIcao: Map<string, DirectoryAirport>;
}

let index: DirectoryIndex | undefined;

function getIndex(): DirectoryIndex {
  if (index) return index;
  const byFaa = new Map<string, DirectoryAirport>();
  const byIcao = new Map<string, DirectoryAirport>();
  for (const line of NASR_AIRPORTS_TSV.split('\n')) {
    const [faaId, icaoId, name = '', city = '', state = '', artcc, latitude, longitude] =
      line.split('\t');
    if (!faaId) continue;
    const airport: DirectoryAirport = {
      city,
      faaId,
      name,
      state,
      ...(icaoId ? { icaoId } : {}),
      ...(artcc ? { artcc } : {}),
      ...(latitude ? { latitude: Number(latitude) } : {}),
      ...(longitude ? { longitude: Number(longitude) } : {}),
    };
    byFaa.set(faaId, airport);
    if (icaoId) byIcao.set(icaoId, airport);
  }
  index = { byFaa, byIcao };
  return index;
}

/**
 * Resolves an uppercase airport code: a 3-character code by FAA identifier, a 4-character code
 * only when the directory lists it as the ICAO code of a US airport (`KSEA` → SEA, `PHNL` → HNL).
 * The crosswalk is a lookup, never a prefix strip, so `K0S9` or `CYVR` resolves to nothing.
 */
export function resolveAirportCode(code: string): DirectoryAirport | undefined {
  const { byFaa, byIcao } = getIndex();
  if (code.length === 3) return byFaa.get(code);
  if (code.length === 4) return byIcao.get(code);
  return;
}

/** Schema preprocess for one airport code: trims and uppercases strings; other values pass through. */
export function normalizeAirportCode(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/** Source, NASR cycle, and size of the bundled directory. */
export function getDirectoryInfo(): {
  airportCount: number;
  effectiveDate: string;
  source: string;
} {
  return {
    airportCount: getIndex().byFaa.size,
    effectiveDate: NASR_EFFECTIVE_DATE,
    source: 'FAA NASR APT_BASE',
  };
}

/**
 * @fileoverview Normalized domain types for the NAS Status feeds. Every field but a row's key is
 * optional: the feeds are undocumented, so an absent or wrong-typed upstream field is omitted
 * rather than defaulted.
 * @module services/nas-status/types
 */

import type { AdvisoryRef } from '@/services/advisory/advisory-ref.js';

/** Per-15-minute average delay values from a program's `fuelFlowAdvisoryDelayTime`. */
export interface DelayProfile {
  averageDelayMinutes: number[];
  intervalMinutes: 15;
  startTime: string;
}

export type Trend = 'increasing' | 'decreasing';
export type ProbabilityOfExtension = 'low' | 'medium' | 'high';

export interface GroundStop {
  advisory?: AdvisoryRef;
  controllingCenter?: string;
  endTime?: string;
  includedFacilities?: string[];
  includedFlights?: string;
  probabilityOfExtension?: ProbabilityOfExtension;
  reason?: string;
  startTime?: string;
  updatedAt?: string;
}

export interface GroundDelayProgram {
  advisory?: AdvisoryRef;
  averageDelayMinutes?: number;
  controllingCenter?: string;
  delayProfile?: DelayProfile;
  departureScopeNm?: number;
  endTime?: string;
  includedFacilities?: string[];
  includedFlights?: string;
  maximumDelayMinutes?: number;
  reason?: string;
  startTime?: string;
  updatedAt?: string;
}

/** Arrival or departure delay: a 15-minute band plus trend. */
export interface DelayBand {
  maxMinutes?: number;
  minMinutes?: number;
  reason?: string;
  trend?: Trend;
  updatedAt?: string;
}

export interface Closure {
  endTime?: string;
  startTime?: string;
  text?: string;
  updatedAt?: string;
}

export interface ClosureNotam {
  endTime?: string;
  issuedAt?: string;
  notamNumber?: number;
  notamText?: string;
  startTime?: string;
  text?: string;
  updatedAt?: string;
}

export interface Deicing {
  startedAt?: string;
}

export interface RunwayConfiguration {
  arrivalRatePerHour?: number;
  arrivalRunways?: string;
  departureRunways?: string;
  reportedAt?: string;
}

/** One `/api/airport-events` row: an airport with at least one active event. */
export interface AirportEvents {
  airportId: string;
  airportName?: string;
  arrivalDelay?: DelayBand;
  closure?: Closure;
  closureNotam?: ClosureNotam;
  deicing?: Deicing;
  departureDelay?: DelayBand;
  groundDelayProgram?: GroundDelayProgram;
  groundStop?: GroundStop;
  latitude?: number;
  longitude?: number;
  runwayConfiguration?: RunwayConfiguration;
}

export type ConstrainedAreaType =
  | 'airport'
  | 'artcc'
  | 'sector'
  | 'tracon'
  | 'special_use_airspace'
  | 'fix'
  | 'fca';

/** One `/api/enroute-events` row: an Airspace Flow Program (shape inferred from the dashboard). */
export interface AirspaceFlowProgram {
  advisory?: AdvisoryRef;
  altitudeCeiling?: string;
  altitudeFloor?: string;
  arrivesTo?: string;
  averageDelayMinutes?: number;
  comments?: string;
  constrainedArea: { name?: string; type: ConstrainedAreaType };
  delayProfile?: DelayProfile;
  departsFrom?: string;
  endTime?: string;
  excludedArrivals?: string;
  excludedDepartures?: string;
  filtersMatchAny?: boolean;
  headingDirection?: string;
  name: string;
  reason?: string;
  startTime?: string;
  updatedAt?: string;
}

export type TimeQualifier = 'after' | 'until' | 'by' | 'between';
export type Likelihood = 'possible' | 'probable' | 'expected';

/** One planned item of the operations plan. */
export interface PlannedItem {
  likelihood?: Likelihood;
  text: string;
  timeQualifier?: TimeQualifier;
  timeUtc?: string;
}

export interface OperationsPlan {
  advisory?: AdvisoryRef;
  enRoutePlanned: PlannedItem[];
  terminalPlanned: PlannedItem[];
}

export interface PacingAirport {
  airportId: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

/** A parsed feed: rows plus how many rows were unreadable and skipped. */
export interface FeedRows<T> {
  rows: T[];
  skippedRows: number;
}

/** A feed read as served to a tool: its content plus when this server fetched it. */
export type FeedSnapshot<T> = T & { fetchedAt: string };

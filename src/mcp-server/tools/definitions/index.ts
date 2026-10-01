/**
 * @fileoverview Every tool definition this server registers, in surface order.
 * @module mcp-server/tools/definitions
 */

import { getAdvisory } from './get-advisory.tool.js';
import { getAirportStatus } from './get-airport-status.tool.js';
import { getOperationsPlan } from './get-operations-plan.tool.js';
import { listActiveEvents } from './list-active-events.tool.js';
import { listReference } from './list-reference.tool.js';

export const allToolDefinitions = [
  getAirportStatus,
  listActiveEvents,
  getOperationsPlan,
  getAdvisory,
  listReference,
];

---
name: faa-traffic-delays-guide
description: Gates and workflows for the faa_delays_* tools over FAA ground stops, delay programs, airport delays and closures, the operations plan, and ATCSCC advisories. Covers whether a program holds a given flight, reading a closure's scope and schedule, dating the operations plan, UTC date crossings, and finding revised, canceled, or past programs in the advisory index. Use when answering US flight-delay or airport-disruption questions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

FAA traffic management for US airports, keyless: what the Command Center has in effect now (ground stops, Ground Delay Programs, Airspace Flow Programs, arrival and departure delays, closures, deicing), what its current operations plan expects, and the ATCSCC advisories behind them, past dates included.

Not covered; say so rather than infer it:

- **One flight's status.** Per-flight EDCTs, airline delays and cancellations, gates. An answer from this server covers FAA programs only.
- **Weather.** Observations and forecasts come from an aviation weather source. The plan advisory's TERMINAL CONSTRAINTS section names the weather the FAA is planning around.
- **Airports outside the US.** Canadian airports appear only as departure airports a US program includes.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| Airport code: FAA 3-character (SEA) or ICAO (KSEA); output always uses the FAA form | the user; an itinerary's IATA code, which usually equals the FAA identifier | faa_delays_get_airport_status; the control element filter of faa_delays_list_advisories |
| Advisory number + UTC date | the advisory reference on program rows and on the plan; a faa_delays_list_advisories row | faa_delays_get_advisory |
| ARTCC code (ZOA) | `artcc` on every airport-status row; the ARTCC part of a control element (SFO/ZOA) | a program's `includedFacilities`; the control element filter |
| Control element (SFO/ZOA, PHLC/ZNY, DCC for national advisories) | faa_delays_list_advisories rows | the control element filter |
| FCA, reroute, or AFP name (FCA010:MEM_BLUZZ_PARTIAL) | advisory row `details`; plan advisory text; the location of an airspace_flow_program event | the text query of faa_delays_list_advisories |

## Gates

**A program at an airport holds flights bound for it.** A ground stop or GDP at B holds flights to B at their departure airports; it does not hold B's own departures. For a flight from A to B, request both airports in one faa_delays_get_airport_status call. A's departure is held by A's departure delay or closure, and by B's ground stop or GDP when A's `artcc` is in that program's `includedFacilities`, or when A lies within the program's `departureScopeNm` of B (compare the two rows' coordinates). A ground stop or GDP the plan expects at A concerns flights into A.

**Read every event on the row.** `status` names only the first match in its precedence order, and one row can carry a GDP and a departure delay together.

**Read the NOTAM text for a closure's scope.** `AD AP CLSD` closes the whole airport, with exceptions after `EXC`. `CLSD TO NON SKED TRANSIENT GA ACFT` bars only non-scheduled transient general aviation; scheduled airline flights are unaffected. Both forms arrive as closure NOTAMs: a live ASE NOTAM read `AD AP CLSD EXC LIFE FLT HEL AND SAR HEL` on a row whose status was `restrictions_only`, so `restrictions_only` does not mean open.

**Check whether a closure is in effect now.** A closure scheduled `DLY HHMM-HHMM` closes the airport only inside that daily UTC window, while its `startTime`–`endTime` span runs for days. Report `inEffect` and the next window from the notice, never the span as one closure. Other schedule wordings are not parsed: read the text before saying an airport is closed now.

**Date the operations plan before quoting it.** The feed carries the current plan advisory, which the FAA reissues several times a day, so it can be many hours old: one read at 0854Z had been sent at 0025Z and still listed `UNTIL 0500` items. Plan times are HHMM UTC with no date; the day comes from the EVENT TIME line of the plan advisory's text. Read that advisory with faa_delays_get_advisory for `sentAt`, `effectiveStart`, and `effectiveEnd`, then compare each item's time with now: an UNTIL item past its time is over, and an AFTER item past its time is either in the feed now or did not happen. The advisory's TERMINAL ACTIVE section belongs to the same snapshot; what is active now comes from the feed tools.

**An empty `plannedPrograms` is not "no trouble expected".** It holds the plan's terminal ground-stop and delay-program items that name the airport, with times as written. En-route items (ORD/MDW ARRIVAL ROUTES POSSIBLE) stay in the plan's en-route list, and terminal constraints (weather by airport) and runway closures appear only in the plan advisory's text. `likelihood` is absent when the FAA used another word (LIKELY); read the item text then.

**Work in UTC dates.** `timezone` appears only on the FAA pacing airports (the major contiguous-US airports faa_delays_list_reference lists); convert any other airport from its state or coordinates with a time-zone source. A US evening falls on the next UTC date, and advisory dates are UTC issue dates: SFO's GDP issued on 2026-11-03 was canceled by advisory 13 of 2026-11-04, sent at 04:31Z. For "today", "this evening", or "yesterday" in local terms, read both UTC dates.

**Filter the advisory index two ways before calling it empty.** The control element filter matches only the index's control element column, and the FAA files some airport advisories under another facility: EWR arrival delays as PHLC/ZNY, south Florida arrival delays as ZMA/DCC. Also filter by the airport's ARTCC, or query its identifier, before saying an airport had no advisories.

**Search cancellations under both spellings.** Subjects abbreviate (CDM GS CNX, CDM GROUND DELAY PROGRAM CNX) or spell it out (FLL GROUND STOP CANCELLATION), so query both CNX and CANCEL. A program can also end inside another advisory: SFO's ground stop of 2026-11-03 was canceled in the COMMENTS of its GDP revision (GROUND STOP CANCELED). A cancellation gives its reason only sometimes, under COMMENTS or REMARKS (IAH's ground-stop CNX of 2026-11-03 left COMMENTS blank); otherwise report the program's own IMPACTING CONDITION.

**Read the newest revision.** A revised program is a new advisory number on the same control element, and the index lists newest first. The newest one carries the current program rate, period, and delays: SFO's GDP of 2026-11-03 set an 82-minute average delay in advisory 42, and revision 59 raised it to 114 and changed the hourly rates.

**A rejected code is not a missing airport.** One unknown code fails the whole faa_delays_get_airport_status call; drop it and resend the rest. The directory follows FAA identifiers, so a code a traveler knows can be rejected after the FAA re-identifies an airport (PBI was rejected for Palm Beach International, which the directory lists as DJT). City and airport names are rejected; resolve them to codes first.

**Absent is unknown, not zero.** An `enRouteFeed` other than ok leaves Airspace Flow Programs unknown; a notice naming unreadable feed sections leaves their contents unknown; an absent `plannedPrograms` means the plan could not be read; missing pacing flags mean that list failed. Say which part is missing.

## Workflows

### Will a flight be delayed?

1. Convert the scheduled departure to UTC (see Work in UTC dates).
2. Call faa_delays_get_airport_status with the origin and destination. At the origin, look for a departure delay or a closure in effect. At the destination, look for a ground stop or GDP that holds the origin (see the first gate), and size the hold from the GDP's average and maximum delay or its delay profile at the 15-minute interval holding the flight's arrival time. An arrival delay at the destination is airborne holding.
3. Read `plannedPrograms` on both rows against the flight's UTC time, and the plan advisory's constraints for either airport.
4. Report FAA programs only. The flight's own EDCT and status come from the airline.

### Why a ground stop or GDP, and how long

The row gives the reason, the scheduled `endTime`, and for a ground stop its probability of extension. faa_delays_get_advisory on the row's advisory reference adds the ground stop period, the departure facilities included, the total, maximum, and average delays, the impacting condition, and COMMENTS.

For a GDP, PROGRAM RATE is the arrivals per hour the program meters to: one slash-separated value per hour, starting at the hour ARRIVALS ESTIMATED FOR opens (16 values for 1630Z–0759Z). Compare it with the row's airport arrival rate (AAR), present only when the feed lists the airport with a runway configuration, which not every listed airport has.

A program that has ended is gone from the feed. Find it with faa_delays_list_advisories on today's UTC date and the one before.

### Which airports are worst right now

faa_delays_list_active_events sorts by event type and delay, not by impact on travelers. Before ranking, drop closure NOTAMs that bar only general aviation, check whether each closure is in effect, and set aside delays the stale-entry notice names (the FAA feed can keep a delay entry after it lapses). Its counts include those restrictions, so a raw event count overstates disruption.

### What happened earlier, or on a past date

Call faa_delays_list_advisories for each UTC date the period covers, narrowed by categories, the airport's control element and ARTCC, or a text query. Then call faa_delays_get_advisory per row for its text.

### Trouble later today at an airport or metro area

Request every airport in the area; the plan can name a metro area's airports together (SEA/BFI). Date the plan, read `plannedPrograms` and the en-route items, and read the plan advisory's TERMINAL CONSTRAINTS and runway closure list for those airports (see Date the operations plan).

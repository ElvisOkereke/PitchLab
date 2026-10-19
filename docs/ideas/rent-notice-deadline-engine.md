# Rent-increase & renewal notice deadline engine for small property managers

Reads a manager's rent roll, applies each jurisdiction's notice rules, and drafts, schedules and logs proof of every renewal and rent-increase notice so no deadline slips.

## Problem

Rent increases and lease renewals only take effect if the tenant gets proper written notice within a window set by the local jurisdiction, and those rules differ between cities, states and provinces. If the window is missed, the increase waits a full cycle. One manager reported missing a lease renewal by three weeks and losing $2,400 in below-market rent. Most firms track these dates in spreadsheets or in a generic PM-software reminder that knows nothing about local rules, and they keep no clear record of when and how each notice was served.

## Buyer

Independent property management firms running a few hundred to a few thousand units across several states or provinces. They hit notice deadlines on every unit every year, so a miss repeats across the whole portfolio. Owners also hold the manager responsible for lost rent, which makes the manager the one who feels the pain most.

## Proposed service

Each month the manager uploads a rent-roll export from any PM system, or the engine pulls it on a schedule. A rules table keyed by jurisdiction works out the last valid service date for each lease. The engine drafts the notice from templates the client approves, sends it through trackable email or a print-and-mail API, and stores timestamped proof of delivery for each unit. Managers get a forward-looking list of upcoming deadlines and a flag for any lease already past its window. Current PM software sends generic date reminders but doesn't model jurisdiction-specific notice rules or build a proof-of-service file; lawyers can do this but are priced per matter, not per unit at portfolio scale. The engine applies published rules to templates the client signs off on and gives no legal advice. A pilot can start from one client's rent-roll CSV in a few days.

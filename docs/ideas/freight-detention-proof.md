# Detention Proof Packager for Freight Brokers

Automatically builds timestamped check-in/check-out proof packets for every load so brokers can meet the documentation terms in shipper contracts and win the detention claims they lose today.

## Problem

Shipper contracts and carrier agreements say detention is only paid when there are timestamped records of arrival and departure. Laneproof reviewed detention disputes and found that brokers who can't produce timestamped BOL check-in and check-out records lose them. Those timestamps end up spread across driver texts, emails, and group threads, unlogged. The money is lost quietly, and the TMS rarely produces proof that meets the contract.

## Buyer

Small and mid-size freight brokerages. They file and argue detention claims across many shippers every week, so missing proof costs them money again and again. One engine can cover every load they book.

## Proposed service

Brokers forward or connect their load emails, carrier check-call texts, ELD/GPS exports, and BOL/POD scans to the engine. It pulls the timestamps for each stop, matches them to the free-time and notice clauses in each shipper's contract terms, flags missing evidence while the load is still moving (for example, no check-out time logged yet), and puts together a dispute-ready packet with the source documents attached. TMS tools record loads but don't check the evidence against contract rules. This needs no license because it's contract documentation, not brokerage or legal work. It can be piloted on one broker's last month of disputed detention claims.

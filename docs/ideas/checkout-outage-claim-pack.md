# Checkout-outage loss reconstruction & claim pack for paid-traffic merchants

Fixed-price, per-incident service that rebuilds what a checkout outage cost a merchant (lost orders plus ad spend burned into a dead checkout) and turns it into a ready-to-file claim and make-good package.

## Problem

When a CDN, app or payment issue breaks checkout, merchants find out late, sometimes after days of zero sales on normal traffic, and are left asking how to get compensation. Ad spend keeps flowing to a checkout that can't convert, and outage-period waste is invisible in ad dashboards. Putting together the evidence (timeline, traffic vs orders, spend by campaign, a baseline conversion estimate) is manual forensic work that most merchants never do, so they absorb the loss.

## Buyer

Owners and finance leads of Shopify merchants that run several stores and buy Google and Meta traffic. They pay for clicks while checkout is down, and today nobody is tasked with putting a number on that loss or chasing it. This buyer pays after an incident to get money back, not for alerts.

## Proposed service

The merchant connects read-only exports (Shopify orders and sessions, Google and Meta Ads spend). The engine finds the outage window from the gap between traffic and orders, estimates expected orders from the merchant's own past baseline, and lists the ad spend by campaign during the window. It then produces a standard claim pack: a timeline, evidence charts, and letters tailored to the responsible vendor's SLA or support process, plus a list of campaigns that should have auto-paused. It's sold at a flat fee per incident, or as a retainer that also sets up spend-pause rules. Monitoring tools say something broke but don't measure the money lost or prepare the recovery paperwork. It only uses data the merchant already owns, so no partnerships are needed.

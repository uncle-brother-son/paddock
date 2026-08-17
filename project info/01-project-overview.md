# 1. Project Overview & Goals

## Brief

The Paddock Wellness Club is a sauna and wellness retreat requiring a custom-built website with
integrated booking, membership, session-pass, gift card, and merchandise sales. The site is a
composable/headless architecture: a custom React frontend, Sanity as the content CMS, and a
fully custom backend for booking and commerce logic, hosted on Cloudflare.

## Goals & Objectives

- Fully branded, custom-designed site
- Flexible sauna booking supporting both public sessions and exclusive private bookings
- One-off bookings and recurring revenue via memberships and prepaid session passes
- Additional revenue via booking add-ons, standalone merchandise, and gift cards
- Simple internal tooling for staff to manage bookings and view reporting, without developer
  involvement

## Success Criteria

- Client can independently manage content via Sanity without developer involvement
- Staff can manage day-to-day bookings via Retool without developer involvement
- Zero double-bookings or public/private slot conflicts in production

## Stakeholders

| Name | Role | Responsibility |
|---|---|---|
| Henry & Helen (HH) | Business owner | Final sign-off, content, brand |
| Wayne | Agency lead / designer / developer | Build, architecture, delivery |

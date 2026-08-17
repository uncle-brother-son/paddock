# 3. User Flows

To be documented in full: step-by-step walkthroughs of key journeys.

- Public session booking (browse → select slot → add-ons → pay → confirm)
- Private booking (browse → select slot → add-ons → pay → confirm)
- Monthly Membership purchase
- Session pass purchase
- Gift card purchase (digital or physical, sent to self or someone else)
- Merchandise/Products purchase (standalone)
- Combined cart (booking + add-ons + merchandise in one checkout)
- Gift card redemption at checkout
- Staff: manual booking creation
- Staff: walk-in upsell charged to saved card
- Staff: physical gift card fulfillment — note: reconcile against updated gift card fulfillment
  answer in 00-README.md flag #2 (pickup in person, not postal)
- Staff: check in a customer on arrival
- Booker: add guest emails at time of booking
- Staff: check guest waiver completion at check-in

## Cross-cutting features

Capabilities that appear as an optional step *inside* several of the flows above, rather than
being a flow of their own:

- Apply a discount/promo code at checkout (see 05-data-model.md → Orders/Checkout) — applies
  within: public session booking, private booking, combined cart, merchandise purchase
- Redeem a session pass credit instead of paying (see 05-data-model.md → Session Passes) —
  applies within: public session booking, private booking
- Redeem a membership session credit instead of paying (see 05-data-model.md → Memberships) —
  applies within: public session booking, private booking
- Redeem a membership add-on credit instead of paying (see 05-data-model.md → Memberships,
  Add-ons) — applies within: any flow with add-ons attached

## Possible future functionality

Not in scope now, but useful to know for how things need to be architected:

- One-off events

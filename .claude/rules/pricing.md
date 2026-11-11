# Pricing and bookings

Applies to any change under the pricing or bookings modules of `apps/api`.

- The pricing engine is the only place a total is computed. The web app displays what the API returns.
- Prices are per person by room occupancy, in integer minor units. State the rounding rule once and test it.
- A booking stores an immutable snapshot of its configuration and price breakdown at submission. Later price changes never alter existing bookings.
- The total shown to a customer includes every mandatory component.
- Booking state changes go through the state machine. No direct status updates.
- Allotments (entries, rooms) are decremented in a transaction and can never go below zero.
- Tests are table-driven: occupancy 1 to 4, extra nights, supporters, promo codes, rule combinations and boundary dates.
- Changes here go through the `reviewer` subagent before the task is closed.

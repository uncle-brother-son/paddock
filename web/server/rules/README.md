# server/rules

The business rules ported from the Retool backend functions, grouped by subject. Each rule takes
plain arguments and a `Queryable`, never a request or a staff context, so the staff, customer and
public routes can all call the same rule. Routes only parse input, call the rule and return.

Each ported file names its Retool source on its first line. `testing/` holds the PGlite harness.

# Admin Website Diagram — Production Specification

Source: `Admin-Dashboard.dc.html` (Website Configuration → Website Diagram module — this
module already contains real, useful data, not just a mockup).

## Existing data model (found in source, worth carrying forward almost as-is)
An internal array of tuples, one per known page:
```
[id, label, route, column, row, status, sourceFile, note, connections[]]
```
Example entries actually present in the file today:
- `["login", "Student login", "/login", 2, 1, "working", "Student-Login.dc.html", "Demo
  credentials student / Student@123. To be replaced by OTP or email verification.",
  ["dashboard", "register"]]`
- `["register", "Student register", "/register", 2, 3, "missing", "", "Referenced from login
  and the final CTA; page not built.", ["dashboard"]]`
- `["dashboard", "Student dashboard", "/dashboard", 3, 1, "working", "Student-Dashboard.dc.html",
  "Overview and navigation only — detailed data lives on dedicated pages.",
  ["customModule", "footer", ...]]`
- `["player", "Test player", "/tests/attempt", 4, 0, "working", "Test-Player.dc.html", "...",
  ["result", "query", "ai"]]`
- `["footer", "Global footer", "shared component", 1, 6, "working", "Site-Footer.dc.html", "...",
  [...]]`
- `["testResultPage", "Test result page", "/results/:id", 5, 4, "missing", "", "Test History
  rows link here (Student-Test-Result.dc.html); the standalone result page with subject-wise
  breakdown is [not built]", [...]]`
- `["adminMessages", "Messages", "/admin/messages", 9, 5, "working", "Admin-Dashboard.dc.html",
  "One inbox for Grow With Us, Contact Us and in-test 'Message to Admin' submissions...", [...]]`

## What this is for
A grid-positioned (column/row) node-and-edge diagram of every page: its route, build status
(working/missing), which .dc.html design file it maps to, a human note, and its outgoing
connections to other pages — used to spot broken/missing navigation (e.g. `register` and the
standalone test-result page are flagged `missing` right in the data).

## Production requirements
- Rebuild this as a real, admin-maintained diagram (or at minimum a generated one from the
  actual Next.js route manifest + a manually-curated status/notes column) rather than a
  hand-maintained array — the hand-maintained version is exactly the kind of thing that goes
  stale.
- **New pages must be addable without a feature redesign**: keep the underlying data as a
  simple list of nodes/edges (as it already is) rather than baking layout logic into each
  node — this constraint is already satisfied by the current tuple shape; preserve it.
- Recommended real source of truth: derive `status` (working/missing) from whether a route
  actually resolves in the App Router, rather than a hand-set flag, once the real app exists;
  keep `note` as the one genuinely manual field.
- This diagram is an internal admin tool for auditing navigation — it is not a student-facing
  sitemap.

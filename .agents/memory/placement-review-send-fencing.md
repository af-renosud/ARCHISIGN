---
name: Placement-review send fencing
description: Why field-layout mutations and placement approval must serialize with initial-send claims.
---

For an envelope whose sending depends on a placement-review state, every field-layout, PDF-layout, placement-mode, and approval mutation must lock the envelope row and commit its revision/state change in the same transaction as the mutation.

**Why:** A conditional send claim alone is insufficient if a field edit commits before review invalidation. A concurrent send can observe the old approved state in that gap and deliver invitations for an unreviewed layout.

**How to apply:** Any new route that changes signing geometry or its approval must use the same envelope-row lock and transaction boundary. Initial-send paths must keep a database-level conditional claim so they wait for an active mutation and re-evaluate the committed review revision.
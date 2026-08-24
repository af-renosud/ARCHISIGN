---
name: Reminder delivery fencing
description: Concurrency rule for preventing reminders after signing without holding database transactions across Gmail calls.
---

Reminder delivery and signing must atomically exclude each other through a renewable, token-owned claim. Never hold a database transaction or pool connection while waiting for the email provider.

**Why:** A bare signed-state check races with signing, but a transaction-scoped lock across external email delivery can delay signing and exhaust the database pool. Lease recovery is only safe when the provider operation is bounded to finish well before takeover becomes possible.

**How to apply:** Keep reminder-provider timeout below the abandoned-claim window, renew ownership during live delivery, release only the matching token, and preserve tests for both operation orderings, renewal, and recovery.
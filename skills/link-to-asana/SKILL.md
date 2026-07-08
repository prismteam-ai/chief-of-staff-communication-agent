---
name: link-to-asana
description: "Turn a communication into tracked Asana work: create or update a task from a message, preserving provenance back to the source communication. Covers deciding when follow-up work is warranted, writing a clear task title and detail, and linking it to the originating message. Triggers on: create asana task, add a to-do, track this, follow up, log this as work, make a task. Do NOT trigger for sending replies — use draft-and-approve."
---

# Link to Asana

Use this when a communication implies tracked follow-up work — a deliverable, a deadline, an owed action.

## Procedure
1. Decide if the message genuinely needs a task. A quick reply is often enough; do not create noise.
2. `create_asana_task(message_id, title, detail)`:
   - **title**: imperative, ≤ 70 chars — e.g. "Send Atlas redline before Friday".
   - **detail**: what, who, by when. The task automatically carries provenance back to the source communication (channel, sender, quoted text, message id).
3. Confirm the resulting task URL to the executive.

## Boundaries
- Task creation, not sending. Replies go through `skills/draft-and-approve/`.

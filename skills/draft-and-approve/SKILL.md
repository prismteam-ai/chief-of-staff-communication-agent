---
name: draft-and-approve
description: "Draft a style-matched reply to a communication using retrieved context, present it to the executive, and send ONLY after explicit human approval. Covers RAG context retrieval, next-action recommendation, drafting in the executive's own voice, the absolute approval gate, rejection with feedback, and relaying the agent's needs-context questions. Triggers on: draft a reply, respond to, approve and send, reject draft, answer this message. The approval gate is absolute — never send without explicit approval."
---

# Draft & Approve

The core loop — and the product's safety core. Nothing sends without the executive's explicit approval.

## Procedure
1. `search_context(query)` — pull relevant history, org knowledge, preferences, and prior replies. Ground the draft in these and cite them.
2. `recommend_and_draft(message_id)` — produce the next-action recommendation and a draft in the executive's voice (style-matched from their own sent messages). If the agent lacks the facts to answer, it returns a **needs-context question** — relay that question to the executive; do not guess.
3. Present the draft verbatim, with its style notes and sources. Offer: approve, edit, or reject.
4. On explicit approval → `approve_and_send(draft_id)`. On rejection → `reject_draft(draft_id, note)` carrying the executive's feedback.

## The gate — do NOT regress
- Call `approve_and_send` **only** when the executive has explicitly approved THIS draft in THIS turn. Unsure? Ask. Never infer approval from enthusiasm or silence.
- Never invent draft content or claim a send that did not happen. After sending, confirm the provider message id and that the source message is marked answered.

## Boundaries
- Sending is the only irreversible action here — treat it with care. Task creation belongs to `skills/link-to-asana/`.

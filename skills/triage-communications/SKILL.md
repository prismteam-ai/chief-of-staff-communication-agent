---
name: triage-communications
description: "Survey an executive's pending cross-channel communications and prioritize them by the under-five-minute response goal. Covers pulling the pending queue, reading per-message context and cross-channel links, and surfacing overdue items first. Triggers on: triage, what needs me, inbox review, pending messages, overdue, prioritize communications, morning review. Do NOT trigger for drafting or sending — use draft-and-approve."
---

# Triage Communications

Use this skill to answer "what needs me right now?" across every channel.

## Procedure
1. Call `pending_messages` for the inbound items still awaiting a response.
2. Prioritize: **overdue (>5 minutes since arrival) first**, then oldest. The product's promise is every communication answered within five minutes.
3. For any item the executive asks about, call `message_context(message_id)` for the thread history, the current recommendation/draft, and cross-channel topic links (the same person or deal reaching out on more than one channel).
4. Call `dashboard_stats` when the executive wants the overall picture — volume, overdue count, % answered within 5 minutes, per-channel breakdown.

## Present
- One line per item: `channel · sender · age · the ask`. Flag overdue.
- Group by person/topic when a thread spans channels, so "Priya — Atlas renewal (gmail + whatsapp)" reads as one thing, not two.
- Lead with what is overdue or time-sensitive; defer FYIs.

## Boundaries
- Read-only. This skill never drafts or sends — hand off to `skills/draft-and-approve/`.

---
name: comms-answer
description: Answer state follow-up questions ("how many messages ingested?", "which connectors are failing?", "how many drafts await approval?", "are we hitting the 5-minute goal?") by reading the LATEST snapshot under comms-checks/ instead of re-querying every source. Use whenever Arthur asks about comms/store/queue state that a recent snapshot already covers.
---

# Comms answer

## What this skill does

Reads the most recent snapshot folder under `comms-checks/` to answer follow-up questions about system state, without re-hitting the store, provider APIs, or Asana for every question. One snapshot, many cheap local reads.

## When to invoke

Any question that maps to captured data, when a snapshot exists that postdates the last ingest/sync run:

- "how many messages/threads are loaded?" / "per channel?" → `store_counts.json`
- "which accounts are connected / when did X last sync?" → `connector_status.json`
- "what's in the RAG index?" / "when was it last built?" → `rag_status.json`
- "how many recommendations / drafts pending approval?" → `queue_status.json`
- "how many Asana tasks did the agent create?" / "is linking working?" → `asana_links.json`
- "are we answering within 5 minutes?" / "what's overdue?" → `response_metrics.json`
- "did anything fail in the last sync?" → `errors/`

Does NOT fit (query live instead):
- "is the sync running *right now*?" → check the process
- anything after an ingest run newer than the snapshot → run `comms-snapshot` first
- writing/fixing anything → this skill is read-only by nature

## Procedure

1. Find the latest snapshot:
   ```bash
   ls -1t comms-checks/ | head -1
   ```
   If none exists, or an ingest run finished after its timestamp, run the `comms-snapshot` skill first.
2. Read the relevant file(s) with the Read tool. The snapshot's `README.md` indexes what's there.
3. Answer tightly (1-3 sentences or a short table), citing the snapshot path so Arthur can verify:
   > Per `comms-checks/2026-07-07T120000Z/store_counts.json`: 1,204 messages across 3 accounts (gmail: 980, sms: 210, whatsapp: 14).

## Honesty rules

- If the snapshot doesn't contain what's asked (channel not captured, collector errored), say exactly that and offer to re-snapshot or query the one missing thing live. **Never extrapolate from connector code or memory** — that violates the reality hierarchy in CLAUDE.md.
- Snapshots are time-frozen: "since I last checked" means "since the snapshot timestamp". Say the timestamp.
- An `errors/` entry is an answer too: "the Asana collector failed because no workspace token is configured yet" is a valid, honest response.

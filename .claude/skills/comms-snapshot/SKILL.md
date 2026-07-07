---
name: comms-snapshot
description: Capture full communication-agent state — live message-store counts per channel/account, connector sync status, RAG index stats, recommendation/draft/approval queue depths, Asana link coverage, response-time metrics, error logs — into a timestamped folder under comms-checks/. Pure data capture, no analysis. Use after any ingest run, before answering state questions, or before a demo rehearsal. Pair with the comms-answer skill to interpret.
---

# Comms snapshot

## What this skill does

One capture of the system's real state into a single timestamped folder under `comms-checks/`. **No analysis happens here** — that's the `comms-answer` skill's job. The point is one honest read of reality (live store queries and connector status, not code inspection), then many cheap follow-ups against the cached files.

A snapshot is also the evidence backbone for the dashboard's claims (volume, overdue, pending approvals, response times) — if the snapshot and the UI disagree, one of them is lying and that's a bug.

## When to invoke

- Right after any ingest/sync run completes (the ingest gate in CLAUDE.md requires it)
- Before answering questions like "how many messages are loaded?" / "which connectors are healthy?" / "how many drafts are pending approval?" — if no snapshot exists that postdates the last ingest
- Before running the demo-rehearsal skill

If Arthur asks about *one* current thing (e.g. "is the Gmail sync running?"), don't snapshot — check that one thing live. Snapshots are for cross-cutting state capture, not point queries.

## Staleness rule

Snapshots go stale per **ingest/sync run**, not per clock time. If a sync finished after the latest snapshot's timestamp, re-snapshot before answering state questions. If nothing has run since, the existing snapshot stays authoritative.

## How to run

Until the message store lands (Phasing step 3), collectors run as manual live queries pasted into the snapshot folder. Once the store schema exists, codify them into `collect.py` (mirror `../oracle-property-intelligence-platform-pipeline-completion/.claude/skills/pipeline-snapshot/collect.py`) and run:

```bash
uv run python .claude/skills/comms-snapshot/collect.py [--note "label"]
```

The procedure either way:
1. Create `comms-checks/<YYYY-MM-DDTHHMMSSZ><_note>/`
2. Run every collector; each writes its own file
3. Write a `README.md` index last, listing every file with a one-line description
4. Report the snapshot path

## What's collected

| File | Source | Contents |
|---|---|---|
| `store_counts.json` | live store queries | Messages, threads, participants, topic links per channel × account — reality, never derived from connector code |
| `connector_status.json` | connector registry + sync logs | Per account: auth state, last successful sync, messages fetched, rate-limit notes |
| `rag_status.json` | live index queries | Documents indexed by source type (messages / Asana / preferences / org knowledge), last build time, embedding model |
| `queue_status.json` | live store queries | Recommendations pending, drafts awaiting approval, approvals granted, sends completed |
| `asana_links.json` | live store + Asana API | Linked tasks/projects, tasks created/updated by the agent, link coverage |
| `response_metrics.json` | live store queries | Answered vs unanswered, overdue count, response-time distribution vs the <5-min goal |
| `errors/<collector>_ERROR.txt` | any failed collector | Full trace; one failure never aborts the snapshot |
| `README.md` | derived | Index of every file, snapshot timestamp, note |

## Failures

A missing store, an unauthenticated connector, or an absent table is a *finding*, not a crash — it lands in `errors/` with the exact error, and the snapshot completes. An early-project snapshot that is mostly `errors/` is a correct snapshot.

## After running

Tell Arthur the snapshot path in one line. Do NOT summarize contents — that's `comms-answer`'s job.
> Snapshot at `comms-checks/2026-07-07T120000Z/`. Ready for follow-ups.

---
name: demo-rehearsal
description: Rehearse the full demo against the real system and produce a traceability matrix over the ORIGINAL README acceptance criteria — Criterion | Evidence (command/screenshot + output excerpt) | PASS/FAIL/PARTIAL. Use before claiming any milestone progress, before recording the demo video, or when Arthur asks "where are we against the criteria?". Missing evidence = FAIL. No percentage claims.
---

# Demo rehearsal

## What this skill does

Exercises the system the way the grader will — the actual ingest, the actual RAG retrieval, the actual UI, the actual Cursor/MCP agent — and grades every README acceptance criterion against live evidence. This is the project's defense against the ancestral failure mode: a validator once reported "all five requirements successfully implemented" when 4/5 were done, because it checked a derived plan instead of the original spec.

## Hard rules

- Grade against **README.md acceptance criteria read fresh at rehearsal time** — never from memory, never against a phase list, todo list, or plan derived from them.
- A criterion without pasted evidence (command + output excerpt, or a screenshot for UI steps) is **FAIL**. "The code does this" is not evidence; code is a plan.
- No percentage-complete claims. The output is the matrix, row by row.
- An all-FAIL matrix early in the project is the machinery working correctly, not a problem to soften.
- Every send demonstrated MUST show the approval step in between, on demo/sandbox accounts only (Do NOT regress invariants).

## Procedure

1. Re-read `README.md` — the full Acceptance Criteria list (~40 items; group related rows, but every criterion gets a row).
2. Refresh reality: run the `comms-snapshot` skill (or confirm the latest snapshot postdates the last ingest run).
3. Walk the demo end to end, in the order the README's "Demonstrate" criteria imply:
   - **Multi-channel ingestion** → trigger/confirm sync on ≥2 channels; cite live store counts per channel with provenance
   - **RAG-backed retrieval** → run real questions through the retrieval layer spanning comms + Asana context; record query + retrieved sources
   - **Recommended actions** → feed incoming messages; record the recommendation per message
   - **Style-matched drafts** → generate drafts; compare against the user's actual sent history side by side
   - **Cross-channel topic linking** → show two messages from different channels linked to the same person/topic
   - **Approval before delivery** → walk draft → approve → send on a sandbox account; screenshot the approval step
   - **Asana task creation/update** → trigger from a communication; cite the resulting Asana task URL
   - **Dashboard UI** → drive it (playwright/browser tools); screenshot volume, status, overdue, pending approvals, channel breakdown, response-time views
   - **Cursor agent** → connect from Cursor via MCP; run a retrieve + recommend + draft + Asana-update round trip; record the transcript
   - **Setup simplicity** → walk the documented setup as a non-technical user would; note every step that requires technical knowledge
4. Emit the matrix:

   | Criterion (verbatim from README) | Evidence | Status |
   |---|---|---|
   | Support Gmail as one email provider | connector_status.json: gmail acct synced 2026-07-07T12Z, 980 msgs | PASS |
   | Support LinkedIn integration | no connector exists yet | FAIL |

   PARTIAL is allowed only with the gap named in the Evidence cell.
5. Feed gaps back into CLAUDE.md **Phasing / Status** (and Open questions if a gap is a design unknown). No separate report file — the matrix goes in the conversation, status goes in CLAUDE.md.

## Slowking self-assessment harness (run at every milestone, full fidelity)

A methodology-only imitation drifts on the shadow bands (learned 2026-07-08 — first baseline loaded only 2 of slowking's 5 inputs). Run it properly:

1. **Orchestrator subagent** follows `../refs/soofi-xyz-team-kit/agents/slowking.md` verbatim and loads ALL its inputs: `apply-engineering-guidelines`, `evaluate-candidate-intent`, `evaluate-candidate-product`, `evaluate-candidate-implementation` (all under `../refs/soofi-xyz-team-kit/skills/`).
2. **Two independent pillar subagents**, never one combined evaluator: product/evidence (drives the UI with Playwright browser tools — curl-only is allowed only while no UI exists) and implementation/kit-usage (consults `arceus.md` + the mapped builder agents — chatot, oranguru, xatu, wigglytuff, ash, espeon/alakazam, metagross — as read-only reviewers).
3. Gates applied honestly every time: pre-deployment the formal score is 0/100 (local runtime) — print it per slowking's rules, then the labeled SHADOW assessment steers priorities. Track the shadow total across milestones; it must be monotonically rising.
4. Before the actual PR: run against the real submission package (public runtime URL, shipped demo credentials, demo video). All hard gates must pass — a localhost-only runtime is an automatic 0/100 regardless of how good the matrix looks. Fix every failure before Arthur submits.

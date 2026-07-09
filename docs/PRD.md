# Chief of Staff Communication Agent — PRD

Status: draft for sign-off. Scope: the vertical slice we will build, deploy, and demo for
the Prism assessment. This document defines **what the agent does** (actions), **which
message situations it handles** (cases), and the **demo scenario** it must pass.

---

## 1. Problem & goal

A busy executive gets messages across many channels. Things fall through the cracks and
replies are slow. **Goal: help the exec answer every message in under 5 minutes** by pulling
all channels into one place, understanding each message in context, recommending the next
action, drafting a reply in the exec's voice, and tying it to their Asana work — with a human
approving before anything sends.

**Persona:** "Dmitrii", a startup CEO. Channels: Gmail (primary), X (mentions + DMs),
WhatsApp. Task system: Asana.

---

## 2. The core loop (what happens to every message)

```
Ingest → Normalize → Enrich (RAG context) → Triage → Recommend action
      → Draft reply (in style) → Link/Update Asana → Human approves → Send → Track
```

Each step is one capability we build:

| # | Capability | What it produces |
|---|---|---|
| 1 | **Ingest** (done) | Messages from Gmail + X + WhatsApp, normalized, with participants, timestamps, **attachments** (where available), and provenance |
| 2 | **Cross-channel link** | Group related messages by **topic, person, customer, project, or decision** across channels |
| 3 | **RAG context** | Relevant items from **four sources**: communication history, Asana (tasks/projects/milestones), **user preferences**, and **organizational knowledge** |
| 4 | **Triage** | Priority (urgent / normal / low) + "needs reply?" + deadline detection |
| 5 | **Recommend action** | One action from the fixed taxonomy below |
| 6 | **Draft reply** | A reply written in the exec's style, grounded in RAG context |
| 7 | **Asana link** | Create or update the right task, linked back to the message |
| 8 | **Approval** | Draft shown to exec; approve / edit / reject before send |
| 9 | **Send + track** | Send via the channel connector; mark answered; record response time |

---

## 3. Action model (two dimensions)

The agent makes two decisions per message: **one communication action** (always) and **an
optional task operation** (a side effect on Asana). Keeping these separate is cleaner than
gluing them together and covers cases like "just change a task's status" or "delete a task"
without a combinatorial explosion.

### 3a. Communication action — pick exactly one
| Action | When |
|---|---|
| `REPLY` | Draft + send a reply |
| `ASK_SENDER` | Reply that asks the sender a clarifying question back |
| `SCHEDULE_MEETING` | They want a call; propose/book a time |
| `ESCALATE` | Urgent or above the exec's line; flag high-priority / route to a teammate |
| `DELEGATE` | Someone else should own it; hand it off |
| `NEEDS_INPUT` | Not confident — ask the **exec** for a decision/suggestion before drafting |
| `NO_ACTION` | FYI / already handled; mark answered, no draft |

### 3b. Asana operation — optional side effect (zero or one)
Asana is more than tasks — the agent connects a message to the right **task, project, and
milestone**, and can leave a **comment** (per the assignment's acceptance criteria).

| Op | When |
|---|---|
| `CREATE_TASK` | New follow-up work (attached to the right project/milestone) |
| `UPDATE_TASK` | Change fields or **status** of an existing task |
| `COMPLETE_TASK` | Mark a task done |
| `COMMENT_ON_TASK` | Add a comment to a task — e.g. paste the decision or the sent reply as an update |
| `DELETE_TASK` | Task no longer needed |
| _(none)_ | No Asana change |

Every op also carries the **project / milestone link** and the **linked message id** for
provenance (message ↔ task traceability both directions).

**Examples:** term sheet → `REPLY` + `UPDATE_TASK`; lease decision → `REPLY` + `CREATE_TASK`;
"handled, thanks" → `NO_ACTION` + `COMPLETE_TASK`; decision reached → `REPLY` + `COMMENT_ON_TASK`;
cancelled project → `REPLY` + `DELETE_TASK`; "can we meet?" → `SCHEDULE_MEETING`; angry
customer → `ESCALATE` + `CREATE_TASK`.

**Real vs stub side effects:** `REPLY` / `ASK_SENDER` send via the channel connector (real).
All task ops hit Asana (real). `SCHEDULE_MEETING`, `ESCALATE`, `DELEGATE` draft the message,
but their calendar/routing side effects are stubbed for this milestone.

---

## 4. Cases we cover (mapped to the hero data)

These are the situations the agent must handle correctly. Each maps to a real thread in our
test data so the demo is concrete.

Each case = a communication action + optional task op (Section 3).

| Case | Message | Comm action | Task op | Why |
|---|---|---|---|---|
| A. Investor term sheet | Sarah Lin — Gmail + X DM nudge | `REPLY` | `UPDATE_TASK` | Time-sensitive; existing "Review Series A term sheet"; **cross-channel** |
| B. Board deck | Emma Wright — Gmail + WhatsApp chase | `REPLY` | `UPDATE_TASK` | Update "Fill revenue slide"; **cross-channel** |
| C. Hiring candidate | Tom Reyes — Gmail + X mention | `REPLY` | `UPDATE_TASK` | Advance "Head of Sales loop"; **cross-channel** |
| D. Partnership proposal | Marcus Bell — Gmail | `REPLY` | `CREATE_TASK` | Needs a decision; new task |
| E. Office lease (regional) | Ana García — WhatsApp | `REPLY` | `CREATE_TASK` | Deadline this week; regional contact |
| F. Podcast invite | David Okafor — X mention | `REPLY` | _(none)_ | Low priority; polite defer |
| G. Supplier deadline | Kenji Watanabe — Gmail | `REPLY` | `CREATE_TASK` | Hard Q4 deadline |
| H. Already answered | Priya Nair — Gmail (exec replied) | `NO_ACTION` | `COMPLETE_TASK` | Handled; mark done |
| I. Ambiguous / low-confidence | thin/unclear message | `NEEDS_INPUT` | _(none)_ | Ask the exec instead of guessing |
| J. Missing detail from sender | request lacking key info | `ASK_SENDER` | _(none)_ | Reply asking the sender to clarify |
| K. Customer escalation | angry / urgent support msg | `ESCALATE` | `CREATE_TASK` | Above the line; flag + track |
| L. Meeting request | "can we grab 30 min?" | `SCHEDULE_MEETING` | _(none)_ | Propose a time (calendar stubbed) |
| M. Cancelled project | "we're dropping X" | `REPLY` | `DELETE_TASK` | Related task no longer needed |
| N. Bulk volume | 80+ procedural messages | triaged | mixed | Proves real volume, not 5 toy messages |

**Style-matching:** drafts for A–G are written using the exec's past sent messages as voice
examples (learned per-exec).

**Priority signals:** explicit deadlines ("by Friday", "the 15th"), how long a thread has been
awaiting reply, and sender importance.

---

## 5. Demo scenario (what the video / live runtime shows)

1. **Dashboard** opens: total volume by channel, # awaiting reply, # overdue, pending
   approvals, average response time.
2. Open the **Series A** item (Case A): show the message, the **cross-channel link**
   (email + X DM), the RAG context pulled in, the recommended action, and the **style-matched
   draft**.
3. **Approve** the draft → it "sends" via the connector → thread marked answered → response
   time recorded.
4. Show the **Asana task** updated/linked from that action.
5. Open a **low-confidence** item (Case I): agent asks for context instead of drafting.
6. Show the **volume** view: dozens of messages triaged with recommended actions.
7. (If enabled) run the same request through the **Cursor/MCP agent** to show reuse.

This scenario is what the grader will click through, so every step must work on the deployed
runtime with a demo login (no OAuth required of the grader).

---

## 6. In scope vs out of scope

**In scope (build + deploy + demo):**
- Gmail + X + WhatsApp ingestion (done), normalized model, participants/timestamps/**attachments**, provenance.
- Cross-channel linking by topic/person/customer/project/decision.
- RAG over the **four sources**: communication history + Asana + user preferences + org knowledge.
- Triage + recommended action (two-dimension taxonomy above).
- Style-matched drafting (Claude, mock-able for dev).
- Asana `CREATE / UPDATE / COMPLETE / COMMENT / DELETE` linked to messages, with project/milestone.
- Approval flow + send + answered/response-time tracking.
- Dashboard UI. Deployment with a demo login.
- **Security/permissions:** token management per connected service, and a basic **per-user
  permission boundary** (the agent only touches accounts the exec is allowed to) — this is a
  graded access-boundary dimension, so it is in scope, not a stub.

**Out of scope (stub behind clean interfaces, documented):**
- LinkedIn / SMS / additional providers — interface exists; not implemented.
- Real calendar scheduling and delegation routing — actions exist; side effects stubbed.
- Multi-brand / multi-account org management.
- Production auth/permissions hardening (basic demo auth only).
- The AWS OpenSearch-scale RAG — we use a lightweight local vector store with the same shape.

Rationale: the assignment lists ~50 criteria describing the full product. In a few days we
prove the **core loop end-to-end on real-volume data**, which is what the scoring rewards, and
we make the cuts defensible by keeping every stub behind the real interface.

---

## 7. Mapping to the assignment acceptance criteria

- Multi-channel ingestion; threads, participants, timestamps, **attachments**, provenance → Section 2, Cases A–N.
- Modular connector architecture → `Connector` interface (LinkedIn/SMS = stubs).
- RAG over the **four sources** (comms history, Asana, user preferences, org knowledge) → Section 2.3.
- Recommend an action for every message → Section 3 (comm action + Asana op).
- Style-matched drafts → Section 4 style-matching.
- Link related messages across channels (topic/person/customer/project/decision) → Cases A, B, C.
- Connect to Asana **tasks, projects, milestones, and comments**; create/update → Section 3b.
- Approval before send → Section 2.8.
- Prompt for additional context when not confident → `NEEDS_INPUT` / `ASK_SENDER`.
- Track answered + response-time + <5min goal → Section 2.9, dashboard.
- Secure token management + user permission boundaries → Section 6 (in scope).
- Cursor-accessible agent (retrieve via RAG, recommend, draft, update Asana) → Section 5, step 7.
- UI dashboards (volume, status, overdue, approvals, channel breakdown, response time) → Section 5.

---

## 8. Open questions for sign-off
1. Action taxonomy — is the 7-action set right, or add/remove any?
2. Cases A–J — any real situation you want added or dropped?
3. Demo scenario order — does the 7-step flow match how you'd present it?

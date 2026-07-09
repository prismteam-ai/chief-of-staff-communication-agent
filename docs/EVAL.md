# Evaluation Harness

We build the evaluation **before** the brain. Everything wraps around one artifact set: the
**ontology** ([ONTOLOGY.md](./ONTOLOGY.md)) defines the world, the **competency questions**
below are what the system must answer, the **16 labeled scenarios** are the instance data, and
the **methods** answer the questions. The harness runs `method × scenario`, compares to ground
truth, and prints a scoreboard. We then build RAG + the brain *to move the numbers*.

Design rule (Grüninger & Fox): the knowledge layer is only correct if it answers its
competency questions. So these questions are simultaneously the ontology's acceptance test and
the eval harness.

---

## Competency questions and how each is scored

| # | Competency question | Method | Metric | Ground truth |
|---|---|---|---|---|
| Q1 | What needs my reply now, ranked by urgency? | graph + priority/deadline rules | ranking precision@k | `awaiting_reply`, `SCENARIO_META.priority` |
| Q2 | What's overdue vs the 5-min goal? | rules over timestamps | exact set | derived from timestamps |
| Q3 | What's waiting on someone else (stale outbound)? | graph (outbound, no reply) | recall | `stale-outbound` scenario |
| Q4 | Full context of this message? | **hybrid** retrieve | retrieval recall of known links | linked task/milestone + cross-channel msg |
| Q5 | Who is this person + our history? | graph (identity → messages) | recall | identity map |
| Q6 | What did I say before to them / on this topic? | vector (style corpus) | recall | owner sent messages |
| Q7 | Which threads are the same matter across channels? | graph edges + vector fallback | linking F1 | `cross_channel_links` |
| Q8 | Which task/milestone/project does this relate to? | hybrid | hit-rate@1 | `SCENARIO_META.task/milestone` |
| Q9 | What should I do? (action + Asana op) | brain over context | action accuracy, op accuracy | `SCENARIO_META.action/asana` |
| Q10 | Draft a reply in my style | brain + style pack | LLM-judge rubric (0–5) | owner style corpus |
| Q11 | When am I not confident — what do I ask? | confidence threshold | `NEEDS_INPUT` precision/recall | `counsel-terms`, ambiguous |
| Q12 | Dashboard: volume / status / approvals / response time | aggregate queries | exact counts | fixtures |

## Ground-truth sources

- **`scenario.json`** — the labeled truth:
  - `scenarios[]` with `action`, `asana`, `priority`, `hero`, `milestone`/`task`, `target`
  - `cross_channel_links` — expected cross-channel groupings
  - `awaiting_reply` — expected reply queue
  - `milestones`, `projects`, `contacts`, `team`
- Task/milestone links come from the curated tasks whose names map to scenario topics.

## Metrics, precisely

- **Action accuracy** = fraction of scenarios where predicted communication action ==
  `SCENARIO_META.action`. **Op accuracy** = same for the Asana op (family match, e.g.
  `UPDATE_TASK` vs `COMMENT_ON_MILESTONE`).
- **Retrieval recall@k** = of the items the ontology says are linked to a message (task,
  milestone, cross-channel message, sender history), how many appear in the top-k context pack.
- **Linking F1** = precision/recall of predicted cross-channel groups vs `cross_channel_links`.
- **NEEDS_INPUT precision/recall** = did the agent ask for help exactly when it should.
- **Draft quality** = an LLM-judge scores each hero draft 0–5 on: uses retrieved context,
  matches the owner's voice, correct action, no hallucinated facts. (Judge is a separate model
  call; skipped in keyless CI, run for the final report.)

## Determinism

- Dev + CI run with a **deterministic local embedding** (TF-IDF / hashing) and the **mock LLM**,
  so retrieval and action scores are reproducible and keyless.
- The **final report** re-runs drafting (Q10) and the judge with **real Claude** for a true
  quality read. Retrieval/action metrics stay identical either way.

## Harness output (scoreboard)

```
COMPETENCY EVAL — 16 scenarios
Q1 urgency ranking      P@5   0.80
Q4 context recall       @6    0.92
Q7 cross-channel link   F1    0.86
Q8 task/milestone hit   @1    0.75
Q9 action accuracy            14/16
Q9 asana-op accuracy          12/16
Q11 NEEDS_INPUT         P/R   1.00 / 1.00
Q10 draft quality (judge)     4.3 / 5     [real-LLM run]
------------------------------------------------
per-scenario table + failures listed
```

## How the harness runs

```
load ontology + build KB (graph + vector) from fixtures
for each competency question:
    for each scenario instance:
        run the method → prediction
        compare to ground truth → per-case score
aggregate → scoreboard + per-scenario failures
```

A **baseline** (rules-only, no RAG, no LLM) is scored first so every later improvement
(add graph, add vector, add brain) shows up as a measurable delta. This is the number we
iterate against and the evidence we show the grader.

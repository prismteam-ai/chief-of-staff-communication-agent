# Knowledge Layer — Ontology

The Chief of Staff's "centralized knowledge layer" is designed **competency-question-first**
(Grüninger & Fox): we first fix the questions the system must answer (see
[EVAL.md](./EVAL.md)), then define exactly the entities and relationships needed to answer
them — no more, no less. The same questions are the acceptance test for both the ontology and
the evaluation.

The layer is **hybrid**:
- a **graph** of entities and edges answers *relationship* questions (who is connected to what,
  which task a message relates to, which threads are the same matter) — precise and explainable;
- a **vector index** over text answers *meaning* questions (semantically related messages,
  style examples, org knowledge) — fuzzy and recall-oriented.

Engines are deliberately light: the graph is adjacency/link tables (in-memory or Postgres),
the vector index is a local embedding store for dev/eval (pgvector in production). Same
capabilities as Neo4j + OpenSearch, a fraction of the ops cost. This mirrors the kit's
`espeon` / `build-rag-systems` shape without its infrastructure.

---

## Entities

| Entity | Key attributes | Notes |
|---|---|---|
| `Person` | name, org, region, regional, role, is_owner | contact, team member, or the exec |
| `Identity` | value (email / @handle / phone), channel | belongs to a Person; resolves cross-channel identity |
| `Org` | name, type (investor / customer / vendor / …) | |
| `Message` | channel, timestamp, direction, subject, body, provenance | normalized; text is embedded |
| `Thread` | channel, subject | a single-channel conversation |
| `Topic` | key, title | a **matter/decision**, spans channels and people |
| `Project` | name | Asana project |
| `Task` | name, notes, due_on, completed, is_milestone, assignee | milestone = task with `is_milestone` |
| `Comment` | text, author | Asana story on a task |
| `Attachment` | filename, mime_type | on a Message |
| `Recommendation` | action, asana_op, priority, confidence | the agent's decision for a Message |
| `Draft` | text | suggested reply, in the owner's style |
| `Preference` | key, value | user preferences (voice, do-not-disturb, escalation rules) |
| `OrgFact` | text, source | organizational knowledge |

## Relationships (edges)

| Edge | From → To | Answers |
|---|---|---|
| `has_identity` | Person → Identity | same person across Gmail / X / WhatsApp |
| `sent_by` | Message → Person | who sent it |
| `in_thread` | Message → Thread | thread assembly |
| `part_of` | Thread → Topic | **cross-channel linking** |
| `about` | Message / Topic → Topic | topic membership |
| `relates_to` | Message / Topic → Task / Project / Milestone | comms ↔ work |
| `in_project` | Task / Milestone → Project | |
| `assigned_to` | Task → Person | |
| `on` | Comment → Task | |
| `works_at` | Person → Org | investor / customer / vendor context |
| `for` | Recommendation → Message | one decision per message |
| `proposes` | Recommendation → Action + AsanaOp | the taxonomy in the PRD |
| `replies_to` / `in_style_of` | Draft → Message / owner | style-matched drafting |

## Graph vs vector, by field

- **Graph edges** — everything in the table above. Deterministic, explainable, the source of
  truth for "linked by person / customer / project / decision".
- **Vector index** — the text of `Message.body`, the owner's sent messages (style corpus),
  `Preference`, and `OrgFact`. Used for semantic topic linking (when no explicit edge exists),
  style retrieval, and org-knowledge grounding.

## Retrieval contract (what the brain gets per message)

Given an incoming `Message`, the hybrid retriever returns a **context pack**:
0. **hard facts** — precise, authoritative statements built deterministically from the graph +
   Asana + company data + policy (sender identity/type, real prior-history count, cross-channel
   presence, linked task/milestone with due date + status, fundraise state, applicable policy).
   These are what the brain must trust and cite, distinct from the fuzzy retrieved text below.
1. thread history (`in_thread`)
2. sender profile + prior history (`sent_by` → Person → their Messages)
3. linked Task / Project / Milestone (`relates_to`, `in_project`)
4. cross-channel related messages (`part_of` Topic, + vector fallback)
5. style examples (vector over owner's sent messages)
6. relevant preferences / org facts (vector)

## Mapping to acceptance criteria

- "centralized knowledge layer" → this ontology.
- "RAG using communication history, Asana context, user preferences, organizational knowledge"
  → the four vector sources + the graph.
- "link related messages … same topic, person, customer, project, or decision" → the
  `part_of`, `relates_to`, `works_at`, `has_identity` edges.
- "connect communications to Asana tasks, projects, milestones, comments" → `relates_to`,
  `in_project`, `on`.

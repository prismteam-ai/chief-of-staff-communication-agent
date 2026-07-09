# Demo Video Script — Chief of Staff Communication Agent

**Target length:** 4–5 minutes. Record at 1080p. Keep the browser URL bar visible the whole
time (it proves this is a *hosted* app, not localhost — a hard grading gate).

**Live URL:** http://89.167.5.247:8090 · **Owner:** `owner` / `owner1234` · **Grader:** `demo` / `demo1234`

Open two browser tabs before you start:
1. Tab A — the app (http://89.167.5.247:8090)
2. Tab B — your real Asana workspace (app.asana.com), on the seeded projects

---

## 0:00 — Hook (15s)
> "This is a Chief of Staff agent. It pulls an executive's messages from every channel,
> drafts replies in their voice, links the work to Asana, and never sends without approval.
> It's deployed and live — you're looking at the hosted URL, not localhost."

**On screen:** point at the URL bar `http://89.167.5.247:8090`, then log in as **owner**.

## 0:15 — Dashboard / inbox (30s)
> "One unified inbox across Gmail, X, and WhatsApp — 147 messages from a real 'Series A
> closing week' scenario. It flags what's awaiting a reply and what's overdue."

**On screen:** show the inbox, the channel icons, the volume/overdue indicators.

## 0:45 — The core loop: pick a message (60s)
Pick the message from **Sarah Lin** about the **Series A term sheet**.
> "I open a message and the agent runs live. Watch it think: it retrieves context, checks
> hard facts, triages priority, decides the action, and drafts."

**On screen:** show the streamed **thoughts → tool calls → action**. Point out:
- the **recommendation** (action + priority),
- the linked **Asana task** it found ("Review Series A term sheet with counsel"),
- that this task is **real** — we'll confirm in Asana.

## 1:45 — Style-matched draft (45s)
> "The draft is written in the executive's voice. Style is learned from their sent mail, and
> I can pin explicit rules and examples."

**On screen:** open the **Style** page.
> "Here I've set the «Пиши, сокращай» info-style — short, facts over adjectives, no em dashes —
> plus example messages. These get injected into every draft."

Go back to the draft, point out it's concise and on-voice.

## 2:30 — Approval gate + REAL Asana write (60s)
> "Nothing sends automatically. I review, edit if needed, and approve."

**On screen:** click **Approve**. Then switch to **Tab B (Asana)** and refresh.
> "That approval just wrote to my real Asana workspace over the live API — here's the task,
> updated. This is real data, not a mock."

**On screen:** show the updated/commented task in real Asana. (This is the money shot — the
graded "real, functional outcome".)

## 3:30 — Connections + access boundary (45s)
**On screen:** open **Connections**.
> "Asana is connected to the real API; the other channels run on mocks by default so a grader
> never has to complete OAuth. Every channel is one `Connector` interface — adding a channel is
> implementing that interface."

Then log out, log in as **demo / demo1234**.
> "The demo/grader role is read-only. Approve and send are blocked server-side, not just hidden
> in the UI — that's the enforced permission boundary."

**On screen:** show that approve is disabled / returns forbidden for the demo user.

## 4:15 — Close (20s)
> "So: multi-channel ingestion, RAG-grounded recommendations, style-matched drafts, a hard
> approval gate, and a real Asana write — deployed and working. Setup and architecture are in
> SOLUTION.md. Thanks."

---

## Shot checklist (make sure each is on camera)
- [ ] URL bar showing the hosted address (not localhost)
- [ ] Login as owner
- [ ] Inbox with multiple channels + overdue/awaiting flags
- [ ] Agent streaming its reasoning on a real message
- [ ] Recommendation + linked real Asana task
- [ ] Style page with the pinned rules/examples
- [ ] Approve → the **real** Asana task changing (side-by-side tab)
- [ ] Connections: Asana=real, others=mock
- [ ] demo user is read-only (approve blocked)

## Tips
- Do one dry run first — the very first agent request rebuilds the KB and is slower; after that
  it's snappy. Record after the warm-up call.
- If you narrate in Russian, keep the on-screen app in English; the script beats still map 1:1.
- Keep it under 5 minutes. The grader rewards a tight, working demo over a long tour.

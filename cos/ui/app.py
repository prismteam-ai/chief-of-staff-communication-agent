"""Gradio app: inspect the knowledge base for any message.

Three tabs:
  • Analyze — pick a scenario (or type a custom message) and see the hard facts, the baseline
    recommendation, the retrieved context, and the graph neighborhood.
  • Vector search — query the vector index directly (messages / tasks / style / prefs / facts).
  • Graph — explore a person's ego-network (person ↔ messages ↔ tasks).

Requires the provider mock reachable at the configured base URLs. Locally: run
`uvicorn cos.mocks.app:app --port 8900` first. In Docker: the `mocks` service.

Run: ``python -m cos.ui.app``
"""

from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import gradio as gr
import matplotlib.pyplot as plt
import networkx as nx
from PIL import Image

from cos.eval import methods
from cos.kb.build import build_kb
from cos.models import Channel, Direction, Message, Participant

_KB = None


def kb():
    global _KB
    if _KB is None:
        _KB = build_kb()
    return _KB


# ---- helpers ----------------------------------------------------------------
def _scenario_map():
    from cos.eval import ground_truth as gt
    out = {}
    for c in gt.cases(kb()):
        if c.trigger:
            out[f"{c.key}  ·  {c.contact}  ·  {c.trigger.channel.value}"] = c.trigger
    return out


def _custom_message(sender: str, channel: str, body: str) -> Message:
    sender = sender.strip()
    is_email = "@" in sender and "." in sender.split("@")[-1]
    p = Participant(id=f"in:{sender}", name=sender,
                    email=sender if is_email else None,
                    handle=None if is_email else sender)
    return Message(id="ui:custom", channel=Channel(channel), thread_id="ui:custom",
                   sender=p, timestamp=__import__("datetime").datetime.now(
                       __import__("datetime").timezone.utc),
                   body=body, direction=Direction.incoming)


def _ego_graph(m: Message) -> Image.Image:
    k = kb()
    pack = k.retriever.context_pack(m)
    g = nx.DiGraph()
    who = m.sender.name
    g.add_node(who, kind="person")
    g.add_node("MSG", kind="msg")
    g.add_edge(who, "MSG", label="sent")
    for i, x in enumerate(pack.cross_channel[:3]):
        n = f"{x.channel.value}\n#{i+1}"
        g.add_node(n, kind="msg")
        g.add_edge(who, n, label="also")
    for t in pack.related_tasks[:3]:
        n = t.name[:22]
        g.add_node(n, kind="task")
        g.add_edge("MSG", n, label="relates")
    colors = {"person": "#4C78A8", "msg": "#72B7B2", "task": "#E45756"}
    node_colors = [colors[g.nodes[n]["kind"]] for n in g.nodes]
    fig, ax = plt.subplots(figsize=(6, 4))
    pos = nx.spring_layout(g, seed=1, k=1.2)
    nx.draw(g, pos, ax=ax, with_labels=True, node_color=node_colors, node_size=1600,
            font_size=7, font_color="white", edge_color="#999")
    nx.draw_networkx_edge_labels(g, pos, ax=ax,
                                 edge_labels=nx.get_edge_attributes(g, "label"),
                                 font_size=6)
    ax.set_axis_off()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=120)
    plt.close(fig)
    buf.seek(0)
    return Image.open(buf)


def _fmt_pack(pack) -> str:
    def block(title, items):
        if not items:
            return f"**{title}:** _(none)_\n"
        return f"**{title}:**\n" + "\n".join(f"- {i}" for i in items) + "\n"
    return "\n".join([
        block("Related Asana tasks",
              [f"{t.name} ({'milestone' if t.is_milestone else 'task'}"
               f"{', due ' + t.due_on if t.due_on else ''})" for t in pack.related_tasks]),
        block("Cross-channel (same person)",
              [f"[{x.channel.value}] {x.body[:70]}" for x in pack.cross_channel]),
        block("Sender history", [f"[{x.channel.value}] {x.body[:60]}"
                                 for x in pack.sender_history[:4]]),
        block("Style examples", [s[:70] for s in pack.style_examples]),
        block("Preferences", pack.preferences),
        block("Org facts", pack.org_facts),
    ])


# ---- callbacks --------------------------------------------------------------
def analyze(use_custom, scenario, sender, channel, body):
    try:
        m = _custom_message(sender, channel, body) if use_custom \
            else _scenario_map()[scenario]
    except Exception as e:
        return f"⚠️ {e}", "", "", None
    k = kb()
    pack = k.retriever.context_pack(m)
    rec = methods.recommend(m, pack, k)
    facts = "### Hard facts\n" + "\n".join(f"- {f}" for f in pack.facts)
    reco = (f"### Recommendation (baseline)\n"
            f"- **Action:** `{rec.action.value}`\n"
            f"- **Asana op:** `{rec.asana_op.value}`\n"
            f"- **Priority:** `{rec.priority.value}`\n"
            + (f"- **Target:** {rec.target}\n" if rec.target else ""))
    return facts, reco, "### Retrieved context\n" + _fmt_pack(pack), _ego_graph(m)


def vector_search(query, kind, k):
    hits = kb().vector.search(query, k=int(k), kind=None if kind == "all" else kind)
    return [[h.get("name") or h["text"][:80], h.get("kind"), round(h["score"], 3)]
            for h in hits]


def run_agent(scenario):
    """Run the multi-agent brain (gpt-5.1) on a scenario and show the full trace."""
    try:
        from cos.agents import brain
        m = _scenario_map()[scenario]
        r = brain.run(m, dry_run=True)
    except Exception as e:  # noqa: BLE001
        return f"⚠️ {e}"
    rec = r.recommendation
    lines = [f"### Agent result — {scenario}",
             f"**Action:** `{rec.action.value}`  ·  **Asana op:** `{rec.asana_op.value}`"
             + (f"  ·  **target:** {rec.target}" if rec.target else ""),
             f"**Priority:** `{rec.priority.value}`  ·  _{rec.rationale}_", ""]
    if r.delegation:
        lines += [f"**A2A delegation → `{r.delegation.role}`** ({r.delegation.status})",
                  f"> {r.delegation.response or '(no role agent running)'}", ""]
    if r.draft:
        lines += ["**Draft (in your style):**", f"> {r.draft.text}", ""]
    lines += ["**Trace:**"] + [f"- {t}" for t in r.trace]
    lines += ["", "**Hard facts used:**"] + [f"- {f}" for f in r.facts_used[:4]]
    return "\n".join(lines)


def graph_person(name):
    k = kb()
    p = k.graph.find_person(name)
    if not p:
        return f"No person named {name}", None
    rel = k.retriever.relationships.get(name, {})
    msgs = [m for m in k.messages if (k.graph.person_for(m) or None)
            and k.graph.person_for(m).name == name]
    chans = sorted({m.channel.value for m in msgs})
    md = (f"### {p.name}\n- **Type:** {rel.get('type','contact')}\n"
          f"- **Org:** {p.org or rel.get('org','—')}\n"
          f"- **Region:** {p.region or '—'}"
          f"{' (regional)' if p.regional else ''}\n"
          f"- **Note:** {rel.get('note','—')}\n"
          f"- **Messages:** {len(msgs)} across {', '.join(chans) or '—'}\n")
    img = _ego_graph(msgs[0]) if msgs else None
    return md, img


def build_ui():
    channels = [c.value for c in Channel]
    people = sorted(p.name for p in kb().graph.persons.values() if not p.is_owner)
    scen = list(_scenario_map())

    with gr.Blocks(title="Chief of Staff — RAG explorer") as demo:
        gr.Markdown("# Chief of Staff — RAG + Graph explorer\n"
                    "Inspect the hybrid knowledge base for any message.")
        with gr.Tab("Analyze a message"):
            use_custom = gr.Checkbox(label="Type a custom message", value=False)
            scenario = gr.Dropdown(scen, label="Scenario", value=scen[0] if scen else None)
            with gr.Row(visible=False) as custom_row:
                sender = gr.Textbox(label="Sender (email / @handle / phone)")
                channel = gr.Dropdown(channels, label="Channel", value="gmail")
            body = gr.Textbox(label="Custom body", visible=False, lines=3)
            use_custom.change(lambda v: (gr.update(visible=v), gr.update(visible=v),
                                         gr.update(visible=not v)),
                              use_custom, [custom_row, body, scenario])
            btn = gr.Button("Analyze", variant="primary")
            with gr.Row():
                facts = gr.Markdown()
                reco = gr.Markdown()
            ctx = gr.Markdown()
            graph_img = gr.Image(label="Graph neighborhood", type="pil")
            btn.click(analyze, [use_custom, scenario, sender, channel, body],
                      [facts, reco, ctx, graph_img])
        with gr.Tab("Agent (multi-agent brain)"):
            gr.Markdown("Runs the LangGraph brain on gpt-5.1: RAG → triage → decide → "
                        "draft / A2A delegation. Needs the provider mock + role agents running.")
            ascn = gr.Dropdown(scen, label="Scenario", value=scen[0] if scen else None)
            abtn = gr.Button("Run agent", variant="primary")
            aout = gr.Markdown()
            abtn.click(run_agent, ascn, aout)
        with gr.Tab("Vector search"):
            q = gr.Textbox(label="Query")
            kind = gr.Dropdown(["all", "message", "task", "style", "pref", "orgfact"],
                               value="all", label="Kind")
            topk = gr.Slider(1, 10, value=5, step=1, label="Top-k")
            vbtn = gr.Button("Search")
            vout = gr.Dataframe(headers=["result", "kind", "score"], label="Results")
            vbtn.click(vector_search, [q, kind, topk], vout)
        with gr.Tab("Graph explorer"):
            person = gr.Dropdown(people, label="Person", value=people[0] if people else None)
            gbtn = gr.Button("Explore")
            gmd = gr.Markdown()
            gimg = gr.Image(label="Ego network", type="pil")
            gbtn.click(graph_person, person, [gmd, gimg])
    return demo


def main() -> None:
    import os

    from cos.agents.a2a import client
    from cos.agents.a2a.launch import role_agents
    client.install()   # wire A2A delegation
    # In Docker the role agents are separate services (A2A_*_URL set); locally start them here.
    if os.environ.get("A2A_ENGINEERING_URL"):
        build_ui().launch(server_name="0.0.0.0", server_port=7860)
    else:
        with role_agents():
            build_ui().launch(server_name="0.0.0.0", server_port=7860)


if __name__ == "__main__":
    main()

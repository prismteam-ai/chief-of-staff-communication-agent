"""Validate the fixtures and ground-truth labels themselves (catches data drift).

These run without a server — they read the generated fixtures directly and assert the
scenario labels reference real entities and valid enum values, so the eval can be trusted.
"""

from cos.fixtures import load
from cos.kb.ontology import Action, AsanaOp

SCEN = load("scenario.json")
ASANA = load("asana.json")

TASK_NAMES = [t["name"] for t in ASANA["tasks"]]
PROJECT_GIDS = {p["gid"] for p in ASANA["projects"]}


def test_scenario_actions_are_valid_enums():
    actions = {a.value for a in Action}
    ops = {o.value for o in AsanaOp}
    for s in SCEN["scenarios"]:
        assert s["action"] in actions, s
        if s.get("asana"):
            assert s["asana"] in ops, s


def test_scenario_linked_work_exists():
    for s in SCEN["scenarios"]:
        for name in (s.get("milestone"), s.get("task")):
            if name:
                assert any(name.lower() in t.lower() or t.lower() in name.lower()
                           for t in TASK_NAMES), f"{s['key']} -> {name}"


def test_cross_channel_links_actually_span_channels():
    for link in SCEN["cross_channel_links"]:
        if "proc" not in link["topic"]:
            assert len(link["channels"]) > 1, link


def test_relationships_cover_named_contacts():
    named = {c["name"] for c in SCEN["contacts"][:16]}
    assert named <= set(SCEN["relationships"])


def test_milestones_are_flagged_and_in_projects():
    ms = [t for t in ASANA["tasks"] if t.get("is_milestone")]
    assert len(ms) == 7
    for t in ASANA["tasks"]:
        for p in t.get("projects", []):
            assert p["gid"] in PROJECT_GIDS


def test_contacts_have_all_channel_identities():
    for c in SCEN["contacts"]:
        assert c["email"] and c["x_handle"] and c["whatsapp"]


def test_every_hero_has_ground_truth():
    heroes = [s for s in SCEN["scenarios"] if s.get("hero")]
    assert len(heroes) >= 3
    assert all(s.get("priority") for s in SCEN["scenarios"])

"""End-to-end ingestion demo.

Pulls messages from every connector (real SDKs → mock servers), normalizes them, resolves
each sender to a known contact, flags threads awaiting the exec's reply, and shows a
person who appears on more than one channel (the basis for cross-channel linking).

Run (mock server must be up): ``python -m cos.scripts.ingest``
"""

from __future__ import annotations

from collections import defaultdict

from cos.connectors import all_connectors
from cos.fixtures import load
from cos.models import Direction, Message


def _identity_index() -> dict[str, str]:
    """Map every known channel handle/email/phone -> canonical contact name."""
    idx: dict[str, str] = {}
    for c in load("scenario.json")["contacts"]:
        idx[c["email"].lower()] = c["name"]
        idx[f"@{c['x_handle']}".lower()] = c["name"]
        idx[c["whatsapp"].lstrip("+")] = c["name"]
    return idx


def resolve(msg: Message, idx: dict[str, str]) -> str:
    h = (msg.sender.handle or "").lower().lstrip("+")
    e = (msg.sender.email or "").lower()
    return idx.get(e) or idx.get(f"@{h}") or idx.get(h) or msg.sender.name


def main() -> None:
    idx = _identity_index()
    all_msgs: list[Message] = []
    per_channel: dict[str, int] = {}

    for conn in all_connectors():
        msgs = conn.list_incoming()
        per_channel[conn.name] = len(msgs)
        all_msgs.extend(msgs)

    # threads awaiting a reply: latest message in the thread is incoming
    threads: dict[tuple, list[Message]] = defaultdict(list)
    for m in all_msgs:
        threads[(m.channel.value, m.thread_id)].append(m)
    awaiting = [ms for ms in threads.values()
                if sorted(ms, key=lambda x: x.timestamp)[-1].direction
                == Direction.incoming]

    # cross-channel: same person seen on >1 channel
    by_person: dict[str, set] = defaultdict(set)
    for m in all_msgs:
        by_person[resolve(m, idx)].add(m.channel.value)
    multi = {p: ch for p, ch in by_person.items() if len(ch) > 1}

    print("=" * 60)
    print("CHIEF OF STAFF — INGESTION")
    print("=" * 60)
    for ch, n in per_channel.items():
        print(f"  {ch:10s}: {n:4d} messages")
    print(f"  {'TOTAL':10s}: {len(all_msgs):4d} messages "
          f"across {len(threads)} threads")
    print(f"\n  Threads awaiting your reply: {len(awaiting)}")
    for ms in sorted(awaiting, key=lambda x: x[-1].timestamp, reverse=True)[:5]:
        last = sorted(ms, key=lambda x: x.timestamp)[-1]
        who = resolve(last, idx)
        print(f"    - [{last.channel.value:8s}] {who:16s} "
              f"{(last.subject or last.body)[:52]}")

    print(f"\n  People on more than one channel (cross-channel linking): {len(multi)}")
    for person, chans in list(multi.items())[:5]:
        print(f"    - {person:16s} -> {', '.join(sorted(chans))}")

    print(f"\n  Provenance sample: {all_msgs[0].provenance}")


if __name__ == "__main__":
    main()

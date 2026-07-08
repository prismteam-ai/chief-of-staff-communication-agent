"""Seed org knowledge + user preferences into the RAG index (committed & reproducible)."""
from cos_agent.rag import index_knowledge

DOCS = [
    ("preference", "reply-style",
     "Jordan Reeve's reply style: concise, warm, action-first. Short sentences. Names the decision, "
     "gives the number, sets the deadline. Signs emails informally."),
    ("preference", "triage-rules",
     "Triage preferences: customers and the board come first; press can wait a day; vendor upsells are "
     "polite-declined unless capacity is a real constraint; investor intros get a yes if warm."),
    ("org", "atlas-account",
     "Atlas Corp is Meridian Labs' largest enterprise customer. FY27 renewal in progress; SLA 99.9% with "
     "credits capped at 10% of monthly fees agreed; QBRs quarterly starting October. Contact: Priya "
     "Natarajan (VP Procurement)."),
    ("org", "meridian-facts",
     "Meridian Labs: applied-AI infrastructure company, ~40 people. CEO Jordan Reeve. Q2 board meeting "
     "Monday July 13, 2026. VP Eng offer out at L7. Second brand: Halcyon Studio (design side-business)."),
    ("org", "products",
     "Products: Meridian Core (workflow API) and Meridian Insights (analytics). Known constraint: API "
     "rate limits are being raised in the Q3 roadmap; data-residency rollout in progress."),
]

if __name__ == "__main__":
    for source_type, source_id, content in DOCS:
        index_knowledge(source_type, source_id, content)
        print(f"indexed {source_type}/{source_id}")

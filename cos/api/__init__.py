"""HTTP API for the Chief of Staff app frontend.

A thin FastAPI layer over the existing engine (``build_kb``, ``brain``, connectors,
``roles``): inbox + per-message context, a step-by-step SSE agent stream, the approval →
send seam, and a Connections surface. Auth is verified here (shared JWT with the Next.js
frontend) and the owner-only boundary is enforced server-side.
"""

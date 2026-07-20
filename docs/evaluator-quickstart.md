# Chief evaluator quickstart

Chief helps you review communication threads, understand a recommended next
step, and keep any proposed action behind a human approval boundary.

1. Sign in with the evaluator account and confirm the banner says the data is a
   deterministic, non-PII fixture and external effects are disabled.
2. Open **Recommended**. Each visible action was returned by the hosted service
   for the exact thread shown; open a row to review its reason and citations.
3. In the thread, read the draft and citations. Choose **Create concise
   revision** only when the facts are correct. This prepares an exact revision
   for review but does not contact anyone.
4. Open **Approvals**. It shows only proposals prepared during your current
   tab since Chief was loaded and rechecks each proposal with the hosted
   service. Open a proposal to inspect its read-only status.
5. Approve only after checking the exact revision. In this evaluator, approval
   records a durable `effect_disabled` receipt; it never sends a message or
   changes an external provider.

If the Approvals count is larger than the visible list, this is expected: the
service currently exposes a server-wide count but no API that lists every
proposal ID. Chief does not fill that gap with sample cards.

# Chief of Staff Communication Agent

## Context

The current Chief of Staff agent is not yet useful enough for executive operations. Setup is difficult, communication coverage is limited mainly to Gmail, and the system does not yet manage messages across all communication channels, brands, and workstreams. Executives need a unified agent that can understand communication context, recommend actions, draft responses in each user’s style, connect decisions back to Asana, and help ensure every communication is answered in less than five minutes.

## Description

Build a Chief of Staff Communication Agent that connects all major communication channels, uses RAG to understand user and organizational context, recommends the next action for each message, drafts style-matched responses, links communications to the correct Asana work, and provides a UI and Cursor-accessible agent workflow for final approval and additional context.

## Acceptance Criteria
- Support setup that is simple enough for non-technical users.
- Support email integrations across all required brands and accounts.
- Support Gmail as one email provider.
- Support additional email providers beyond Gmail.
- Support SMS integration.
- Support WhatsApp integration.
- Support X integration.
- Support LinkedIn integration.
- Support future communication channels through a modular connector architecture.
- Ingest messages, threads, metadata, participants, timestamps, and attachments where available.
- Consolidate all communication data into a centralized knowledge layer.
- Build a RAG layer using communication history, Asana context, user preferences, and organizational knowledge.
- Preserve conversation history across connected platforms.
- Learn and apply each user’s response style.
- Recommend an action for every incoming communication.
- Draft suggested replies using relevant context and the user’s communication style.
- Link related messages across channels when they belong to the same topic, person, customer, project, or decision.
- Connect communications clearly to relevant Asana tasks, projects, milestones, and comments.
- Create or update Asana tasks when a communication requires follow-up.
- Prompt the user for final approval before sending a drafted response.
- Prompt the user for additional context when the agent cannot confidently respond.
- Track whether each communication has been answered.
- Support the goal of answering every communication in less than five minutes.
- Provide a UI showing communication volume, response status, overdue messages, pending approvals, channel breakdown, and response-time metrics.
- Provide a UI view for recommended actions by communication.
- Provide a UI view for drafted responses awaiting approval.
- Provide an agent that can be used directly in Cursor.
- Allow the Cursor agent to retrieve communication context through the RAG layer.
- Allow the Cursor agent to recommend actions, draft responses, and update Asana.
- Securely authenticate and manage tokens for all connected services.
- Enforce user-specific permission boundaries across connected accounts.
- Demonstrate end-to-end ingestion from multiple channels.
- Demonstrate RAG-backed retrieval across communication and Asana context.
- Demonstrate recommended actions for incoming communications.
- Demonstrate style-matched draft replies.
- Demonstrate user approval before response delivery.
- Demonstrate Asana task creation or update from a communication.
- Document setup instructions for the Chief of Staff Communication Agent.
- Confirm the solution is reusable within the existing soofi-xyz agent ecosystem.

## Reference
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)

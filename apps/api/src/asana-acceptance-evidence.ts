import { createHash } from 'node:crypto';

import { z } from 'zod';

import { sha256Schema } from '@chief/contracts';

/**
 * Build-time copy of the committed controlled Asana live acceptance receipt.
 *
 * Source of truth: docs/evidence/asana-controlled-live-acceptance-20260719.md.
 * The colocated asana-acceptance-evidence.test.ts enforces byte-for-byte
 * (LF-normalized) parity with that committed document and the absence of
 * credential-shaped values, so this public read-only surface can never drift
 * from the reviewed evidence.
 */
const committedEvidenceMarkdown = `# Controlled Asana live acceptance — 2026-07-19

This evidence is separate from the public evaluator runtime, which remains
\`effect_disabled\`. It proves the production Asana connector against one
explicitly authorized assessment workspace/project and marker. The acceptance
CLI emits no credential, name, description, note, URL, email, or raw provider
body; only bounds, counts, hashes, provider request methods/statuses, GIDs, and
validated outcomes appear below.

## Result

- First run: \`pass\`, complete bounded enumeration, exactly one \`POST 201\`, one
  precondition-bound \`PUT 200\`, \`created_then_updated\`, and two verified direct
  reads.
- Immediate replay: \`pass\`, the task set increased from four to five, the exact
  marker resolved as \`already_completed\`, and both dispatch counts were zero.
- Both runs used \`maxItems=20\`, \`maxPages=2\`, a 60-second overall deadline, and
  no retries.
- Credential ingress remained file-only through the ignored operator config.
  No credential value was placed on the command line, in this repository, or
  in the evidence.

## Redacted CLI evidence — create and update

\`\`\`json
{
  "schemaVersion": "1",
  "mode": "controlled_mutation_acceptance",
  "status": "pass",
  "issueCodes": [],
  "observedAt": "2026-07-19T16:10:30.397Z",
  "bounds": {
    "maxItems": 20,
    "maxPages": 2,
    "hardMaxItems": 50,
    "hardMaxPages": 3,
    "overallDeadlineMilliseconds": 60000,
    "retries": false
  },
  "scopes": {
    "workspaceGid": "1216622907792348",
    "projectGid": "1216621068176861"
  },
  "choices": {
    "workspaceGids": ["1216622907792348"],
    "projectGids": ["1216621068176861"]
  },
  "observed": {
    "workspaceCount": 1,
    "projectCount": 1,
    "taskCount": 4,
    "connectorFactCount": 5,
    "complete": true
  },
  "evidence": {
    "workspaceSetHash": "508714992779061e2231f2cf70c7f9a852157f68f5ab87035c1b40e0715c88fa",
    "projectSetHash": "0e7a51c702f7aecfa232fca1b7dce4f732cdad4908aa5cf9a7dca05670ce9b0c",
    "taskSetHash": "c5e56cd5b80d00443fbb4c72fd57e30fdeda3237625c96744633c10607d654fb",
    "connectorFactSetHash": "31ea873d4e22fc21a6b565b50d58b11eb7a940b389212cb9094b318db0ad54f2",
    "providerResponseSetHash": "81843ae213e74e791ccde36c0eacdf347b8497ceda7c42899ec0bc4e86535c55",
    "requests": [
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "POST", "status": 201 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "PUT", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 }
    ]
  },
  "mutation": {
    "authorizationIdHash": "35f7fbd12aa5db22487d759ec5fb09e685b677e2073ce99ab525180d3c0c4bf6",
    "markerHash": "28b5cc9d871c550f81bf7b8f4ff0d9afa0a4b23b4b56c53f2959e47b2924815f",
    "taskGid": "1216684811338799",
    "recoveryState": "created_then_updated",
    "createDispatchCount": 1,
    "updateDispatchCount": 1,
    "createOutcome": "accepted",
    "updateOutcome": "accepted",
    "verifiedReadCount": 2,
    "createOperationIdHash": "db22d50cf86be15215ea3fab362a320f4b6bc87183afd4394d9314b3b6c2483b",
    "updateOperationIdHash": "0d5c50154df5b3b6ac2bde1d53cdcc3f6e17057bf34fc9a8dfd424bc6dc0b121"
  }
}
\`\`\`

## Redacted CLI evidence — immediate replay

\`\`\`json
{
  "schemaVersion": "1",
  "mode": "controlled_mutation_acceptance",
  "status": "pass",
  "issueCodes": [],
  "observedAt": "2026-07-19T16:10:47.347Z",
  "bounds": {
    "maxItems": 20,
    "maxPages": 2,
    "hardMaxItems": 50,
    "hardMaxPages": 3,
    "overallDeadlineMilliseconds": 60000,
    "retries": false
  },
  "scopes": {
    "workspaceGid": "1216622907792348",
    "projectGid": "1216621068176861"
  },
  "choices": {
    "workspaceGids": ["1216622907792348"],
    "projectGids": ["1216621068176861"]
  },
  "observed": {
    "workspaceCount": 1,
    "projectCount": 1,
    "taskCount": 5,
    "connectorFactCount": 6,
    "complete": true
  },
  "evidence": {
    "workspaceSetHash": "508714992779061e2231f2cf70c7f9a852157f68f5ab87035c1b40e0715c88fa",
    "projectSetHash": "0e7a51c702f7aecfa232fca1b7dce4f732cdad4908aa5cf9a7dca05670ce9b0c",
    "taskSetHash": "06908939306ec600c88e5b2e78ef85084312bfbffcdf91be38d513672ce7521b",
    "connectorFactSetHash": "5cbec41f579be52c7ccbc3ecbdbd1ead5ef539e896956cfbd873e3e419c2afbe",
    "providerResponseSetHash": "a7079829def21895b0a7f3d1c2ade66b6f2409b137661c348e47eade97b2c285",
    "requests": [
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 },
      { "method": "GET", "status": 200 }
    ]
  },
  "mutation": {
    "authorizationIdHash": "35f7fbd12aa5db22487d759ec5fb09e685b677e2073ce99ab525180d3c0c4bf6",
    "markerHash": "28b5cc9d871c550f81bf7b8f4ff0d9afa0a4b23b4b56c53f2959e47b2924815f",
    "taskGid": "1216684811338799",
    "recoveryState": "already_completed",
    "createDispatchCount": 0,
    "updateDispatchCount": 0,
    "createOutcome": "previously_accepted",
    "updateOutcome": "previously_accepted",
    "verifiedReadCount": 1
  }
}
\`\`\`

## Reproduction

Build \`@chief/work-management-asana\`, then follow the bounded controlled command
in [the Asana provider guide](../providers/asana.md#exact-node-22-operator-commands)
with the ignored credential and authorization file paths. Reusing this marker
must continue to produce \`already_completed\` with zero dispatches; use a fresh,
separately authorized marker only when a new write proof is explicitly needed.
`;

export const asanaAcceptanceEvidenceDocumentPath =
  'docs/evidence/asana-controlled-live-acceptance-20260719.md';

export const asanaAcceptanceEvidenceMarkdown =
  committedEvidenceMarkdown.replaceAll('\r\n', '\n');

export const asanaAcceptanceEvidenceSha256 = createHash('sha256')
  .update(asanaAcceptanceEvidenceMarkdown, 'utf8')
  .digest('hex');

export const asanaAcceptanceEvidenceResultSchema = z.object({
  documentPath: z.literal(asanaAcceptanceEvidenceDocumentPath),
  contentType: z.literal('text/markdown'),
  sha256: sha256Schema,
  markdown: z.string().min(1),
});

export type AsanaAcceptanceEvidenceResult = z.infer<
  typeof asanaAcceptanceEvidenceResultSchema
>;

export function createAsanaAcceptanceEvidenceResult(): AsanaAcceptanceEvidenceResult {
  return asanaAcceptanceEvidenceResultSchema.parse({
    documentPath: asanaAcceptanceEvidenceDocumentPath,
    contentType: 'text/markdown',
    sha256: asanaAcceptanceEvidenceSha256,
    markdown: asanaAcceptanceEvidenceMarkdown,
  });
}

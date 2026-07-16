/**
 * Runtime environment contract for the API Lambda (Task 6). Read from `process.env` once — same
 * "non-secret config knob or a Secrets Manager ARN, never a secret literal" discipline as
 * `apps/agent-handler/src/env.ts` (design.md §10, §12).
 */
export interface ApiRuntimeEnv {
  readonly region: string;
  readonly communicationsTableName: string;
  readonly accountsTableName: string;
  /**
   * The agent queue `supplyContext` re-enqueues a communication to after persisting supplied
   * context (Task 6 review fix — see `agent-trigger.ts` and `approval-service.ts#supplyContext`).
   * Empty when the agent stack isn't wired for this deploy; `ApprovalService` degrades to a clear
   * `IllegalActionError` rather than a crash, same posture as `connectorFor` returning `undefined`.
   */
  readonly agentQueueUrl: string;
  /** Task 10 feedback loop: style-profiles table (`sourceCount` bump) and the RAG domain endpoint
   * (new sent_style exemplar indexing). Empty -> `routers/index.ts` wires no `styleFeedbackHook`,
   * and `ApprovalService.approveDraft` runs exactly as it did before Task 10 (see that service's
   * `feedBackStyleExemplarIsolated` doc comment: a no-op, not an error, when unwired). */
  readonly styleProfilesTableName: string;
  readonly ragDomainEndpoint: string;
  /** Task 9 WhatsApp inbound webhook: the shared dedupe table (`IngestStack`'s DedupeTable) and the
   * agent queue trigger. Empty -> `whatsapp-webhook-handler.ts`'s `requireEnv` throws a clear error
   * at first request rather than the Lambda silently no-op'ing. */
  readonly dedupeTableName: string;
  /** The exact public URL Twilio is configured to POST inbound webhooks to — MUST match the Twilio
   * console/sandbox config exactly (scheme+host+path), since it is part of the signed data
   * (`verifyTwilioSignature`). Empty in local/test contexts that never verify signatures for real. */
  readonly whatsappWebhookUrl: string;
  /** Task 11: per-user MCP token table (`tokenHash` PK) — `routers/mcp.ts`'s token issuance/
   * verification. Empty -> `routers/index.ts`'s `mcpAuthService()` throws a clear error at first
   * request, same posture as the other required-table checks in this file. */
  readonly mcpTokensTableName: string;
  /** Task 8.5: Secrets Manager id holding the demo dashboard login credential(s) — a JSON array of
   * `{ username, passwordHash, userId }` (see `dashboard-login-service.ts#DashboardCredential`;
   * `passwordHash` is the SHA-256 digest of the plaintext demo password, never the password
   * itself). Empty -> `routers/index.ts`'s `dashboardLoginService()` loads zero credentials, so
   * every `login` call fails closed with `DashboardLoginInvalidError` rather than crashing — same
   * "degrade to a clear, closed failure" posture the other optional-dependency checks in this file
   * use. Defaults to `cos/dashboard-login`, overridable for local/test contexts. */
  readonly dashboardLoginSecretId: string;
}

export function loadApiRuntimeEnv(source: NodeJS.ProcessEnv = process.env): ApiRuntimeEnv {
  return {
    region: source.AWS_REGION?.trim() || 'us-east-2',
    communicationsTableName: source.COMMUNICATIONS_TABLE_NAME?.trim() ?? '',
    accountsTableName: source.ACCOUNTS_TABLE_NAME?.trim() ?? '',
    agentQueueUrl: source.AGENT_QUEUE_URL?.trim() ?? '',
    styleProfilesTableName: source.STYLE_PROFILES_TABLE_NAME?.trim() ?? '',
    ragDomainEndpoint: source.RAG_DOMAIN_ENDPOINT?.trim() ?? '',
    dedupeTableName: source.DEDUPE_TABLE_NAME?.trim() ?? '',
    whatsappWebhookUrl: source.WHATSAPP_WEBHOOK_URL?.trim() ?? '',
    mcpTokensTableName: source.MCP_TOKENS_TABLE_NAME?.trim() ?? '',
    dashboardLoginSecretId: source.DASHBOARD_LOGIN_SECRET_ID?.trim() || 'cos/dashboard-login',
  };
}

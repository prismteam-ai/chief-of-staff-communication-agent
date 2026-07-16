/**
 * Runtime environment contract for the API Lambda (Task 6). Read from `process.env` once — same
 * "non-secret config knob or a Secrets Manager ARN, never a secret literal" discipline as
 * `apps/agent-handler/src/env.ts` (design.md §10, §12).
 */
export interface ApiRuntimeEnv {
  readonly region: string;
  readonly communicationsTableName: string;
  readonly accountsTableName: string;
}

export function loadApiRuntimeEnv(source: NodeJS.ProcessEnv = process.env): ApiRuntimeEnv {
  return {
    region: source.AWS_REGION?.trim() || 'us-east-2',
    communicationsTableName: source.COMMUNICATIONS_TABLE_NAME?.trim() ?? '',
    accountsTableName: source.ACCOUNTS_TABLE_NAME?.trim() ?? '',
  };
}

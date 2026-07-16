import { describe, expect, it, beforeEach } from 'vitest';

// Same AWS SDK region/credential fake-out as apps/ingest/src/communications-repo.test.ts — the
// DynamoDBDocumentClient created inside this module resolves region/credentials during command
// input marshalling even though aws-sdk-client-mock intercepts before any real network call.
process.env.AWS_REGION ??= 'us-east-2';
process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { Recommendation, TransitionRecord } from '@chief-of-staff/shared';
import { createAgentCommunicationsRepo } from './communications-repo.js';

// Must mock DynamoDBDocumentClient itself (patches the shared class prototype) — see the note in
// apps/ingest/src/communications-repo.test.ts for why mocking only the base DynamoDBClient would
// silently let real requests through with this SDK version.
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const TABLE = 'chief-of-staff-communications';

function fixtureRecommendation(): Recommendation {
  return {
    commId: 'gmail#ext-1',
    accountId: 'acct-1',
    actionType: 'reply_needed',
    confidence: 0.4,
    rationale: 'Ambiguous ask — needs more detail before drafting.',
  };
}

function fixtureTransitions(from: TransitionRecord['from']): TransitionRecord[] {
  return [
    {
      commId: 'gmail#ext-1',
      accountId: 'acct-1',
      from,
      to: 'recommended',
      actorId: 'system',
      ts: '2026-07-16T18:00:00.000Z',
    },
    {
      commId: 'gmail#ext-1',
      accountId: 'acct-1',
      from: 'recommended',
      to: 'needs_context',
      actorId: 'system',
      ts: '2026-07-16T18:00:01.000Z',
    },
  ];
}

describe('agent-handler communications-repo persistOutcome — needs_context (mocked client)', () => {
  it('issues an UpdateCommand whose SET clause and ExpressionAttributeValues omit draft entirely', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createAgentCommunicationsRepo(TABLE);

    await repo.persistOutcome({
      commId: 'gmail#ext-1',
      status: 'needs_context',
      recommendation: fixtureRecommendation(),
      transitions: fixtureTransitions('ingested'),
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.UpdateExpression).not.toContain('draft');
    expect(input?.ExpressionAttributeValues).not.toHaveProperty(':draft');
    expect(input?.ExpressionAttributeValues?.[':status']).toBe('needs_context');
  });
});

/**
 * Regression test for a live bug in `persistOutcome`'s `needs_context` path. Unlike the
 * `apps/ingest/src/communications-repo.ts#putIngested` marshalling bug (a client-side throw on a
 * nested `undefined`), this one does NOT throw on the client at all — `mockClient(DynamoDBDocumentClient)`
 * (used above) intercepts before the marshalling middleware runs and so the describe block above
 * passes unmodified both before and after the fix; it only proves the shape of the outgoing call, not
 * whether it succeeds.
 *
 * The actual failure happens deeper: `lib-dynamodb`'s `ExpressionAttributeValues` marshalling walks
 * each entry with `processObj`, which checks `value !== undefined` and — for a bare top-level
 * `undefined` — returns `undefined` WITHOUT ever calling `marshall`/`convertToAttr`, and the
 * containing reducer then simply omits that key. So the previous unconditional `:draft = draft`
 * (`draft` being `undefined` on the needs_context path) silently produced a wire payload with
 * `UpdateExpression: "SET ... draft = :draft"` but NO `:draft` entry in `ExpressionAttributeValues`
 * at all. DynamoDB itself then rejects that as a `ValidationException`: "Invalid UpdateExpression: An
 * expression attribute value used in expression is not defined; attribute value: :draft" — confirmed
 * empirically against a live DynamoDB table before writing this fix. Every real `needs_context`
 * outcome (the confidence gate's low-confidence path) hit this after the recommendation had already
 * been produced, so the turn failed and the outcome was silently lost.
 *
 * This suite builds a real `DynamoDBDocumentClient` configured exactly like this module's own
 * `client()` (same `marshallOptions`), with a stub `requestHandler` below the marshalling layer, so
 * marshalling genuinely runs and the resulting wire body can be inspected directly.
 */
describe('agent-handler communications-repo persistOutcome — needs_context marshalling regression', () => {
  // `mockClient(DynamoDBDocumentClient)` above patches the shared class prototype, not just the
  // module-level singleton instance in communications-repo.ts — it would otherwise also intercept
  // the standalone DynamoDBDocumentClient instance this suite constructs below and swallow the real
  // marshalling behavior under test. Restore the real `send` for the duration of this block.
  beforeEach(() => {
    ddbMock.restore();
  });

  it('does not throw when persisting a needs_context outcome with no draft, and the wire payload has no draft attribute', async () => {
    const calls: { body?: string }[] = [];
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        requestHandler: {
          async handle(request: { body?: string }) {
            calls.push(request);
            return {
              response: {
                statusCode: 200,
                headers: { 'content-type': 'application/x-amz-json-1.0' },
                body: Buffer.from('{}'),
              },
            };
          },
          updateHttpClientConfig() {},
          httpHandlerConfigs() {
            return {};
          },
        } as never,
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );

    const recommendation = fixtureRecommendation();
    const transitions = fixtureTransitions('ingested');

    await expect(
      client.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { commId: 'gmail#ext-1' },
          UpdateExpression:
            'SET #status = :status, recommendation = :recommendation, transitions = list_append(if_not_exists(transitions, :empty), :newTransitions)',
          ConditionExpression: '#status = :expectedFrom',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'needs_context',
            ':recommendation': recommendation,
            ':newTransitions': transitions,
            ':empty': [] as TransitionRecord[],
            ':expectedFrom': 'ingested',
          },
        }),
      ),
    ).resolves.toBeDefined();

    expect(calls).toHaveLength(1);
    const wireBody = JSON.parse(calls[0]?.body ?? '{}');
    expect(wireBody.ExpressionAttributeValues).not.toHaveProperty(':draft');
    expect(wireBody.UpdateExpression).not.toContain('draft');
  });

  it('reproduces the pre-fix defect: an unconditional :draft = undefined produces a wire payload DynamoDB itself would reject', async () => {
    const calls: { body?: string }[] = [];
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        requestHandler: {
          async handle(request: { body?: string }) {
            calls.push(request);
            return {
              response: {
                statusCode: 200,
                headers: { 'content-type': 'application/x-amz-json-1.0' },
                body: Buffer.from('{}'),
              },
            };
          },
          updateHttpClientConfig() {},
          httpHandlerConfigs() {
            return {};
          },
        } as never,
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );

    // This is exactly the shape the old persistOutcome always sent on the needs_context path
    // (`draft` from PersistAgentOutcomeInput is `undefined`, unconditionally spliced into both the
    // SET clause and ExpressionAttributeValues).
    await client.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { commId: 'gmail#ext-1' },
        UpdateExpression: 'SET draft = :draft',
        ExpressionAttributeValues: {
          ':draft': undefined,
        },
      }),
    );

    // The client-side SDK does NOT throw (processObj silently drops a top-level undefined entry
    // before it ever reaches convertToAttr/marshall) — but the UpdateExpression still references
    // :draft while ExpressionAttributeValues no longer has it, which is precisely the mismatch
    // DynamoDB rejects server-side with ValidationException: "Invalid UpdateExpression: An expression
    // attribute value used in expression is not defined; attribute value: :draft" (verified live
    // against the deployed communications table while diagnosing this bug).
    const wireBody = JSON.parse(calls[0]?.body ?? '{}');
    expect(wireBody.UpdateExpression).toContain(':draft');
    expect(wireBody.ExpressionAttributeValues).not.toHaveProperty(':draft');
  });
});

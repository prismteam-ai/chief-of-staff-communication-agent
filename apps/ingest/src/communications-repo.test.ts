import { describe, expect, it, beforeEach } from 'vitest';

// The DynamoDBDocumentClient created inside communications-repo.ts resolves region + credentials
// during command input marshalling even though aws-sdk-client-mock intercepts the actual network
// send — set fakes before anything in this file constructs a client (no real AWS call is ever
// made). Same pattern as accounts-repo.test.ts.
process.env.AWS_REGION ??= 'us-east-2';
process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { NormalizedMessage } from '@chief-of-staff/shared';
import { createCommunicationsRepo } from './communications-repo.js';

// Must mock DynamoDBDocumentClient itself, not the underlying DynamoDBClient — see the note in
// accounts-repo.test.ts for why mocking the base class silently lets real requests through with
// this SDK version. This is used below for the behavioral assertions (commId/status shape,
// number of PutCommand calls) — it does NOT exercise real marshalling (a
// `mockClient(DynamoDBDocumentClient)` interceptor short-circuits before the marshalling
// middleware runs), so it cannot by itself catch the regression this file targets.
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function baseMessage(): NormalizedMessage {
  return {
    schemaVersion: 1,
    channelType: 'gmail',
    accountId: 'acct-x',
    externalId: 'abc123',
    threadKey: 'thread-1',
    // `displayName: undefined` (key present, value undefined) matches exactly what
    // packages/connectors/src/gmail/normalize.ts's parseAddress/extractParticipants produce for a
    // bare "user@example.com" header with no display name (e.g. every seed-demo fixture message
    // and every verify-ingest self-send probe) — NOT an omitted key.
    participants: [{ id: 'demoalex775@gmail.com', displayName: undefined, role: 'from' }],
    ts: new Date().toISOString(),
    body: 'hello',
    attachments: [],
  };
}

describe('communications-repo putIngested', () => {
  it('derives the expected commId/status for a message with an undefined-displayName participant', async () => {
    ddbMock.on(PutCommand).resolves({});
    const repo = createCommunicationsRepo('communications-table');

    const record = await repo.putIngested(baseMessage());

    expect(record.commId).toBe('gmail#abc123');
    expect(record.status).toBe('ingested');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});

/**
 * Regression test for the live production bug: every real Gmail ingest failed after the dedupe
 * claim had already succeeded, with processor logs reading "Pass
 * options.removeUndefinedValues=true to remove undefined values from map/array/set." — before the
 * fix, `communications-repo.ts` built its `DynamoDBDocumentClient` with no `marshallOptions`, so
 * the SDK's default marshaller (which silently drops an `undefined` value at the *top level* of an
 * Item but *throws* on one nested inside an array/map — exactly the `participants: [{ ...,
 * displayName: undefined }]` shape `normalize.ts` produces) rejected every message whose sender
 * had no display name — i.e. every bare "user@example.com" header, the common case for synthetic/
 * demo/self-send probe messages.
 *
 * `mockClient(DynamoDBDocumentClient)` (used above) intercepts *before* the marshalling middleware
 * runs and so cannot catch this class of bug — confirmed empirically while investigating this bug:
 * the broken pre-fix `communications-repo.ts` passed every assertion in the describe block above
 * unmodified. This suite instead builds a real `DynamoDBDocumentClient` configured exactly like
 * `communications-repo.ts`'s own `client()` (same `marshallOptions`) with a stub `requestHandler`
 * below the marshalling layer, so marshalling genuinely runs: if it throws, `handle()` is never
 * invoked; if it succeeds, the stub returns a canned 200 and the wire body can be inspected.
 */
describe('communications-repo putIngested — marshalling regression', () => {
  // `mockClient(DynamoDBDocumentClient)` above patches the shared class prototype, not just the
  // module-level singleton instance in communications-repo.ts — it would otherwise also intercept
  // the standalone DynamoDBDocumentClient instance this suite constructs below and swallow the
  // real marshalling behavior under test. Restore the real `send` for the duration of this block.
  beforeEach(() => {
    ddbMock.restore();
  });

  it('does not throw, and strips displayName from the wire payload, for a participant with an undefined displayName', async () => {
    const calls: { body?: string }[] = [];
    // Same marshallOptions communications-repo.ts's client() now uses — this test would fail
    // (reproducing the live bug) if that option were removed or misconfigured.
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

    const item = {
      commId: 'gmail#abc123',
      participants: [{ id: 'demoalex775@gmail.com', displayName: undefined, role: 'from' }],
    };

    await expect(
      client.send(new PutCommand({ TableName: 'communications-table', Item: item })),
    ).resolves.toBeDefined();

    expect(calls).toHaveLength(1);
    const wireItem = JSON.parse(calls[0]?.body ?? '{}').Item;
    // `displayName` must be absent from the wire payload (stripped), not merely non-throwing.
    expect(wireItem.participants.L[0].M).not.toHaveProperty('displayName');
  });
});

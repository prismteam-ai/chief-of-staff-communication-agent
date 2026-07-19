import {
  GetCommand,
  type GetCommandOutput,
  TransactWriteCommand,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

import type {
  BrowserAuthPersistence,
  BrowserOAuthState,
  BrowserSessionRecord,
} from './browser-auth.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const epochSchema = z.number().int().positive();
const identitySchema = z
  .object({
    subject: z.string().min(1).max(160),
    clientId: z.string().min(1).max(128),
    issuer: z.string().url().max(512),
    expiresAt: epochSchema,
  })
  .strict();

const oauthStateItemSchema = z
  .object({
    PK: z.string().min(1),
    SK: z.literal('AUTH#BROWSER#OAUTH_STATE#v1'),
    schemaVersion: z.literal('chief-browser-oauth-state.v1'),
    entityType: z.literal('browser-oauth-state'),
    stateHash: sha256Schema,
    codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
    returnPath: z.string().min(1).max(512),
    expiresAt: epochSchema,
    ttl: epochSchema,
  })
  .strict();

const browserSessionItemSchema = z
  .object({
    PK: z.string().min(1),
    SK: z.literal('AUTH#BROWSER#SESSION#v1'),
    schemaVersion: z.literal('chief-browser-session.v1'),
    entityType: z.literal('browser-session'),
    sessionTokenHash: sha256Schema,
    subject: identitySchema.shape.subject,
    clientId: identitySchema.shape.clientId,
    issuer: identitySchema.shape.issuer,
    expiresAt: epochSchema,
    ttl: epochSchema,
  })
  .strict();

export interface BrowserSessionDocumentClient {
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: TransactWriteCommand): Promise<TransactWriteCommandOutput>;
}

function stateKey(stateHash: string) {
  const hash = sha256Schema.parse(stateHash);
  return {
    PK: `AUTH#BROWSER#OAUTH_STATE#${hash}`,
    SK: 'AUTH#BROWSER#OAUTH_STATE#v1' as const,
  };
}

function sessionKey(sessionTokenHash: string) {
  const hash = sha256Schema.parse(sessionTokenHash);
  return {
    PK: `AUTH#BROWSER#SESSION#${hash}`,
    SK: 'AUTH#BROWSER#SESSION#v1' as const,
  };
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'TransactionCanceledException'
  );
}

export function createDynamoBrowserAuthPersistence(input: {
  readonly documentClient: BrowserSessionDocumentClient;
  readonly tableName: string;
}): BrowserAuthPersistence {
  const tableName = input.tableName.trim();
  if (tableName.length === 0)
    throw new Error('MISSING_AUTH_SESSION_TABLE_NAME');

  return {
    async createOAuthState(state) {
      const key = stateKey(state.stateHash);
      const item = oauthStateItemSchema.parse({
        ...key,
        schemaVersion: 'chief-browser-oauth-state.v1',
        entityType: 'browser-oauth-state',
        ...state,
        ttl: state.expiresAt,
      });
      await input.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    },

    async consumeOAuthState(stateHash, nowEpochSeconds) {
      const key = stateKey(stateHash);
      const result = await input.documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (result.Item === undefined) return undefined;
      const parsed = oauthStateItemSchema.safeParse(result.Item);
      if (
        !parsed.success ||
        parsed.data.PK !== key.PK ||
        parsed.data.stateHash !== stateHash
      )
        throw new Error('INVALID_BROWSER_OAUTH_STATE_ITEM');
      try {
        await input.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tableName,
                  Key: key,
                  ConditionExpression:
                    'stateHash = :stateHash AND expiresAt = :expiresAt',
                  ExpressionAttributeValues: {
                    ':stateHash': parsed.data.stateHash,
                    ':expiresAt': parsed.data.expiresAt,
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) return undefined;
        throw error;
      }
      if (parsed.data.expiresAt <= nowEpochSeconds) return undefined;
      return Object.freeze({
        stateHash: parsed.data.stateHash,
        codeVerifier: parsed.data.codeVerifier,
        returnPath: parsed.data.returnPath,
        expiresAt: parsed.data.expiresAt,
      });
    },

    async createSession(record) {
      const key = sessionKey(record.sessionTokenHash);
      const item = browserSessionItemSchema.parse({
        ...key,
        schemaVersion: 'chief-browser-session.v1',
        entityType: 'browser-session',
        ...record,
        ttl: record.expiresAt,
      });
      await input.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    },

    async readSession(sessionTokenHash) {
      const key = sessionKey(sessionTokenHash);
      const result = await input.documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (result.Item === undefined) return undefined;
      const parsed = browserSessionItemSchema.safeParse(result.Item);
      if (
        !parsed.success ||
        parsed.data.PK !== key.PK ||
        parsed.data.sessionTokenHash !== sessionTokenHash
      )
        throw new Error('INVALID_BROWSER_SESSION_ITEM');
      return identitySchema.parse({
        subject: parsed.data.subject,
        clientId: parsed.data.clientId,
        issuer: parsed.data.issuer,
        expiresAt: parsed.data.expiresAt,
      });
    },

    async revokeSession(sessionTokenHash) {
      await input.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName,
                Key: sessionKey(sessionTokenHash),
              },
            },
          ],
        }),
      );
    },
  };
}

export type { BrowserOAuthState, BrowserSessionRecord };

import {
  GetCommand,
  type GetCommandOutput,
  TransactWriteCommand,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import {
  createDynamoBrowserAuthPersistence,
  type BrowserSessionDocumentClient,
} from './aws-browser-session-store.js';

const stateHash = 'a'.repeat(64);
const sessionHash = 'b'.repeat(64);

class ScriptedDocumentClient implements BrowserSessionDocumentClient {
  readonly commands: Array<GetCommand | TransactWriteCommand> = [];
  readonly outcomes: Array<
    GetCommandOutput | TransactWriteCommandOutput | Error
  > = [];

  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: TransactWriteCommand): Promise<TransactWriteCommandOutput>;
  send(
    command: GetCommand | TransactWriteCommand,
  ): Promise<GetCommandOutput | TransactWriteCommandOutput> {
    this.commands.push(command);
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome ?? { $metadata: {} });
  }
}

function transactCommand(
  command: GetCommand | TransactWriteCommand | undefined,
): TransactWriteCommand {
  if (!(command instanceof TransactWriteCommand))
    throw new Error('Expected TransactWriteCommand');
  return command;
}

describe('Dynamo browser auth persistence', () => {
  it('stores TTL-bound OAuth state, consumes it conditionally, and rejects replay', async () => {
    const client = new ScriptedDocumentClient();
    const persistence = createDynamoBrowserAuthPersistence({
      documentClient: client,
      tableName: 'chief-core',
    });
    client.outcomes.push({ $metadata: {} });
    await persistence.createOAuthState({
      stateHash,
      codeVerifier: Buffer.alloc(64, 1).toString('base64url'),
      returnPath: '/inbox',
      expiresAt: 1_768_737_900,
    });

    const createCommand = transactCommand(client.commands[0]);
    const stateItem = createCommand.input.TransactItems?.[0]?.Put?.Item;
    expect(stateItem).toMatchObject({
      stateHash,
      expiresAt: 1_768_737_900,
      ttl: 1_768_737_900,
    });
    expect(stateItem).not.toHaveProperty('sessionToken');

    client.outcomes.push({ Item: stateItem, $metadata: {} }, { $metadata: {} });
    await expect(
      persistence.consumeOAuthState(stateHash, 1_768_737_600),
    ).resolves.toMatchObject({ stateHash, returnPath: '/inbox' });
    expect(client.commands[1]).toBeInstanceOf(GetCommand);
    expect(
      transactCommand(client.commands[2]).input.TransactItems?.[0]?.Delete,
    ).toMatchObject({
      ConditionExpression: 'stateHash = :stateHash AND expiresAt = :expiresAt',
    });

    const replayFailure = new Error('conditional transaction failed');
    replayFailure.name = 'TransactionCanceledException';
    client.outcomes.push({ Item: stateItem, $metadata: {} }, replayFailure);
    await expect(
      persistence.consumeOAuthState(stateHash, 1_768_737_600),
    ).resolves.toBeUndefined();
  });

  it('persists no clear session or Cognito token and reads verified identity only', async () => {
    const client = new ScriptedDocumentClient();
    const persistence = createDynamoBrowserAuthPersistence({
      documentClient: client,
      tableName: 'chief-core',
    });
    const record = {
      sessionTokenHash: sessionHash,
      subject: 'cognito-subject',
      clientId: 'chiefclientid123',
      issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123',
      expiresAt: 1_768_738_500,
    };
    client.outcomes.push({ $metadata: {} });

    await persistence.createSession(record);

    const command = transactCommand(client.commands[0]);
    const item = command.input.TransactItems?.[0]?.Put?.Item;
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'PK',
        'SK',
        'clientId',
        'entityType',
        'expiresAt',
        'issuer',
        'schemaVersion',
        'sessionTokenHash',
        'subject',
        'ttl',
      ].sort(),
    );
    expect(item).toMatchObject({ ...record, ttl: record.expiresAt });
    expect(JSON.stringify(item)).not.toMatch(
      /access_token|id_token|refresh_token|codeVerifier/u,
    );

    client.outcomes.push({ Item: item, $metadata: {} });
    await expect(persistence.readSession(sessionHash)).resolves.toEqual({
      subject: record.subject,
      clientId: record.clientId,
      issuer: record.issuer,
      expiresAt: record.expiresAt,
    });

    client.outcomes.push({ $metadata: {} });
    await persistence.revokeSession(sessionHash);
    expect(
      transactCommand(client.commands.at(-1)).input.TransactItems?.[0]?.Delete
        ?.Key,
    ).toEqual({
      PK: `AUTH#BROWSER#SESSION#${sessionHash}`,
      SK: 'AUTH#BROWSER#SESSION#v1',
    });
  });

  it('rejects an unsafe persisted OAuth return target', async () => {
    const client = new ScriptedDocumentClient();
    const persistence = createDynamoBrowserAuthPersistence({
      documentClient: client,
      tableName: 'chief-core',
    });
    client.outcomes.push({
      Item: {
        PK: `AUTH#BROWSER#OAUTH_STATE#${stateHash}`,
        SK: 'AUTH#BROWSER#OAUTH_STATE#v1',
        schemaVersion: 'chief-browser-oauth-state.v1',
        entityType: 'browser-oauth-state',
        stateHash,
        codeVerifier: Buffer.alloc(64, 1).toString('base64url'),
        returnPath: 'https://attacker.example',
        expiresAt: 1_768_737_900,
        ttl: 1_768_737_900,
      },
      $metadata: {},
    });

    await expect(
      persistence.consumeOAuthState(stateHash, 1_768_737_600),
    ).rejects.toThrow('INVALID_BROWSER_OAUTH_STATE_ITEM');
    expect(client.commands).toHaveLength(1);
  });
});

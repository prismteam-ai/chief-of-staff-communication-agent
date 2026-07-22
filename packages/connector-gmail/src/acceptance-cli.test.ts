import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertGmailAcceptancePathSeparation,
  loadCheckpoint,
  parseGmailAcceptanceCli,
  parseOAuthClientCredentials,
  parseRefreshToken,
  persistCheckpoint,
} from './acceptance-cli.js';
import type { GmailAcceptanceCheckpoint } from './acceptance.js';

describe('Gmail acceptance CLI configuration', () => {
  it.each(['installed', 'web'] as const)(
    'accepts a Google OAuth %s client file',
    (applicationType) => {
      expect(
        parseOAuthClientCredentials(
          JSON.stringify({
            [applicationType]: {
              client_id: 'client-id',
              client_secret: 'client-secret',
              redirect_uris: ['http://127.0.0.1/callback'],
            },
          }),
        ),
      ).toEqual({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://127.0.0.1/callback',
        applicationType,
      });
    },
  );

  it('accepts separate raw or JSON refresh-token storage', () => {
    expect(parseRefreshToken(' refresh-token-value\n')).toBe(
      'refresh-token-value',
    );
    expect(
      parseRefreshToken(JSON.stringify({ refresh_token: 'json-token-value' })),
    ).toBe('json-token-value');
  });

  it('accepts file paths or environment-variable names, never secret argv', () => {
    expect(
      parseGmailAcceptanceCli([
        '--oauth-client-env',
        'GMAIL_OAUTH_CLIENT_JSON',
        '--refresh-token-env',
        'GMAIL_REFRESH_TOKEN',
        '--expected-account-env',
        'GMAIL_EXPECTED_ACCOUNT',
        '--checkpoint-file',
        'checkpoint.json',
      ]),
    ).toMatchObject({
      oauthClientEnv: 'GMAIL_OAUTH_CLIENT_JSON',
      refreshTokenEnv: 'GMAIL_REFRESH_TOKEN',
      expectedAccountEnv: 'GMAIL_EXPECTED_ACCOUNT',
      checkpointFile: 'checkpoint.json',
    });
  });

  it('rejects any send request before reading credentials', () => {
    expect(() =>
      parseGmailAcceptanceCli([
        '--send',
        'true',
        '--oauth-client-env',
        'OAUTH',
      ]),
    ).toThrow('GMAIL_ACCEPTANCE_SEND_FORBIDDEN');
  });

  it('rejects secret-looking positional values and malformed client files', () => {
    expect(() =>
      parseGmailAcceptanceCli([
        '--oauth-client-env',
        'OAUTH',
        '--refresh-token-env',
        'REFRESH',
        '--expected-account-env',
        'ACCOUNT',
        '--checkpoint-file',
        'checkpoint.json',
        'raw-secret-value',
        'raw-secret-value',
      ]),
    ).toThrow('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
    expect(() => parseOAuthClientCredentials('{}')).toThrow(
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
    expect(() =>
      parseOAuthClientCredentials(
        JSON.stringify({
          installed: {
            client_id: 'client-id',
            client_secret: 'placeholder',
            redirect_uris: ['not-a-url'],
          },
        }),
      ),
    ).toThrow('GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID');
  });

  it('portably replaces a checkpoint across resume invocations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-acceptance-'));
    const checkpointFile = join(directory, 'checkpoint.json');
    const checkpoint: GmailAcceptanceCheckpoint = {
      schemaVersion: '1',
      mode: 'read_only_acceptance',
      accountIdentityHash: 'a'.repeat(64),
      capabilitySnapshotHash: 'b'.repeat(64),
      historyCursor: 'gmail-acceptance:v1:cursor',
      historyWatermarkHash: 'c'.repeat(64),
      checkpointEpoch: 1,
      historyPageTokenHashes: [],
      backfillPageTokenHashes: [],
      backfillComplete: true,
      updatedAt: '2026-07-17T12:00:00.000Z',
      checkpointIdentityHash: 'd'.repeat(64),
    };
    try {
      await persistCheckpoint(checkpointFile, checkpoint);
      await persistCheckpoint(checkpointFile, {
        ...checkpoint,
        checkpointEpoch: 2,
        updatedAt: '2026-07-17T12:01:00.000Z',
      });
      expect(JSON.parse(await readFile(checkpointFile, 'utf8'))).toMatchObject({
        checkpointEpoch: 2,
        updatedAt: '2026-07-17T12:01:00.000Z',
      });
      expect(
        await readFile(`${checkpointFile}.tmp`, 'utf8').catch(() => undefined),
      ).toBeUndefined();
      expect(
        await readFile(`${checkpointFile}.bak`, 'utf8').catch(() => undefined),
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['backup', 'temporary'] as const)(
    'recovers a checkpoint from a stable %s sidecar across processes',
    async (candidate) => {
      const directory = await mkdtemp(join(tmpdir(), 'gmail-acceptance-'));
      const checkpointFile = join(directory, 'checkpoint.json');
      const checkpoint: GmailAcceptanceCheckpoint = {
        schemaVersion: '1',
        mode: 'read_only_acceptance',
        accountIdentityHash: 'a'.repeat(64),
        capabilitySnapshotHash: 'b'.repeat(64),
        historyCursor: 'gmail-acceptance:v1:cursor',
        historyWatermarkHash: 'c'.repeat(64),
        checkpointEpoch: 2,
        historyPageTokenHashes: [],
        backfillPageTokenHashes: [],
        backfillComplete: true,
        updatedAt: '2026-07-17T12:01:00.000Z',
        checkpointIdentityHash: 'd'.repeat(64),
      };
      const sidecar = `${checkpointFile}.${candidate === 'backup' ? 'bak' : 'tmp'}`;
      try {
        await writeFile(sidecar, JSON.stringify(checkpoint), 'utf8');
        await expect(loadCheckpoint(checkpointFile)).resolves.toEqual(
          checkpoint,
        );
        await expect(readFile(checkpointFile, 'utf8')).resolves.toContain(
          'checkpointEpoch',
        );
        await expect(readFile(sidecar, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('fails closed on a malformed stale backup when primary is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-acceptance-'));
    const checkpointFile = join(directory, 'checkpoint.json');
    try {
      await writeFile(`${checkpointFile}.bak`, '{malformed', 'utf8');
      await expect(loadCheckpoint(checkpointFile)).rejects.toThrow(
        'GMAIL_ACCEPTANCE_CHECKPOINT_INVALID',
      );
      await expect(readFile(`${checkpointFile}.bak`, 'utf8')).resolves.toBe(
        '{malformed',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['exact', 'alias', 'sidecar', 'windows-case'] as const)(
    'rejects %s credential/checkpoint path collisions without modifying files',
    async (collisionKind) => {
      if (collisionKind === 'windows-case' && process.platform !== 'win32') {
        return;
      }
      const directory = await mkdtemp(join(tmpdir(), 'gmail-acceptance-'));
      const checkpointFile = join(directory, 'checkpoint.json');
      const credentialFile =
        collisionKind === 'sidecar' ? `${checkpointFile}.tmp` : checkpointFile;
      const suppliedCredentialPath =
        collisionKind === 'alias'
          ? join(directory, '.', 'checkpoint.json')
          : collisionKind === 'windows-case'
            ? credentialFile.toUpperCase()
            : credentialFile;
      try {
        await writeFile(credentialFile, 'preserve-this-content', 'utf8');
        const options = parseGmailAcceptanceCli([
          '--oauth-client-file',
          suppliedCredentialPath,
          '--refresh-token-env',
          'GMAIL_REFRESH_NAME',
          '--expected-account-env',
          'GMAIL_ACCOUNT_NAME',
          '--checkpoint-file',
          checkpointFile,
        ]);
        await expect(
          assertGmailAcceptancePathSeparation(options),
        ).rejects.toThrow('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
        await expect(readFile(credentialFile, 'utf8')).resolves.toBe(
          'preserve-this-content',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

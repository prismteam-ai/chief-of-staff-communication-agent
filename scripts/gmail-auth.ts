#!/usr/bin/env tsx
/**
 * `just gmail-auth` (brief constraint 5): local one-time (per mailbox) OAuth helper. Reads the
 * shared OAuth client credentials from Secrets Manager, starts a listener on
 * `http://localhost:8765/oauth/callback` (the redirect URI already registered with the OAuth
 * client), prints the consent URL for the operator to open and click Allow, exchanges the
 * returned code for a refresh token, then:
 *   - creates or updates the per-account secret `cos/gmail-token-<accountId>` (idempotent —
 *     re-running for the same mailbox updates the secret rather than duplicating it), and
 *   - upserts the account record in the accounts table (`userId: demo-alex`, `provider: gmail`,
 *     `historyCursor` empty on first connect so the poller seeds it on its first tick; preserved
 *     across idempotent re-runs so a re-auth never resets an already-seeded cursor).
 *
 * Requests both `gmail.readonly` and `gmail.send` scopes now (brief constraint 5) so Task 6
 * (send) needs no re-consent.
 */
import * as http from 'node:http';
import { google } from 'googleapis';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const CALLBACK_PORT = 8765;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth/callback`;
const OAUTH_CLIENT_SECRET_ID = 'cos/gmail-oauth-client';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
const DEMO_USER_ID = 'demo-alex';

function fail(message: string): never {
  console.error(`[gmail-auth] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey);
  if (!output?.OutputValue) {
    fail(`Stack output ${outputKey} not found on ${stackName} — deploy IngestStack first.`);
  }
  return output.OutputValue;
}

function deriveGmailAccountId(address: string): string {
  const localPart = address
    .trim()
    .toLowerCase()
    .split('@')[0]
    ?.replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!localPart) fail(`Cannot derive an accountId from address "${address}"`);
  return `acct-gmail-${localPart}`;
}

/** Waits for exactly one OAuth callback hit on `REDIRECT_URI` and resolves with its `code` param. */
function waitForAuthorizationCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth consent returned an error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h1>Missing code parameter</h1>');
        return;
      }

      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<h1>Gmail connected.</h1><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`[gmail-auth] Listening on ${REDIRECT_URI}`);
    });
    server.on('error', reject);
  });
}

async function upsertTokenSecret(secretId: string, refreshToken: string): Promise<void> {
  const secretsManager = new SecretsManagerClient({ region: REGION });
  const secretValue = JSON.stringify({ refresh_token: refreshToken });

  try {
    await secretsManager.send(
      new CreateSecretCommand({ Name: secretId, SecretString: secretValue }),
    );
    console.log(`[gmail-auth] Created secret ${secretId}`);
  } catch (error) {
    if (error instanceof ResourceExistsException) {
      await secretsManager.send(
        new PutSecretValueCommand({ SecretId: secretId, SecretString: secretValue }),
      );
      console.log(`[gmail-auth] Updated existing secret ${secretId} (idempotent re-run)`);
      return;
    }
    throw error;
  }
}

async function upsertAccountRecord(
  tableName: string,
  accountId: string,
  address: string,
  tokenSecretArn: string,
): Promise<void> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  // Idempotent re-runs (brief constraint 5) must not reset an already-seeded poller cursor back
  // to empty — that would just cause a harmless-but-wasteful re-seed, not data loss, but there's
  // no reason to throw away real progress on a re-auth (e.g. a token refresh-scope bump).
  const existing = await doc.send(new GetCommand({ TableName: tableName, Key: { accountId } }));
  const historyCursor = (existing.Item?.historyCursor as string | undefined) ?? '';
  const createdAt = (existing.Item?.createdAt as string | undefined) ?? new Date().toISOString();

  await doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        accountId,
        userId: DEMO_USER_ID,
        channelType: 'gmail',
        displayName: address,
        credentialSecretArn: tokenSecretArn,
        createdAt,
        historyCursor,
      },
    }),
  );
  console.log(`[gmail-auth] Upserted account record ${accountId} (${address})`);
}

async function main() {
  const secretsManager = new SecretsManagerClient({ region: REGION });
  const clientSecretResult = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: OAUTH_CLIENT_SECRET_ID }),
  );
  if (!clientSecretResult.SecretString) {
    fail(`Secret ${OAUTH_CLIENT_SECRET_ID} has no SecretString — ask the operator to provision it.`);
  }
  const { client_id, client_secret } = JSON.parse(clientSecretResult.SecretString) as {
    client_id: string;
    client_secret: string;
  };

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
  const consentUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    // Forces Google to reissue a refresh token even if this client already consented once —
    // otherwise a re-run silently returns no refresh_token on the token exchange.
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n[gmail-auth] Open this URL and click Allow (test user: demoalex775@gmail.com):\n');
  console.log(`  ${consentUrl}\n`);

  const codePromise = waitForAuthorizationCode();
  const code = await codePromise;

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    fail(
      'No refresh_token returned. This usually means the account already granted consent without `prompt=consent` — revoke access at https://myaccount.google.com/permissions and re-run.',
    );
  }
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const address = profile.data.emailAddress;
  if (!address) fail('users.getProfile returned no emailAddress');

  const accountId = deriveGmailAccountId(address);
  const tokenSecretId = `cos/gmail-token-${accountId}`;

  await upsertTokenSecret(tokenSecretId, tokens.refresh_token);

  const secretDescribe = await secretsManager.send(new GetSecretValueCommand({ SecretId: tokenSecretId }));
  const tokenSecretArn = secretDescribe.ARN ?? tokenSecretId;

  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  await upsertAccountRecord(accountsTableName, accountId, address, tokenSecretArn);

  console.log(`\n[gmail-auth] Done. accountId=${accountId} address=${address}`);
  console.log('[gmail-auth] Next: just seed-demo, then just verify-ingest\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

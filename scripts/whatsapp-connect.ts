#!/usr/bin/env tsx
/**
 * `just whatsapp-connect` (Task 9 brief constraint 2): creates/upserts the single demo WhatsApp
 * sandbox account record. Unlike `gmail-auth.ts`, no OAuth flow is needed — the Twilio sandbox
 * credentials already live in the operator-provisioned `cos/twilio-whatsapp` secret (verified
 * live); this script only needs to write the internal `Account` row that maps the WhatsApp channel
 * onto `demo-alex` (the same user Gmail is seeded under, so both channels show up together in one
 * unified inbox — README L43 "multiple channels" cross-channel demo).
 *
 * Idempotent: re-running upserts the same `accountId` (`acct-whatsapp-sandbox`) rather than
 * creating a duplicate row, same convention `gmail-auth.ts#upsertAccountRecord` uses.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const TWILIO_SECRET_ID = 'cos/twilio-whatsapp';
const DEMO_USER_ID = 'demo-alex';
export const WHATSAPP_DEMO_ACCOUNT_ID = 'acct-whatsapp-sandbox';

function fail(message: string): never {
  console.error(`[whatsapp-connect] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey);
  if (!output?.OutputValue) {
    fail(`Stack output ${outputKey} not found on ${stackName} — deploy ${stackName} first.`);
  }
  return output.OutputValue;
}

async function main() {
  const secretsManager = new SecretsManagerClient({ region: REGION });
  const secretResult = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: TWILIO_SECRET_ID }),
  );
  if (!secretResult.SecretString) {
    fail(`Secret ${TWILIO_SECRET_ID} has no SecretString — ask the operator to provision it.`);
  }
  const { sandbox_number } = JSON.parse(secretResult.SecretString) as {
    account_sid: string;
    auth_token: string;
    sandbox_number: string;
  };
  if (!sandbox_number) {
    fail(`Secret ${TWILIO_SECRET_ID} is missing sandbox_number.`);
  }

  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const existing = await doc.send(
    new GetCommand({ TableName: accountsTableName, Key: { accountId: WHATSAPP_DEMO_ACCOUNT_ID } }),
  );
  const createdAt = (existing.Item?.createdAt as string | undefined) ?? new Date().toISOString();

  await doc.send(
    new PutCommand({
      TableName: accountsTableName,
      Item: {
        accountId: WHATSAPP_DEMO_ACCOUNT_ID,
        userId: DEMO_USER_ID,
        channelType: 'whatsapp',
        displayName: sandbox_number,
        // ARN reference only (design.md §10) — the credential itself lives exclusively in
        // Secrets Manager, never copied onto the account record.
        credentialSecretArn: `arn:aws:secretsmanager:${REGION}:*:secret:${TWILIO_SECRET_ID}`,
        createdAt,
      },
    }),
  );

  console.log(
    `[whatsapp-connect] Upserted account ${WHATSAPP_DEMO_ACCOUNT_ID} (${sandbox_number}, userId=${DEMO_USER_ID})`,
  );
  console.log(
    '[whatsapp-connect] Next: configure the Twilio sandbox webhook URL (ApiStack output WhatsAppWebhookUrl),',
  );
  console.log(
    '[whatsapp-connect] then have the demo participant WhatsApp "join <sandbox-code>" to +14155238886.',
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

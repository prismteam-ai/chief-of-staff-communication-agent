import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CommunicationState, NormalizedMessage } from '@chief-of-staff/shared';

/**
 * Communications table repository (design.md §5/§7, brief constraint 3). One item per persisted
 * communication; the processor Lambda writes the initial `ingested`-state record here after a
 * successful dedupe claim. `commId` is derived from the channel + externalId so the record's
 * identity is stable and independently derivable (no separate id-generation step needed).
 */
export interface CommunicationRecord extends NormalizedMessage {
  commId: string;
  status: CommunicationState;
  ingestedAt: string;
}

export function commIdFor(channelType: string, externalId: string): string {
  return `${channelType}#${externalId}`;
}

let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export interface CommunicationsRepo {
  putIngested(message: NormalizedMessage): Promise<CommunicationRecord>;
  getById(commId: string): Promise<CommunicationRecord | undefined>;
}

export function createCommunicationsRepo(tableName: string): CommunicationsRepo {
  return {
    async putIngested(message) {
      const record: CommunicationRecord = {
        ...message,
        commId: commIdFor(message.channelType, message.externalId),
        status: 'ingested',
        ingestedAt: new Date().toISOString(),
      };
      await client().send(new PutCommand({ TableName: tableName, Item: record }));
      return record;
    },

    async getById(commId) {
      const result = await client().send(new GetCommand({ TableName: tableName, Key: { commId } }));
      return result.Item as CommunicationRecord | undefined;
    },
  };
}

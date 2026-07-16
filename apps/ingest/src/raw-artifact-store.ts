import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Persists the raw provider JSON payload to the raw-artifact S3 bucket (design.md §4, brief
 * constraint 3: "persist raw JSON to S3 bucket"). Keyed by channel + externalId so the object is
 * independently derivable from the communication record without an extra lookup.
 */

let cachedClient: S3Client | undefined;
function client(): S3Client {
  cachedClient ??= new S3Client({});
  return cachedClient;
}

export function rawMessageKey(channelType: string, externalId: string): string {
  return `${channelType}/${externalId}/raw.json`;
}

export interface RawArtifactStore {
  putRawMessage(channelType: string, externalId: string, payload: unknown): Promise<string>;
}

export function createRawArtifactStore(bucketName: string): RawArtifactStore {
  return {
    async putRawMessage(channelType, externalId, payload) {
      const key = rawMessageKey(channelType, externalId);
      await client().send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: JSON.stringify(payload),
          ContentType: 'application/json',
        }),
      );
      return key;
    },
  };
}

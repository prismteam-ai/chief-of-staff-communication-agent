import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EMBEDDING_MODEL_ID, EMBED_INPUT_TYPE } from './model-config.js';
import type { EmbedInputType } from './model-config.js';

/**
 * Bedrock Cohere Embed v4 client (design.md §4, brief constraint 4). `InvokeModel` for an
 * embeddings model is a raw vector computation, not an LLM chat/completion interaction, so it is
 * a permitted direct `@aws-sdk/client-bedrock-runtime` call per the mission's model-routing rule
 * (see `model-config.ts` module doc for the live-verified request/response shape).
 */

let cachedClient: BedrockRuntimeClient | undefined;
function client(): BedrockRuntimeClient {
  if (!cachedClient) {
    cachedClient = new BedrockRuntimeClient({});
  }
  return cachedClient;
}

interface CohereEmbedResponse {
  embeddings: { float: number[][] };
}

/**
 * Embeds a batch of texts with the pinned Cohere Embed v4 profile. `inputType` MUST be
 * `search_document` for indexed chunks and `search_query` for query-time text — see
 * `model-config.ts`'s `EMBED_INPUT_TYPE` doc; using the wrong one silently degrades recall rather
 * than erroring, so every call site picks explicitly (no default).
 *
 * Cohere rejects empty strings, so callers must not pass blank text (chunking already guarantees
 * this — see `chunk.ts`'s "empty body yields no chunk" note).
 */
export async function embedTexts(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  if (texts.length === 0) return [];

  const command = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      texts,
      input_type: inputType,
      embedding_types: ['float'],
    }),
  });

  const response = await client().send(command);
  const bodyText = new TextDecoder('utf-8').decode(response.body);
  const parsed = JSON.parse(bodyText) as CohereEmbedResponse;
  return parsed.embeddings.float;
}

/** Convenience single-text form of {@link embedTexts}. */
export async function embedText(text: string, inputType: EmbedInputType): Promise<number[]> {
  const [vector] = await embedTexts([text], inputType);
  if (!vector) {
    throw new Error('Bedrock embed-v4 returned no embedding for the given text');
  }
  return vector;
}

export { EMBED_INPUT_TYPE };

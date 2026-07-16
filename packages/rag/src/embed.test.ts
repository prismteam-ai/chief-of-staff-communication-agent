import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the embedding request/response shaping against a fake Bedrock client (brief
 * constraint 7: "embed shaping vs fake") — no live Bedrock call. `InvokeModelCommand`'s
 * constructor arg is asserted directly so a wrong request shape (wrong model id, wrong
 * `input_type`, wrong body key) fails a fast unit test rather than only being caught by
 * `just rag-replay-aws`.
 */

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class FakeInvokeModelCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class FakeBedrockRuntimeClient {
    send = sendMock;
  }
  return {
    BedrockRuntimeClient: FakeBedrockRuntimeClient,
    InvokeModelCommand: FakeInvokeModelCommand,
  };
});

function cohereResponseBody(vectors: number[][]) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ embeddings: { float: vectors } })),
  };
}

describe('embedTexts', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('sends the pinned model id and the given input_type', async () => {
    sendMock.mockResolvedValue(cohereResponseBody([[0.1, 0.2, 0.3]]));
    const { embedTexts } = await import('./embed.js');
    const { EMBEDDING_MODEL_ID, EMBED_INPUT_TYPE } = await import('./model-config.js');

    await embedTexts(['hello world'], EMBED_INPUT_TYPE.document);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input.modelId).toBe(EMBEDDING_MODEL_ID);
    const body = JSON.parse(command.input.body as string);
    expect(body.texts).toEqual(['hello world']);
    expect(body.input_type).toBe('search_document');
    expect(body.embedding_types).toEqual(['float']);
  });

  it('uses search_query for query-time embedding', async () => {
    sendMock.mockResolvedValue(cohereResponseBody([[0.4, 0.5]]));
    const { embedTexts } = await import('./embed.js');
    const { EMBED_INPUT_TYPE } = await import('./model-config.js');

    await embedTexts(['what time is the call'], EMBED_INPUT_TYPE.query);

    const command = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    const body = JSON.parse(command.input.body as string);
    expect(body.input_type).toBe('search_query');
  });

  it('parses the embeddings.float array out of the Cohere response shape', async () => {
    sendMock.mockResolvedValue(cohereResponseBody([[1, 2, 3], [4, 5, 6]]));
    const { embedTexts } = await import('./embed.js');
    const { EMBED_INPUT_TYPE } = await import('./model-config.js');

    const vectors = await embedTexts(['a', 'b'], EMBED_INPUT_TYPE.document);

    expect(vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it('returns an empty array without calling Bedrock for an empty text list', async () => {
    const { embedTexts } = await import('./embed.js');
    const { EMBED_INPUT_TYPE } = await import('./model-config.js');

    const vectors = await embedTexts([], EMBED_INPUT_TYPE.document);

    expect(vectors).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('embedText throws if Bedrock returns no vector for the single text', async () => {
    sendMock.mockResolvedValue(cohereResponseBody([]));
    const { embedText } = await import('./embed.js');
    const { EMBED_INPUT_TYPE } = await import('./model-config.js');

    await expect(embedText('hello', EMBED_INPUT_TYPE.document)).rejects.toThrow(/no embedding/);
  });
});

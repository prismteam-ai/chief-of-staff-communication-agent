import { describe, expect, it } from 'vitest';

import {
  createHealthResponse,
  foundationCapabilities,
  healthResponseSchema,
} from './index.js';

describe('foundation contracts', () => {
  it('creates a valid truthful health response', () => {
    const response = createHealthResponse('chief-api');

    expect(healthResponseSchema.parse(response)).toEqual(response);
    expect(response.foundationOnly).toBe(true);
  });

  it('keeps future capabilities explicitly named', () => {
    expect(foundationCapabilities).toEqual([
      'connectors',
      'oauth',
      'rag',
      'actions',
      'agents',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { StyleCardSchema, StyleProfileRecordSchema, renderStyleCard } from './style-profile.js';

const validCard = {
  tone: 'warm, direct, no filler',
  lengthBand: 'brief' as const,
  signOff: 'Best,\nAlex',
  formality: 'professional but not stiff',
  greeting: 'Hi <first name>,',
};

describe('StyleCardSchema', () => {
  it('accepts a well-formed style card', () => {
    expect(StyleCardSchema.safeParse(validCard).success).toBe(true);
  });

  it('rejects an out-of-enum lengthBand', () => {
    expect(StyleCardSchema.safeParse({ ...validCard, lengthBand: 'novel' }).success).toBe(false);
  });

  it('rejects an empty tone', () => {
    expect(StyleCardSchema.safeParse({ ...validCard, tone: '' }).success).toBe(false);
  });
});

describe('StyleProfileRecordSchema', () => {
  it('accepts a well-formed profile record', () => {
    const record = {
      userId: 'user-1',
      styleCard: validCard,
      sourceCount: 10,
      updatedAt: new Date().toISOString(),
    };
    expect(StyleProfileRecordSchema.safeParse(record).success).toBe(true);
  });

  it('rejects a negative sourceCount', () => {
    const record = {
      userId: 'user-1',
      styleCard: validCard,
      sourceCount: -1,
      updatedAt: new Date().toISOString(),
    };
    expect(StyleProfileRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe('renderStyleCard', () => {
  it('renders all fields into the prompt-injectable prose block', () => {
    const rendered = renderStyleCard(validCard);
    expect(rendered).toContain('warm, direct, no filler');
    expect(rendered).toContain('professional but not stiff');
    expect(rendered).toContain('brief');
    expect(rendered).toContain('Hi <first name>,');
    expect(rendered).toContain('Best,\nAlex');
  });
});

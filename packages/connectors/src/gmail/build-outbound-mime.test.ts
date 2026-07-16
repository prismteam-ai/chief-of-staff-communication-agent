import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '../types.js';
import { buildOutboundMime, decodeBase64UrlToUtf8 } from './build-outbound-mime.js';

const BASE_MESSAGE: OutboundMessage = {
  accountId: 'acct-gmail-demoalex775',
  threadKey: '18f2b7e0a1c2d301',
  inReplyToExternalId: '18f2b8f1b2d3e402',
  inReplyToMessageId: '<CAF+contract-thread-002@mail.gmail.com>',
  subject: 'Re: Meridian rollout contract — two clauses to discuss',
  to: ['daniel.osei@meridian-partners.io'],
  body: 'Sounds good — 2pm tomorrow works.\n\nAlex',
};

function decodedRaw(base64url: string): string {
  return decodeBase64UrlToUtf8(base64url);
}

describe('buildOutboundMime', () => {
  it('produces a base64url string (no +, /, or = padding artifacts from the wrong alphabet)', () => {
    const raw = buildOutboundMime(BASE_MESSAGE, 'demoalex775@gmail.com');
    expect(raw).not.toMatch(/[+/]/);
  });

  it('sets In-Reply-To and References to the RFC2822 Message-ID (not the Gmail internal id)', () => {
    const raw = decodedRaw(buildOutboundMime(BASE_MESSAGE, 'demoalex775@gmail.com'));

    expect(raw).toContain('In-Reply-To: <CAF+contract-thread-002@mail.gmail.com>');
    expect(raw).toContain('References: <CAF+contract-thread-002@mail.gmail.com>');
    expect(raw).not.toContain('In-Reply-To: 18f2b8f1b2d3e402');
  });

  it('falls back to the internal externalId for threading if no RFC2822 Message-ID is given', () => {
    const raw = decodedRaw(
      buildOutboundMime(
        { ...BASE_MESSAGE, inReplyToMessageId: undefined },
        'demoalex775@gmail.com',
      ),
    );

    expect(raw).toContain('In-Reply-To: <18f2b8f1b2d3e402@mail.gmail.com>');
  });

  it('omits In-Reply-To/References entirely when there is nothing to reply to (fresh send)', () => {
    const raw = decodedRaw(
      buildOutboundMime(
        { ...BASE_MESSAGE, inReplyToExternalId: undefined, inReplyToMessageId: undefined },
        'demoalex775@gmail.com',
      ),
    );

    expect(raw).not.toContain('In-Reply-To:');
    expect(raw).not.toContain('References:');
  });

  it('sets From to the sending account mailbox', () => {
    const raw = decodedRaw(buildOutboundMime(BASE_MESSAGE, 'demoalex775@gmail.com'));
    expect(raw).toContain('From: demoalex775@gmail.com');
  });

  it('sets To from the OutboundMessage recipients, comma-joined', () => {
    const raw = decodedRaw(
      buildOutboundMime(
        { ...BASE_MESSAGE, to: ['a@example.com', 'b@example.com'] },
        'demoalex775@gmail.com',
      ),
    );
    expect(raw).toContain('To: a@example.com, b@example.com');
  });

  it('prefixes the subject with Re: when replying, without double-prefixing an already-Re: subject', () => {
    const raw = decodedRaw(buildOutboundMime(BASE_MESSAGE, 'demoalex775@gmail.com'));
    expect(raw).toContain('Subject: Re: Meridian rollout contract');
    expect(raw.match(/Subject: (Re: )+/)?.[0]).toBe('Subject: Re: ');
  });

  it('carries the body text through unmodified', () => {
    const raw = decodedRaw(buildOutboundMime(BASE_MESSAGE, 'demoalex775@gmail.com'));
    expect(raw).toContain('Sounds good — 2pm tomorrow works.');
  });

  it('sets a Content-Type of text/plain with UTF-8 charset', () => {
    const raw = decodedRaw(buildOutboundMime(BASE_MESSAGE, 'demoalex775@gmail.com'));
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
  });
});

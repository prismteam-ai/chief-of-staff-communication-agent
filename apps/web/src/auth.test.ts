// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  browserLoginHref,
  isAuthenticationRequired,
  isBrowserNetworkFailure,
  resolveBrowserApiBaseUrl,
  revokeBrowserSession,
  safeBrowserReturnPath,
} from './auth.js';

describe('browser authentication boundary', () => {
  it('keeps production API traffic on the product origin', () => {
    expect(
      resolveBrowserApiBaseUrl({
        productOrigin: 'https://chief.cloudfront.test',
        configuredDevelopmentBaseUrl: 'https://direct-api.example.test',
        production: true,
      }),
    ).toBe('https://chief.cloudfront.test');
    expect(
      resolveBrowserApiBaseUrl({
        productOrigin: 'http://127.0.0.1:43173',
        configuredDevelopmentBaseUrl: 'http://127.0.0.1:43174',
        production: false,
      }),
    ).toBe('http://127.0.0.1:43174');
  });

  it('builds only same-origin login paths accepted by the backend contract', () => {
    expect(browserLoginHref('/inbox/thread-q3-launch')).toBe(
      '/auth/login?returnTo=%2Finbox%2Fthread-q3-launch',
    );
    expect(safeBrowserReturnPath('//attacker.example')).toBe('/overview');
    expect(safeBrowserReturnPath('https://attacker.example')).toBe('/overview');
  });

  it('finds authentication and network failures through tRPC error causes', () => {
    expect(
      isAuthenticationRequired({
        name: 'TRPCClientError',
        cause: { name: 'BrowserAuthenticationRequiredError' },
      }),
    ).toBe(true);
    expect(isAuthenticationRequired({ data: { httpStatus: 401 } })).toBe(true);
    expect(
      isBrowserNetworkFailure({
        name: 'TRPCClientError',
        cause: { name: 'BrowserApiNetworkError' },
      }),
    ).toBe(true);
    expect(isAuthenticationRequired(new Error('offline'))).toBe(false);
  });

  it('revokes the opaque session through a credentialed same-origin POST', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await revokeBrowserSession(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  });
});

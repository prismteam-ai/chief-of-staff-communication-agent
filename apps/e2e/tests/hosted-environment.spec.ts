import { expect, test } from '@playwright/test';

import {
  requirePublicHostedUrl,
  validateHostedEnvironment,
  type HostedEnvironmentVariables,
} from '../hosted-environment.js';

const nonPublicEndpoints = [
  'https://0.0.0.0',
  'https://10.20.30.40',
  'https://100.64.0.1',
  'https://100.127.255.254',
  'https://127.0.0.1',
  'https://127.255.255.254',
  'https://169.254.10.20',
  'https://172.16.0.1',
  'https://172.31.255.254',
  'https://192.168.1.1',
  'https://[::]',
  'https://[::1]',
  'https://[fe80::1]',
  'https://[febf::1]',
  'https://[fc00::1]',
  'https://[fdff::1]',
  'https://[::ffff:127.0.0.1]',
  'https://chief.local',
  'https://chief.corp.internal',
  'https://chief.lan',
  'https://chief',
] as const;

const unsafeEndpoints: readonly {
  readonly name: string;
  readonly value: string | undefined;
}[] = [
  { name: 'missing', value: undefined },
  { name: 'empty', value: '' },
  { name: 'HTTP', value: 'http://chief.example.com' },
  {
    name: 'credentials',
    value: 'https://user:password@chief.example.com',
  },
  { name: 'query', value: 'https://chief.example.com?token=unsafe' },
  { name: 'fragment', value: 'https://chief.example.com/#fragment' },
];

const publicEnvironment = {
  CHIEF_BASE_URL: 'https://d111111abcdef8.cloudfront.net',
  CHIEF_API_BASE_URL: 'https://abc123.execute-api.us-east-2.amazonaws.com',
  CHIEF_MCP_BASE_URL: 'https://def456.execute-api.us-east-2.amazonaws.com',
} as const satisfies HostedEnvironmentVariables;

test.describe('hosted acceptance URL guard', () => {
  test('accepts only public HTTPS deployment endpoints', () => {
    expect(
      requirePublicHostedUrl(
        'CHIEF_BASE_URL',
        'https://d3hgq3e86d3knk.cloudfront.net/',
      ),
    ).toBe('https://d3hgq3e86d3knk.cloudfront.net');
    expect(
      requirePublicHostedUrl('CHIEF_API_BASE_URL', 'https://8.8.8.8'),
    ).toBe('https://8.8.8.8');
    expect(
      requirePublicHostedUrl(
        'CHIEF_MCP_BASE_URL',
        'https://[2606:4700:4700::1111]',
      ),
    ).toBe('https://[2606:4700:4700::1111]');
  });

  for (const name of [
    'CHIEF_BASE_URL',
    'CHIEF_API_BASE_URL',
    'CHIEF_MCP_BASE_URL',
  ] as const) {
    test(`requires ${name} to be public independently`, () => {
      expect(() =>
        validateHostedEnvironment({
          ...publicEnvironment,
          [name]: 'https://192.168.20.30',
        }),
      ).toThrow(new RegExp(name, 'u'));
    });
  }

  for (const value of nonPublicEndpoints) {
    test(`rejects non-public host ${value}`, () => {
      expect(() => requirePublicHostedUrl('CHIEF_BASE_URL', value)).toThrow(
        /public deployed host/u,
      );
    });
  }

  for (const { name, value } of unsafeEndpoints) {
    test(`rejects ${name} endpoint`, () => {
      expect(() => requirePublicHostedUrl('CHIEF_BASE_URL', value)).toThrow();
    });
  }
});

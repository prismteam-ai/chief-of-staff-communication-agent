import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('@chief/connector-gmail package exports', () => {
  it('exposes only production composition and explicit acceptance surfaces', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports?: Readonly<Record<string, unknown>> };
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
      '.',
      './acceptance',
      './acceptance-cli',
      './oauth-bootstrap',
      './oauth-bootstrap-cli',
    ]);
    expect(packageJson.exports).not.toHaveProperty('./*');
    expect(JSON.stringify(packageJson.exports)).not.toContain(
      'provider-fixtures',
    );
    expect(JSON.stringify(packageJson.exports)).not.toContain('.test');
    expect(() =>
      import.meta.resolve('@chief/connector-gmail/provider-fixtures'),
    ).toThrow();
    expect(() =>
      import.meta.resolve('@chief/connector-gmail/oauth-bootstrap.test'),
    ).toThrow();
  });
});

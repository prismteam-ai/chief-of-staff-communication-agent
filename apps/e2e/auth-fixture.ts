import { createHash, randomBytes } from 'node:crypto';

import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import {
  readRequiredHostedEnvironment,
  requireHostedEvaluatorCredentials,
  type HostedEvaluatorCredentials,
} from './hosted-environment.js';

type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface HostedEvaluatorAuthority {
  readonly browserStorageState: BrowserStorageState;
  readonly mcpAuthorization?: string;
}

interface EvaluatorFixtures {
  readonly mcpAuthorization: string | undefined;
}

interface EvaluatorWorkerFixtures {
  readonly evaluatorAuthority: HostedEvaluatorAuthority;
}

function hostedRunConfigured(): boolean {
  return Boolean(process.env.CHIEF_BASE_URL?.trim());
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorCode: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function submitHostedLogin(
  page: Page,
  credentials: HostedEvaluatorCredentials,
): Promise<void> {
  const username = page
    .locator('input[name="username"], #signInFormUsername')
    .first();
  const password = page
    .locator('input[name="password"], #signInFormPassword')
    .first();
  await expect(username).toBeVisible({ timeout: 20_000 });
  await username.fill(credentials.username);
  await password.fill(credentials.password);
  await page
    .locator(
      'button[type="submit"], input[name="signInSubmitButton"], input[type="submit"]',
    )
    .first()
    .click();
}

async function exchangeMcpAccessToken(input: {
  readonly context: BrowserContext;
  readonly authorizeUrl: URL;
  readonly webOrigin: string;
  readonly credentials: HostedEvaluatorCredentials;
}): Promise<string> {
  const clientId = input.authorizeUrl.searchParams.get('client_id');
  const redirectUri = input.authorizeUrl.searchParams.get('redirect_uri');
  if (!clientId || !redirectUri)
    throw new Error('COGNITO_AUTHORIZE_CONTRACT_INVALID');

  const verifier = randomBytes(64).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const authorize = new URL('/oauth2/authorize', input.authorizeUrl.origin);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid email',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();

  const page = await input.context.newPage();
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  await page.route(`${input.webOrigin}/auth/callback**`, async (route) => {
    const callback = new URL(route.request().url());
    const callbackState = callback.searchParams.get('state');
    const code = callback.searchParams.get('code');
    if (callbackState !== state || !code) {
      rejectCode(new Error('COGNITO_MCP_CALLBACK_INVALID'));
    } else {
      resolveCode(code);
    }
    await route.fulfill({ status: 204, body: '' });
  });

  let code: string;
  try {
    await page.goto(authorize.toString(), { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin === input.authorizeUrl.origin) {
      await submitHostedLogin(page, input.credentials);
    }
    code = await withTimeout(
      codePromise,
      20_000,
      'COGNITO_MCP_CALLBACK_TIMEOUT',
    );
  } finally {
    await page.close();
  }

  const tokenResponse = await fetch(
    new URL('/oauth2/token', input.authorizeUrl.origin),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!tokenResponse.ok) throw new Error('COGNITO_MCP_TOKEN_EXCHANGE_FAILED');
  const tokenBody = (await tokenResponse.json()) as {
    readonly access_token?: unknown;
  };
  if (
    typeof tokenBody.access_token !== 'string' ||
    tokenBody.access_token.length < 32
  ) {
    throw new Error('COGNITO_MCP_ACCESS_TOKEN_INVALID');
  }
  return `Bearer ${tokenBody.access_token}`;
}

async function createHostedAuthority(
  context: BrowserContext,
): Promise<HostedEvaluatorAuthority> {
  const hosted = readRequiredHostedEnvironment();
  const credentials = requireHostedEvaluatorCredentials(process.env);
  const page = await context.newPage();
  await page.goto(`${hosted.webBaseUrl}/auth/login?returnTo=/overview`, {
    waitUntil: 'domcontentloaded',
  });
  const authorizeUrl = new URL(page.url());
  if (authorizeUrl.origin === new URL(hosted.webBaseUrl).origin) {
    throw new Error('COGNITO_HOSTED_LOGIN_REDIRECT_MISSING');
  }
  await submitHostedLogin(page, credentials);
  await page.waitForURL(`${hosted.webBaseUrl}/overview`, { timeout: 30_000 });
  const completeStorageState = await context.storageState();
  const productHostname = new URL(hosted.webBaseUrl).hostname;
  const browserStorageState: BrowserStorageState = {
    cookies: completeStorageState.cookies.filter(
      (cookie) => cookie.domain.replace(/^\./u, '') === productHostname,
    ),
    origins: completeStorageState.origins.filter(
      (origin) => origin.origin === new URL(hosted.webBaseUrl).origin,
    ),
  };
  if (
    !browserStorageState.cookies.some(
      (cookie) => cookie.name === '__Host-chief_session' && cookie.httpOnly,
    )
  ) {
    throw new Error('CHIEF_BROWSER_SESSION_COOKIE_MISSING');
  }
  const mcpAuthorization = await exchangeMcpAccessToken({
    context,
    authorizeUrl,
    webOrigin: new URL(hosted.webBaseUrl).origin,
    credentials,
  });
  await page.close();
  return { browserStorageState, mcpAuthorization };
}

export const test = base.extend<EvaluatorFixtures, EvaluatorWorkerFixtures>({
  evaluatorAuthority: [
    async ({ browser }, use) => {
      if (!hostedRunConfigured()) {
        await use({
          browserStorageState: { cookies: [], origins: [] },
        });
        return;
      }
      const context = await browser.newContext();
      try {
        await use(await createHostedAuthority(context));
      } finally {
        await context.close();
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ evaluatorAuthority }, use) => {
    await use(evaluatorAuthority.browserStorageState);
  },
  mcpAuthorization: async ({ evaluatorAuthority }, use) => {
    await use(evaluatorAuthority.mcpAuthorization);
  },
});

export { expect };
export type { Page };

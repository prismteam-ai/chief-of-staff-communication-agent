interface ErrorRecord {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
  readonly data?: unknown;
}

function errorChain(error: unknown): readonly ErrorRecord[] {
  const chain: ErrorRecord[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current) &&
    chain.length < 8
  ) {
    visited.add(current);
    const record = current as ErrorRecord;
    chain.push(record);
    current = record.cause;
  }
  return chain;
}

export function isAuthenticationRequired(error: unknown): boolean {
  return errorChain(error).some((record) => {
    const data = record.data as
      { readonly httpStatus?: unknown; readonly code?: unknown } | undefined;
    return (
      record.name === 'BrowserAuthenticationRequiredError' ||
      record.message === 'BROWSER_AUTHENTICATION_REQUIRED' ||
      data?.httpStatus === 401 ||
      data?.code === 'UNAUTHORIZED'
    );
  });
}

export function isBrowserNetworkFailure(error: unknown): boolean {
  return errorChain(error).some(
    (record) =>
      record.name === 'BrowserApiNetworkError' ||
      record.message === 'BROWSER_API_NETWORK_ERROR',
  );
}

export function resolveBrowserApiBaseUrl(input: {
  readonly productOrigin: string;
  readonly configuredDevelopmentBaseUrl?: string;
  readonly production: boolean;
}): string {
  if (input.production) return input.productOrigin;
  const configured = input.configuredDevelopmentBaseUrl?.trim();
  return configured && configured.length > 0 ? configured : input.productOrigin;
}

export function safeBrowserReturnPath(pathname: string): string {
  return pathname.length <= 512 &&
    pathname.startsWith('/') &&
    !pathname.startsWith('//')
    ? pathname
    : '/overview';
}

export function browserLoginHref(pathname: string): string {
  const query = new URLSearchParams({
    returnTo: safeBrowserReturnPath(pathname),
  });
  return `/auth/login?${query.toString()}`;
}

export async function revokeBrowserSession(
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImplementation('/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('BROWSER_LOGOUT_FAILED');
}

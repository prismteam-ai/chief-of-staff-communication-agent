import { isIP } from 'node:net';

export interface HostedEnvironment {
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly mcpBaseUrl: string;
}

export interface HostedEnvironmentVariables {
  readonly CHIEF_BASE_URL?: string;
  readonly CHIEF_API_BASE_URL?: string;
  readonly CHIEF_MCP_BASE_URL?: string;
}

export interface HostedEvaluatorCredentials {
  readonly username: string;
  readonly password: string;
}

export interface HostedEvaluatorCredentialVariables {
  readonly CHIEF_EVALUATOR_USERNAME?: string;
  readonly CHIEF_EVALUATOR_PASSWORD?: string;
}

function isPublicIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1, third = -1] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isPublicIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const firstHextet = Number.parseInt(normalized.split(':')[0] ?? '0', 16);
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00 ||
    normalized.startsWith('2001:db8:')
  );
}

function isPublicHostname(hostname: string): boolean {
  const addressKind = isIP(hostname);
  if (addressKind === 4) return isPublicIpv4(hostname);
  if (addressKind === 6) return isPublicIpv6(hostname);

  if (!hostname.includes('.')) return false;
  return ![
    '.internal',
    '.invalid',
    '.lan',
    '.local',
    '.localhost',
    '.home',
    '.test',
    '.arpa',
  ].some((suffix) => hostname.endsWith(suffix));
}

export function requirePublicHostedUrl(
  name: string,
  untrustedValue: string | undefined,
): string {
  const value = untrustedValue?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required for non-skippable hosted acceptance. Supply all three Chief deployment URLs.`,
    );
  }

  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS for hosted acceptance.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${name} must not contain credentials.`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${name} must not contain a query string or fragment.`);
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  if (!isPublicHostname(hostname)) {
    throw new Error(
      `${name} must identify a public deployed host; private, local, reserved, and unspecified hosts are rejected.`,
    );
  }

  return url.toString().replace(/\/$/u, '');
}

export function validateHostedEnvironment(
  environment: HostedEnvironmentVariables,
): HostedEnvironment {
  return {
    webBaseUrl: requirePublicHostedUrl(
      'CHIEF_BASE_URL',
      environment.CHIEF_BASE_URL,
    ),
    apiBaseUrl: requirePublicHostedUrl(
      'CHIEF_API_BASE_URL',
      environment.CHIEF_API_BASE_URL,
    ),
    mcpBaseUrl: requirePublicHostedUrl(
      'CHIEF_MCP_BASE_URL',
      environment.CHIEF_MCP_BASE_URL,
    ),
  };
}

export function readRequiredHostedEnvironment(): HostedEnvironment {
  return validateHostedEnvironment(process.env);
}

export function requireHostedEvaluatorCredentials(
  environment: HostedEvaluatorCredentialVariables,
): HostedEvaluatorCredentials {
  const username = environment.CHIEF_EVALUATOR_USERNAME?.trim();
  const password = environment.CHIEF_EVALUATOR_PASSWORD;
  if (username === undefined || username.length === 0) {
    throw new Error(
      'CHIEF_EVALUATOR_USERNAME is required for hosted acceptance.',
    );
  }
  if (password === undefined || password.length === 0) {
    throw new Error(
      'CHIEF_EVALUATOR_PASSWORD is required for hosted acceptance.',
    );
  }
  return { username, password };
}

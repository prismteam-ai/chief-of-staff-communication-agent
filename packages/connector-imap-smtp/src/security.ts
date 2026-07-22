export type MailTlsMode = 'implicit_tls' | 'starttls_required';
export type MailAuthMode = 'password_reference' | 'oauth2_reference';

export interface MailEndpointConfig {
  readonly host: string;
  readonly port: number;
  readonly tlsMode: MailTlsMode;
  readonly rejectUnauthorized: true;
  readonly servername: string;
  readonly minimumTlsVersion: 'TLSv1.2' | 'TLSv1.3';
}

export interface ReferencedMailboxCredential {
  readonly credentialClass: 'kms-envelope-mailbox-credential';
  readonly authMode: MailAuthMode;
  readonly secretReference: string;
}

export interface MailboxConnectionProfile {
  readonly imap: MailEndpointConfig;
  readonly smtp: MailEndpointConfig;
  readonly credential: ReferencedMailboxCredential;
}

function assertHostname(host: string, label: string): void {
  if (
    host.length === 0 ||
    host !== host.trim() ||
    /[\s/@\\]/u.test(host) ||
    host === '0.0.0.0' ||
    host === '::'
  ) {
    throw new Error(`${label}_HOST_INVALID`);
  }
}

function validateEndpoint(
  endpoint: MailEndpointConfig,
  label: 'IMAP' | 'SMTP',
): MailEndpointConfig {
  assertHostname(endpoint.host, label);
  assertHostname(endpoint.servername, label);
  if (endpoint.host.toLowerCase() !== endpoint.servername.toLowerCase()) {
    throw new Error(`${label}_TLS_SERVERNAME_MISMATCH`);
  }
  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535
  ) {
    throw new Error(`${label}_PORT_INVALID`);
  }
  if (endpoint.rejectUnauthorized !== true) {
    throw new Error(`${label}_CERTIFICATE_VALIDATION_REQUIRED`);
  }
  if (
    endpoint.tlsMode !== 'implicit_tls' &&
    endpoint.tlsMode !== 'starttls_required'
  ) {
    throw new Error(`${label}_PLAINTEXT_FALLBACK_FORBIDDEN`);
  }
  if (
    endpoint.minimumTlsVersion !== 'TLSv1.2' &&
    endpoint.minimumTlsVersion !== 'TLSv1.3'
  ) {
    throw new Error(`${label}_TLS_VERSION_UNSAFE`);
  }
  return Object.freeze({ ...endpoint });
}

export function validateMailboxConnectionProfile(
  profile: MailboxConnectionProfile,
): MailboxConnectionProfile {
  if (
    profile.credential.credentialClass !== 'kms-envelope-mailbox-credential' ||
    profile.credential.secretReference.trim().length === 0 ||
    /(?:password|token|secret)=/iu.test(profile.credential.secretReference)
  ) {
    throw new Error('MAILBOX_CREDENTIAL_REFERENCE_REQUIRED');
  }
  if (
    profile.credential.authMode !== 'password_reference' &&
    profile.credential.authMode !== 'oauth2_reference'
  ) {
    throw new Error('MAILBOX_AUTH_MODE_UNSUPPORTED');
  }
  return Object.freeze({
    imap: validateEndpoint(profile.imap, 'IMAP'),
    smtp: validateEndpoint(profile.smtp, 'SMTP'),
    credential: Object.freeze({ ...profile.credential }),
  });
}

export interface GreenMailCompatibleWireOptions {
  readonly imap: {
    readonly secure: boolean;
    readonly doSTARTTLS: boolean;
    readonly tls: {
      readonly rejectUnauthorized: true;
      readonly servername: string;
      readonly minVersion: 'TLSv1.2' | 'TLSv1.3';
    };
  };
  readonly smtp: {
    readonly secure: boolean;
    readonly requireTLS: true;
    readonly ignoreTLS: false;
    readonly tls: {
      readonly rejectUnauthorized: true;
      readonly servername: string;
      readonly minVersion: 'TLSv1.2' | 'TLSv1.3';
    };
  };
}

export function greenMailCompatibleWireOptions(
  profile: MailboxConnectionProfile,
): GreenMailCompatibleWireOptions {
  const validated = validateMailboxConnectionProfile(profile);
  return {
    imap: {
      secure: validated.imap.tlsMode === 'implicit_tls',
      doSTARTTLS: validated.imap.tlsMode === 'starttls_required',
      tls: {
        rejectUnauthorized: true,
        servername: validated.imap.servername,
        minVersion: validated.imap.minimumTlsVersion,
      },
    },
    smtp: {
      secure: validated.smtp.tlsMode === 'implicit_tls',
      requireTLS: true,
      ignoreTLS: false,
      tls: {
        rejectUnauthorized: true,
        servername: validated.smtp.servername,
        minVersion: validated.smtp.minimumTlsVersion,
      },
    },
  };
}

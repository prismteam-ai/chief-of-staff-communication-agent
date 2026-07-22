import { describe, expect, it } from 'vitest';

import {
  greenMailCompatibleWireOptions,
  type MailboxConnectionProfile,
  validateMailboxConnectionProfile,
} from './security.js';

const strictProfile: MailboxConnectionProfile = {
  imap: {
    host: 'mail.example.test',
    port: 993,
    tlsMode: 'implicit_tls',
    rejectUnauthorized: true,
    servername: 'mail.example.test',
    minimumTlsVersion: 'TLSv1.2',
  },
  smtp: {
    host: 'mail.example.test',
    port: 587,
    tlsMode: 'starttls_required',
    rejectUnauthorized: true,
    servername: 'mail.example.test',
    minimumTlsVersion: 'TLSv1.2',
  },
  credential: {
    credentialClass: 'kms-envelope-mailbox-credential',
    authMode: 'password_reference',
    secretReference:
      'arn:aws:secretsmanager:us-east-2:000000000000:secret:fixture',
  },
};

describe('strict provider-neutral mailbox security', () => {
  it('maps implicit TLS and mandatory STARTTLS without plaintext fallback', () => {
    const options = greenMailCompatibleWireOptions(strictProfile);
    expect(options.imap).toMatchObject({
      secure: true,
      doSTARTTLS: false,
      tls: { rejectUnauthorized: true },
    });
    expect(options.smtp).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      tls: { rejectUnauthorized: true },
    });
  });

  it('rejects hostname substitution and secret-shaped inline values', () => {
    expect(() =>
      validateMailboxConnectionProfile({
        ...strictProfile,
        smtp: { ...strictProfile.smtp, servername: 'attacker.example.test' },
      }),
    ).toThrow('SMTP_TLS_SERVERNAME_MISMATCH');
    expect(() =>
      validateMailboxConnectionProfile({
        ...strictProfile,
        credential: {
          ...strictProfile.credential,
          secretReference: 'password=plaintext',
        },
      }),
    ).toThrow('MAILBOX_CREDENTIAL_REFERENCE_REQUIRED');
  });
});

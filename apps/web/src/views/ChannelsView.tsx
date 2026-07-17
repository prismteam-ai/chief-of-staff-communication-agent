import type { ChannelType } from '@chief-of-staff/shared';
import type { ConnectedAccountDto } from '../lib/trpc-client.js';

/**
 * Connect-channel wizard (README L12, design.md §8, Task 8 brief constraint 2: "minimal — a page
 * listing connected channels + a 'connect' affordance"). Lists the caller's own connected accounts
 * (from `accounts.listConnectedAccounts`, server-scoped to `userId`) and a "Connect a channel"
 * affordance per channel type.
 *
 * Real OAuth wiring is a DOCUMENTED STUB here, per the brief: Gmail's actual OAuth flow lives in
 * `scripts/gmail-auth.ts` (an operator CLI script — see the justfile `gmail-auth` recipe) because
 * this is a repo-less, manually-zip-deployed Amplify app with no OAuth callback endpoint of its
 * own (`lib/stacks/amplify-stack.ts`'s doc comment: no GitHub-connected build, no custom domain to
 * register a redirect URI against). The click below surfaces that instruction rather than silently
 * doing nothing or faking a connection — "simple enough for non-technical users" (the AC) means the
 * NEXT STEP is always clear, even where the step itself is a documented CLI hand-off rather than an
 * in-browser redirect.
 */

const CHANNEL_LABELS: Record<ChannelType, string> = {
  gmail: 'Gmail',
  imap: 'IMAP (Outlook, etc.)',
  sms: 'SMS (Twilio)',
  whatsapp: 'WhatsApp',
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
};

const CONNECT_INSTRUCTIONS: Partial<Record<ChannelType, string>> = {
  gmail:
    'Run `just gmail-auth` from the project root — a one-time OAuth consent screen opens, ' +
    'and the connected mailbox appears here automatically once it completes.',
};

export interface ChannelsViewProps {
  accounts?: ConnectedAccountDto[];
  loading: boolean;
  error?: string;
}

export function ChannelsView(props: ChannelsViewProps) {
  const { accounts, loading, error } = props;

  return (
    <section data-testid="channels-view">
      <p style={{ color: '#4b5563', marginBottom: '1rem' }}>
        Connected channels feed this account&apos;s communications into the dashboard. Connecting a
        new channel is a short, guided step — no AWS console access needed.
      </p>

      {error && <p style={{ color: '#b91c1c' }}>Failed to load connected channels: {error}</p>}
      {loading && !accounts && <p style={{ color: '#6b7280' }}>Loading…</p>}

      <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Connected</h3>
      {!loading && accounts && accounts.length === 0 && (
        <p style={{ color: '#6b7280' }}>No channels connected yet.</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, marginBottom: '1.5rem' }}>
        {(accounts ?? []).map((a) => (
          <li
            key={a.accountId}
            data-testid="connected-account-row"
            style={{
              border: '1px solid #d1d5db',
              borderRadius: 8,
              padding: '0.75rem 1rem',
              marginBottom: '0.5rem',
              background: '#fff',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>
              <strong>{CHANNEL_LABELS[a.channelType] ?? a.channelType}</strong> — {a.displayName}
            </span>
            <span style={{ color: '#15803d', fontSize: '0.85rem' }}>Connected</span>
          </li>
        ))}
      </ul>

      <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Connect a channel</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {(Object.keys(CHANNEL_LABELS) as ChannelType[]).map((channel) => (
          <li
            key={channel}
            data-testid="connect-channel-row"
            style={{
              border: '1px dashed #d1d5db',
              borderRadius: 8,
              padding: '0.75rem 1rem',
              marginBottom: '0.5rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{CHANNEL_LABELS[channel]}</span>
            <button
              onClick={() =>
                alert(
                  CONNECT_INSTRUCTIONS[channel] ??
                    `${CHANNEL_LABELS[channel]} connection is not wired up yet in this demo — see docs/setup.md.`,
                )
              }
            >
              Connect
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

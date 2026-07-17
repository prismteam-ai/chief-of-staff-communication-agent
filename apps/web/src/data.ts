export type CapabilityMode = 'live' | 'recorded' | 'fixture' | 'blocked';
export type CommunicationStatus =
  'pending' | 'answered' | 'overdue' | 'context' | 'resolved';

export interface ConnectorFixture {
  readonly id: string;
  readonly name: string;
  readonly account: string;
  readonly mode: CapabilityMode;
  readonly detail: string;
  readonly health: string;
  readonly lastSync: string;
  readonly capabilities: readonly string[];
}

export interface CommunicationFixture {
  readonly id: string;
  readonly threadId?: string;
  readonly messageRevisionId?: string;
  readonly sender: string;
  readonly subject: string;
  readonly excerpt: string;
  readonly channel: string;
  readonly account: string;
  readonly status: CommunicationStatus;
  readonly received: string;
  readonly age: string;
  readonly attachmentCount: number;
  readonly priority: 'critical' | 'high' | 'normal';
}

export const connectors: readonly ConnectorFixture[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    account: 'Northstar · Executive',
    mode: 'fixture',
    detail:
      'Provider-shaped polling, threads, attachments, and reply metadata.',
    health: 'Deterministic fixture healthy',
    lastSync: 'Seeded 17 Jul 2026 · 12:00 UTC',
    capabilities: ['Read', 'Threads', 'Attachments', 'Draft'],
  },
  {
    id: 'outlook',
    name: 'Microsoft Outlook',
    account: 'Second mailbox candidate',
    mode: 'blocked',
    detail: 'Live certification and hosted notification proof are not present.',
    health: 'External authorization gate',
    lastSync: 'No live sync claimed',
    capabilities: ['Architecture ready', 'Live disabled'],
  },
  {
    id: 'sms',
    name: 'Twilio SMS',
    account: 'Synthetic byte-recorded fixture',
    mode: 'recorded',
    detail:
      'Synthetic byte-recorded, provider-shaped webhook and callback fixtures; no provider event is claimed.',
    health: 'Synthetic fixture evidence available',
    lastSync: 'Frozen fixture · 17 Jul 2026',
    capabilities: ['Synthetic inbound bytes', 'Synthetic callback bytes'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    account: 'Assessment sandbox shape',
    mode: 'fixture',
    detail:
      'Service-window behavior is represented without a provider connection.',
    health: 'Fixture only',
    lastSync: 'Seeded 17 Jul 2026 · 12:00 UTC',
    capabilities: ['Threads', 'Draft', 'Window policy'],
  },
  {
    id: 'x',
    name: 'X Direct Messages',
    account: 'Legacy DM sample',
    mode: 'fixture',
    detail:
      'No entitlement or budget is claimed by the public evaluator session.',
    health: 'Live access not selected',
    lastSync: 'Seeded fixture',
    capabilities: ['Read fixture', 'Send disabled'],
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    account: 'Partner API',
    mode: 'blocked',
    detail:
      'Partner inbox access is unavailable; scraping and automation are prohibited.',
    health: 'Approval required',
    lastSync: 'No live sync claimed',
    capabilities: ['Manual handoff', 'Live disabled'],
  },
  {
    id: 'asana',
    name: 'Asana',
    account: 'Northstar Operations',
    mode: 'fixture',
    detail:
      'Task retrieval and prepared follow-up use deterministic fixture records.',
    health: 'Effect disabled',
    lastSync: 'Seeded 17 Jul 2026 · 12:00 UTC',
    capabilities: ['Retrieve', 'Prepare action', 'External effect off'],
  },
] as const;

export const communications: readonly CommunicationFixture[] = [
  {
    id: 'thread-q3-launch',
    sender: 'Taylor Reed',
    subject: 'Decision needed: Q3 launch risk and customer note',
    excerpt:
      'The enterprise pilot is still on track, but the security review now overlaps the launch window…',
    channel: 'Gmail',
    account: 'Northstar · Executive',
    status: 'overdue',
    received: '09:36',
    age: '6m 12s',
    attachmentCount: 1,
    priority: 'critical',
  },
  {
    id: 'thread-board-packet',
    sender: 'Maya Chen',
    subject: 'Board packet — final operating metrics',
    excerpt:
      'Finance has reconciled the ARR bridge. Please confirm whether to include the hiring sensitivity page.',
    channel: 'Outlook',
    account: 'Northstar · Board',
    status: 'pending',
    received: '09:34',
    age: '4m 08s',
    attachmentCount: 2,
    priority: 'high',
  },
  {
    id: 'thread-partner-intro',
    sender: 'Ibrahim Noor',
    subject: 'Partner introduction follow-up',
    excerpt:
      'Thanks for the conversation yesterday. I can make Tuesday at 14:00 UTC and will bring our product lead.',
    channel: 'WhatsApp',
    account: 'Northstar · Partnerships',
    status: 'context',
    received: '09:31',
    age: '2m 44s',
    attachmentCount: 0,
    priority: 'normal',
  },
  {
    id: 'thread-pricing',
    sender: 'Alex Morgan',
    subject: 'Re: enterprise pricing exception',
    excerpt:
      'Confirmed. The exception is approved if the renewal floor stays in the order form.',
    channel: 'SMS',
    account: 'Controlled transcript',
    status: 'answered',
    received: '09:24',
    age: '1m 49s response',
    attachmentCount: 0,
    priority: 'normal',
  },
  {
    id: 'thread-press',
    sender: 'Jordan Bell',
    subject: 'Comment request for product launch',
    excerpt:
      'We are publishing at noon Eastern. Can you confirm the customer count and provide one sentence on the roadmap?',
    channel: 'X DM',
    account: 'Legacy DM fixture',
    status: 'pending',
    received: '09:20',
    age: '3m 27s',
    attachmentCount: 0,
    priority: 'high',
  },
] as const;

export const channelBreakdown = [
  { channel: 'Gmail', count: 488, percent: 38, mode: 'fixture' },
  { channel: 'Outlook', count: 321, percent: 25, mode: 'blocked' },
  { channel: 'SMS', count: 193, percent: 15, mode: 'recorded' },
  { channel: 'WhatsApp', count: 154, percent: 12, mode: 'fixture' },
  { channel: 'X / LinkedIn', count: 128, percent: 10, mode: 'fixture' },
] as const;

export const citations = [
  {
    id: 'asana-4821',
    label: 'Asana · SEC-4821',
    title: 'Enterprise pilot security review',
    excerpt:
      'Customer evidence review moved to 22 July; launch gate remains 26 July if the red-team summary is accepted.',
    source: 'Asana task snapshot · updated 09:18 UTC',
  },
  {
    id: 'decision-0711',
    label: 'Decision log · 11 Jul',
    title: 'Launch communication rule',
    excerpt:
      'Do not change the launch date externally until Security and Customer Success both confirm the recovery plan.',
    source: 'Organization knowledge · policy v3',
  },
  {
    id: 'thread-0626',
    label: 'Prior Gmail thread · 26 Jun',
    title: 'Taylor Reed / pilot expectations',
    excerpt:
      'Taylor asked for concise status notes with a named owner, explicit next checkpoint, and no speculative dates.',
    source: 'Communication history · 92% retrieval score',
  },
] as const;

export const initialDraft = `Taylor — thanks for surfacing this early. Keep the 26 July launch target internal for now.

Please ask Security to post the red-team summary to SEC-4821 by 16:00 UTC today, with Customer Success confirming the recovery plan in the same task. I’ll review both at the 17:00 checkpoint before we update the pilot customer.

If either input slips, prepare the customer note for a one-business-day adjustment; do not send it yet.

— Alex`;

export const revisedDraft = `Taylor — thanks for surfacing this early. Hold the 26 July launch target internally for now.

Please have Security attach the red-team summary to SEC-4821 by 16:00 UTC today. Customer Success should confirm the recovery plan there as well. I’ll make the go/no-go call at 17:00 UTC.

If either input slips, prepare — but do not send — a customer note for a one-business-day adjustment.

— Alex`;

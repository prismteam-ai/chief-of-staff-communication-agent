export interface DeliveryStatusRecipient {
  readonly finalRecipient: string;
  readonly action: 'delivered' | 'delayed' | 'failed' | 'relayed' | 'expanded';
  readonly status: string;
  readonly diagnosticCode?: string;
  readonly originalRecipient?: string;
}

export interface DeliveryStatusNotification {
  readonly reportingMta?: string;
  readonly originalEnvelopeId?: string;
  readonly recipients: readonly DeliveryStatusRecipient[];
  readonly feedbackKind:
    'delivered' | 'delivery_failed' | 'bounced' | 'unsupported';
}

function unfoldHeaders(section: string): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  const unfolded = section.replace(/\r?\n[ \t]+/gu, ' ');
  for (const line of unfolded.split(/\r?\n/gu)) {
    const separator = line.indexOf(':');
    if (separator < 1) {
      continue;
    }
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return headers;
}

function addressPart(value: string): string {
  const separator = value.indexOf(';');
  return (separator === -1 ? value : value.slice(separator + 1))
    .trim()
    .toLowerCase();
}

export function parseRfc3464DeliveryStatus(
  raw: string,
): DeliveryStatusNotification {
  if (
    !/Content-Type:\s*multipart\/report[^\r\n]*report-type\s*=\s*"?delivery-status/iu.test(
      raw,
    )
  ) {
    throw new Error('RFC3464_DELIVERY_STATUS_REQUIRED');
  }
  const deliveryPart = raw.match(
    /Content-Type:\s*message\/delivery-status[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?\r?\n([\s\S]*?)(?=\r?\n--[^\r\n]+(?:--)?\r?\n)/iu,
  )?.[1];
  if (deliveryPart === undefined) {
    throw new Error('RFC3464_DELIVERY_PART_MISSING');
  }
  const blocks = deliveryPart
    .trim()
    .split(/\r?\n\r?\n/gu)
    .map(unfoldHeaders);
  const perMessage = blocks[0] ?? new Map<string, string>();
  const recipients = blocks.slice(1).map((headers): DeliveryStatusRecipient => {
    const finalRecipient = headers.get('final-recipient');
    const action = headers.get('action')?.toLowerCase();
    const status = headers.get('status');
    if (
      finalRecipient === undefined ||
      status === undefined ||
      (action !== 'delivered' &&
        action !== 'delayed' &&
        action !== 'failed' &&
        action !== 'relayed' &&
        action !== 'expanded')
    ) {
      throw new Error('RFC3464_RECIPIENT_BLOCK_INVALID');
    }
    const diagnosticCode = headers.get('diagnostic-code');
    const originalRecipient = headers.get('original-recipient');
    return {
      finalRecipient: addressPart(finalRecipient),
      action,
      status,
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
      ...(originalRecipient === undefined
        ? {}
        : { originalRecipient: addressPart(originalRecipient) }),
    };
  });
  if (recipients.length === 0) {
    throw new Error('RFC3464_RECIPIENT_REQUIRED');
  }
  const actions = new Set(recipients.map((recipient) => recipient.action));
  const feedbackKind = actions.has('failed')
    ? 'bounced'
    : actions.has('delayed')
      ? 'delivery_failed'
      : [...actions].every(
            (action) => action === 'delivered' || action === 'relayed',
          )
        ? 'delivered'
        : 'unsupported';
  return {
    ...(perMessage.get('reporting-mta') === undefined
      ? {}
      : { reportingMta: perMessage.get('reporting-mta') }),
    ...(perMessage.get('original-envelope-id') === undefined
      ? {}
      : { originalEnvelopeId: perMessage.get('original-envelope-id') }),
    recipients,
    feedbackKind,
  };
}

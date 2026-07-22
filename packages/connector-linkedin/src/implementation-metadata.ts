export const linkedinExternalAccessStatus = Object.freeze({
  state: 'blocked_external_access' as const,
  externalEffects: 'disabled' as const,
  inboxRead: 'unknown' as const,
  inboxHistory: 'unknown' as const,
  send: 'unknown' as const,
  threads: 'unknown' as const,
  attachments: 'unknown' as const,
  deliveryFeedback: 'unknown' as const,
  archiveImport: 'read_only_independent_capability' as const,
  reason:
    'Approved LinkedIn Communication API entitlement has not been proven for this release.',
});

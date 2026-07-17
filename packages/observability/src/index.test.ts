import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { describe, expect, it } from 'vitest';

import { createObservability } from './index.js';

function serializedNamespace(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const { metrics } = createObservability('observability-test', environment);
  metrics.addMetric('NamespaceProbe', MetricUnit.Count, 1);
  return metrics.serializeMetrics()._aws.CloudWatchMetrics[0]?.Namespace ?? '';
}

describe('createObservability', () => {
  it('uses the deployment-provided metrics namespace', () => {
    expect(
      serializedNamespace({ POWERTOOLS_METRICS_NAMESPACE: 'ChiefProduct' }),
    ).toBe('ChiefProduct');
  });

  it('retains the stable local default when the namespace is absent or blank', () => {
    expect(serializedNamespace({})).toBe('ChiefFoundation');
    expect(serializedNamespace({ POWERTOOLS_METRICS_NAMESPACE: '   ' })).toBe(
      'ChiefFoundation',
    );
  });
});

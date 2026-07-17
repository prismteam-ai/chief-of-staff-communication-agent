#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { ChiefFoundationStack } from '../lib/chief-foundation-stack.js';
import { ChiefProductStack } from '../lib/chief-product-stack.js';

const app = new cdk.App();
const account = String(
  app.node.tryGetContext('account') ??
    process.env.CDK_DEFAULT_ACCOUNT ??
    '417242953053',
);
const region = String(
  app.node.tryGetContext('region') ??
    process.env.CDK_DEFAULT_REGION ??
    'us-east-2',
);

new ChiefFoundationStack(app, 'ChiefFoundationStack', {
  env: { account, region },
});

new ChiefProductStack(app, 'ChiefProductStack', {
  env: { account, region },
});

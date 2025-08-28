#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

import { LobeChatStack } from '../lib/lobechat-stack';

// Require LOBECHAT_ROOT_DOMAIN to be set
const envRootDomain = (process.env.LOBECHAT_ROOT_DOMAIN ?? '').trim();
if (!envRootDomain) {
  throw new Error(
    'LOBECHAT_ROOT_DOMAIN is required. Example: export LOBECHAT_ROOT_DOMAIN="some-domain.com"',
  );
}

const app = new cdk.App();
app.node.setContext('lobechat:rootDomain', envRootDomain.trim());

const stage = app.node.tryGetContext('lobechat:stage') ?? 'dev';
const stackName = `LobeChat-${stage}`;

new LobeChatStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  stage,
});

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

import { LobeChatStack } from "../lib/lobechat-stack";

test("synthesizes", () => {
  const app = new cdk.App({ context: { "lobechat:stage": "dev" } });
  const stack = new LobeChatStack(app, "TestStack", { stage: "dev" });
  const template = Template.fromStack(stack);
  // Basic resources exist in the current architecture
  // Aurora Serverless v2 cluster with a single writer instance
  template.resourceCountIs("AWS::RDS::DBCluster", 1);
  template.resourceCountIs("AWS::RDS::DBInstance", 1);
  // Two Lambdas: PgvectorInitFn (custom resource) and AppFn (API handler)
  template.resourceCountIs("AWS::Lambda::Function", 4);
  // API Gateway fronting the Lambda
  template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  // Secrets: RDS generated credentials, databaseUrlSecret, nextAuthSecret, keyVaultsSecret
  template.resourceCountIs("AWS::SecretsManager::Secret", 4);
});

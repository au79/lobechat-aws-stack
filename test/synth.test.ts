import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

import { LobeChatStack } from "../lib/lobechat-stack";

test("synthesizes", () => {
  const app = new cdk.App({ context: { "lobechat:stage": "dev" } });
  const stack = new LobeChatStack(app, "TestStack", { stage: "dev" });
  const template = Template.fromStack(stack);
  // Basic resources exist
  template.resourceCountIs("AWS::RDS::DBInstance", 1);
  template.resourceCountIs("AWS::ECS::Service", 1);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
});

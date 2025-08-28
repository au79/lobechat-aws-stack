import type { StackProps } from "aws-cdk-lib";
import {
  aws_apigateway as apigw,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
  aws_route53_targets as route53Targets,
  aws_secretsmanager as secretsmanager,
  CfnOutput,
  custom_resources as cr,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

interface Props extends StackProps {
  stage: string;
}

export class LobeChatStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    // Apply permissions boundary to all IAM Roles in this stack
    const permissionsBoundaryName: string =
      (this.node.tryGetContext("permissionsBoundaryName") as
        | string
        | undefined) ?? "cdk-permission-boundary";

    const permissionsBoundary = iam.ManagedPolicy.fromManagedPolicyName(
      this,
      "CdkPermissionsBoundary",
      permissionsBoundaryName,
    );
    iam.PermissionsBoundary.of(this).apply(permissionsBoundary);

    const stage = props.stage;

    // Context / parameters
    const dbName = this.node.tryGetContext("lobechat:dbName") ?? "lobechat";
    const nextAuthSsoProviders =
      this.node.tryGetContext("lobechat:nextAuthSsoProviders") ?? "";
    const rootDomain: string | undefined = this.node.tryGetContext(
      "lobechat:rootDomain",
    );
    const subdomain: string =
      this.node.tryGetContext("lobechat:subdomain") ?? "lobechat";
    const domainName = rootDomain ? `${subdomain}.${rootDomain}` : undefined;
    const hostedZone = rootDomain
      ? route53.HostedZone.fromLookup(this, "HostedZone", {
          domainName: rootDomain,
        })
      : undefined;
    const certificate =
      domainName && hostedZone
        ? new acm.DnsValidatedCertificate(this, "ApiCertificate", {
            domainName,
            hostedZone,
            region: Stack.of(this).region,
          })
        : undefined;

    // VPC - single AZ, NAT instance for egress, separate subnets
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 1,
      natGatewayProvider: ec2.NatProvider.instanceV2({
        instanceType: new ec2.InstanceType("t3.nano"),
      }),
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC },
        {
          name: "private-egress",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        { name: "private-db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Security groups
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "RDS Postgres security group",
      allowAllOutbound: true,
    });

    // Aurora Serverless v2 for PostgreSQL (pgvector-capable version)
    const db = new rds.DatabaseCluster(this, "Postgres", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        // Version must support pgvector; 15.x is generally supported
        version: rds.AuroraPostgresEngineVersion.VER_15_4,
      }),
      defaultDatabaseName: dbName,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      writer: rds.ClusterInstance.serverlessV2("Writer"), // readers: [rds.ClusterInstance.serverlessV2("Reader")], // optional
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
      deletionProtection: false,
      removalPolicy:
        stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });

    const dbSecret = db.secret!;
    // Create an empty DATABASE_URL secret; it will be populated by the init Lambda
    const databaseUrlSecret = new secretsmanager.Secret(
      this,
      "DatabaseUrlSecret",
      {
        description: "LobeChat DATABASE_URL",
        removalPolicy:
          stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );

    // Secrets for LobeChat
    const keyVaultsSecret = new secretsmanager.Secret(this, "KeyVaultsSecret", {
      description: "LobeChat KEY_VAULTS_SECRET",
    });

    const nextAuthSecret = new secretsmanager.Secret(this, "NextAuthSecret", {
      description: "LobeChat NEXT_AUTH_SECRET",
    });

    // Security group for the init Lambda
    const dbInitFnSg = new ec2.SecurityGroup(this, "DbInitFnSg", {
      vpc,
      description: "Lambda SG for DB init",
      allowAllOutbound: true,
    });

    // Dedicated LogGroup for the init Lambda
    const dbInitFnLogGroup = new logs.LogGroup(this, "PgvectorInitFnLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Custom Resource to enable pgvector extension in the DB
    const dbInitFn = new lambdaNode.NodejsFunction(this, "PgvectorInitFn", {
      entry: "lambda/db-init.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(2),
      memorySize: 256,
      bundling: {
        externalModules: [], // bundle everything including pg and aws-sdk-v3 clients
        target: "node20",
      },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbInitFnSg],
      environment: {
        DATABASE_URL_SECRET_ARN: databaseUrlSecret.secretArn,
        DB_SECRET_ARN: dbSecret.secretArn,
        DB_HOST: db.clusterEndpoint.hostname,
        DB_PORT: db.clusterEndpoint.port.toString(),
        DB_NAME: dbName,
      },
      logGroup: dbInitFnLogGroup,
    });

    db.secret?.grantRead(dbInitFn);
    databaseUrlSecret.grantWrite(dbInitFn);
    // Allow Lambda to connect to DB
    db.connections.allowFrom(
      dbInitFn,
      ec2.Port.tcp(5432),
      "Allow Lambda to connect to Postgres",
    );

    const dbInitProvider = new cr.Provider(this, "PgvectorProvider", {
      onEventHandler: dbInitFn,
    });

    // Tie CR lifecycle to DB instance changes
    const dbInit = new CustomResource(this, "PgvectorInit", {
      serviceToken: dbInitProvider.serviceToken,
      properties: {
        DbEndpoint: db.clusterEndpoint.socketAddress,
        DbSecretArn: dbSecret.secretArn,
        DbName: dbName,
      },
    });
    dbInit.node.addDependency(db);

    // App Lambda (placeholder) in VPC
    const appFn = new lambdaNode.NodejsFunction(this, "AppFn", {
      entry: "lambda/app-handler.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(29),
      memorySize: 512,
      bundling: { target: "node20" },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbInitFnSg],
      environment: {
        // DATABASE_URL injected at deploy-time from Custom Resource output (no runtime Secrets Manager call)
        DATABASE_URL: dbInit.getAttString("DatabaseUrl"),
        NEXT_AUTH_SSO_PROVIDERS: nextAuthSsoProviders, // The following are placeholders if/when the app reads them
        KEY_VAULTS_SECRET_ARN: keyVaultsSecret.secretArn,
        NEXT_AUTH_SECRET_ARN: nextAuthSecret.secretArn,
      },
    });
    // Allow App Lambda to reach DB
    db.connections.allowFrom(
      appFn,
      ec2.Port.tcp(5432),
      "App Lambda to Postgres",
    );

    // API Gateway fronting the Lambda (optional custom domain)
    const restApi = new apigw.LambdaRestApi(this, "LobeChatApi", {
      handler: appFn,
      proxy: true,
      deployOptions: {
        stageName: "prod",
      },
      domainName:
        domainName && certificate
          ? {
              domainName,
              certificate,
              endpointType: apigw.EndpointType.REGIONAL,
              securityPolicy: apigw.SecurityPolicy.TLS_1_2,
            }
          : undefined,
    });
    if (domainName && hostedZone) {
      new route53.ARecord(this, "ApiAliasRecord", {
        zone: hostedZone,
        recordName: subdomain,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGateway(restApi),
        ),
      });
    }
    const appUrl = domainName ? `https://${domainName}` : restApi.url;
    const nextAuthUrl = `${appUrl}api/auth`;
    appFn.addEnvironment("APP_URL", appUrl);
    appFn.addEnvironment("NEXTAUTH_URL", nextAuthUrl);

    // Ensure DATABASE_URL is prepared before App Lambda finalizes
    appFn.node.addDependency(dbInit);

    // Outputs
    new CfnOutput(this, "LobeChatUrl", {
      value: appUrl,
      description: "LobeChat URL",
    });
    new CfnOutput(this, "DatabaseEndpoint", {
      value: db.clusterEndpoint.socketAddress,
      description: "RDS endpoint",
    });
    new CfnOutput(this, "DatabaseSecretArn", {
      value: dbSecret.secretArn,
      description: "RDS credentials secret ARN",
    });
    new CfnOutput(this, "DatabaseUrlSecretArn", {
      value: databaseUrlSecret.secretArn,
      description: "DATABASE_URL secret ARN",
    });
    new CfnOutput(this, "NextAuthSecretArn", {
      value: nextAuthSecret.secretArn,
    });
    new CfnOutput(this, "KeyVaultsSecretArn", {
      value: keyVaultsSecret.secretArn,
    });
  }
}

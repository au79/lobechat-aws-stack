import type { StackProps } from "aws-cdk-lib";
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecs_patterns as ecs_patterns,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
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

    const stage = props.stage;

    // Context / parameters
    const cpu = Number(this.node.tryGetContext("lobechat:cpu") ?? "512"); // 0.5 vCPU
    const memoryMiB = Number(
      this.node.tryGetContext("lobechat:memoryMiB") ?? "1024",
    );
    const desiredCount = Number(
      this.node.tryGetContext("lobechat:desiredCount") ?? "1",
    );
    const dbInstanceType =
      this.node.tryGetContext("lobechat:dbInstanceType") ?? "t3.micro";
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

    // VPC - 2 AZs, public subnets only for simplicity (ECS gets public IP, RDS stays private)
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC },
        { name: "private-db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Security groups
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "RDS Postgres security group",
      allowAllOutbound: true,
    });

    // RDS for PostgreSQL (pgvector-capable version)
    const db = new rds.DatabaseInstance(this, "Postgres", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      engine: rds.DatabaseInstanceEngine.postgres({
        // Choose a version that supports pgvector extension
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass[
          dbInstanceType
            .split(".")[0]
            .toUpperCase() as keyof typeof ec2.InstanceClass
        ],
        ec2.InstanceSize[
          dbInstanceType
            .split(".")[1]
            .toUpperCase() as keyof typeof ec2.InstanceSize
        ],
      ),
      allocatedStorage: 20,
      storageEncrypted: true,
      publiclyAccessible: false,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"), // Secret contains username/password/dbname
      databaseName: dbName,
      backupRetention: Duration.days(0),
      deletionProtection: false,
      removalPolicy:
        stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      enablePerformanceInsights: false,
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
    // VPC Interface Endpoint for Secrets Manager so Lambda in isolated subnets can read secrets
    const smEndpointSg = new ec2.SecurityGroup(
      this,
      "SecretsManagerEndpointSg",
      {
        vpc,
        description: "SG for Secrets Manager interface endpoint",
        allowAllOutbound: true,
      },
    );
    smEndpointSg.addIngressRule(
      dbInitFnSg,
      ec2.Port.tcp(443),
      "Allow Lambda to reach Secrets Manager endpoint",
    );
    new ec2.InterfaceVpcEndpoint(this, "SecretsManagerVpcEndpoint", {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [smEndpointSg],
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
      // vpc,
      // vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // Lambda in public subnets with public IP
      // securityGroups: [
      //   new ec2.SecurityGroup(this, 'DbInitFnSg', {
      //     vpc,
      //     description: 'Lambda SG for DB init'
      //   })
      // ],
      vpc,
      // Place Lambda in isolated subnets; it can reach RDS directly and Secrets Manager via the VPC endpoint
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbInitFnSg],
      environment: {
        DB_SECRET_ARN: dbSecret.secretArn,
        DB_HOST: db.instanceEndpoint.hostname,
        DB_PORT: db.instanceEndpoint.port.toString(),
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
        DbEndpoint: db.instanceEndpoint.socketAddress,
        DbSecretArn: dbSecret.secretArn,
        DbName: dbName,
      },
    });
    dbInit.node.addDependency(db);

    // ECS logs in a dedicated LogGroup
    const lobeChatLogGroup = new logs.LogGroup(this, "LobeChatLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy:
        stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ECS Fargate with ALB
    const albFargate = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "LobeChatService",
      {
        vpc,
        cpu,
        memoryLimitMiB: memoryMiB,
        desiredCount,
        publicLoadBalancer: true,
        assignPublicIp: true,
        listenerPort: domainName ? 443 : 80,
        domainName,
        domainZone: hostedZone,
        redirectHTTP: domainName ? true : undefined,
        taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        taskImageOptions: {
          containerName: "lobe-chat",
          containerPort: 3210,
          image: ecs.ContainerImage.fromRegistry("lobehub/lobe-chat-database"),
          enableLogging: true,
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: "lobe-chat",
            logGroup: lobeChatLogGroup,
          }),
          environment: {
            // Will be finalized after we know ALB DNS
            NEXT_AUTH_SSO_PROVIDERS: nextAuthSsoProviders,
          },
          secrets: {
            DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrlSecret),
            KEY_VAULTS_SECRET: ecs.Secret.fromSecretsManager(keyVaultsSecret),
            NEXT_AUTH_SECRET: ecs.Secret.fromSecretsManager(nextAuthSecret),
          },
        },
      },
    );

    // Allow ECS tasks to reach RDS
    db.connections.allowFrom(
      albFargate.service,
      ec2.Port.tcp(5432),
      "ECS tasks to Postgres",
    );

    const appUrl = domainName
      ? `https://${domainName}`
      : `http://${albFargate.loadBalancer.loadBalancerDnsName}`;
    const nextAuthUrl = `${appUrl}/api/auth`;

    // Inject APP_URL and NEXTAUTH_URL after we have the ALB
    const container = albFargate.taskDefinition.defaultContainer!;
    container.addEnvironment("APP_URL", appUrl);
    container.addEnvironment("NEXTAUTH_URL", nextAuthUrl);

    // Ensure DATABASE_URL is prepared before Service creation
    albFargate.node.addDependency(dbInit);

    // Outputs
    new CfnOutput(this, "LobeChatUrl", {
      value: appUrl,
      description: "LobeChat URL",
    });
    new CfnOutput(this, "DatabaseEndpoint", {
      value: db.instanceEndpoint.socketAddress,
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

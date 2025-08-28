import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";

type CfnEvent = {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  [k: string]: unknown;
};

const { DB_SECRET_ARN, DB_HOST, DB_PORT, DB_NAME, DATABASE_URL_SECRET_ARN } =
  process.env;

const sm = new SecretsManagerClient({});

export const handler = async (event: CfnEvent) => {
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: "pgvector-init" };
  }

  if (
    !DB_SECRET_ARN ||
    !DB_HOST ||
    !DB_PORT ||
    !DB_NAME ||
    !DATABASE_URL_SECRET_ARN
  ) {
    throw new Error("Missing required environment variables for DB init");
  }

  const secret = await sm.send(
    new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }),
  );
  if (!secret.SecretString) throw new Error("DB secret has no SecretString");

  const parsed = JSON.parse(secret.SecretString) as {
    username: string;
    password: string;
  };

  const client = new Client({
    host: DB_HOST,
    port: Number(DB_PORT),
    database: DB_NAME,
    user: parsed.username,
    password: parsed.password,
    // ssl: { rejectUnauthorized: false } // optional if you enforce SSL
  });

  try {
    await client.connect();
    // Enable pgvector extension idempotently
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

    // Compose and store DATABASE_URL for the app
    const databaseUrl =
      `postgres://` +
      encodeURIComponent(parsed.username) +
      ":" +
      encodeURIComponent(parsed.password) +
      "@" +
      DB_HOST +
      ":" +
      DB_PORT +
      "/" +
      DB_NAME;
    await sm.send(
      new PutSecretValueCommand({
        SecretId: DATABASE_URL_SECRET_ARN,
        SecretString: databaseUrl,
      }),
    );
    // Return as Custom Resource Data so CDK can inject into Lambda env at deploy time
    return {
      PhysicalResourceId: "pgvector-init",
      Data: {
        DatabaseUrl: databaseUrl,
      },
    };
  } finally {
    await client.end();
  }

  return { PhysicalResourceId: "pgvector-init" };
};

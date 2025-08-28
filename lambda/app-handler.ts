import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // Placeholder app Lambda.
  // TODO: Replace with Lambda Web Adapter container image that runs LobeChat HTTP server.
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/plain' },
    body: `LobeChat placeholder is running.
Path: ${event.rawPath}
Query: ${JSON.stringify(event.queryStringParameters ?? {})}
`,
  };
};

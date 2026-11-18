import { z } from 'zod';
import { OPENAPI_ROUTES, exposedPath, type OpenApiRoute } from './openapi.routes';

type JsonObject = Record<string, unknown>;

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error', 'correlationId'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    correlationId: { type: 'string' },
  },
} as const;

function inputSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonObject;
  delete json.$schema;
  return json;
}

function queryParameters(schema: z.ZodType): JsonObject[] {
  const json = inputSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: property,
  }));
}

function operationId(route: OpenApiRoute): string {
  return [route.method, ...route.path.split('/')]
    .map((part) => part.replace(/^:/, 'by_').replace(/[^A-Za-z0-9_]/g, '_'))
    .join('_');
}

function operation(route: OpenApiRoute): JsonObject {
  const parameters: JsonObject[] = [];
  for (const name of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    parameters.push({
      name: name[1],
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  }
  if (route.query) parameters.push(...queryParameters(route.query));
  if (route.idempotencyKey) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: '8–100 characters. Reusing a key with the same request replays its response.',
      schema: { type: 'string', minLength: 8, maxLength: 100 },
    });
  }

  const contentType = route.responseContentType ?? 'application/json';
  const response: JsonObject = { description: 'Successful response.' };
  response.content = {
    [contentType]: { schema: contentType === 'application/json' ? {} : { type: 'string' } },
  };
  const responses: JsonObject = {
    [String(route.responseStatus ?? (route.method === 'post' ? 201 : 200))]: response,
    '400': {
      description: 'The request failed validation.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  };
  if (!route.public) {
    responses['401'] = {
      description: 'No valid session cookie.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
    responses['403'] = {
      description: 'The signed-in role or store scope is not allowed.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  const result: JsonObject = {
    operationId: operationId(route),
    tags: [route.tag],
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    security: route.public ? [] : [{ sessionCookie: [] }],
    responses,
  };
  if (parameters.length) result.parameters = parameters;
  if (route.body) {
    result.requestBody = {
      required: true,
      content: { 'application/json': { schema: inputSchema(route.body) } },
    };
  }
  return result;
}

export function buildOpenApiDocument(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const route of OPENAPI_ROUTES) {
    const path = exposedPath(route);
    const item = (paths[path] ??= {});
    item[route.method] = operation(route);
  }
  const tags = [...new Set(OPENAPI_ROUTES.map((route) => route.tag))].map((name) => ({ name }));
  return {
    openapi: '3.1.0',
    info: {
      title: 'RetailPulse API',
      version: '2.0.0',
      description:
        'API for an independent inventory simulation. All included demo and forecast data is synthetic.',
    },
    servers: [{ url: '/', description: 'Current RetailPulse API origin' }],
    tags,
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'rp_session',
          description: 'HttpOnly session cookie set by POST /api/v1/auth/login.',
        },
      },
      schemas: { Error: ERROR_SCHEMA },
    },
  };
}

export const OPENAPI_DOCUMENT = buildOpenApiDocument();

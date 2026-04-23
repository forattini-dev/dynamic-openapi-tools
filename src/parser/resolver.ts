import { validate, dereference } from '@readme/openapi-parser'
import type { OpenAPIV3 } from 'openapi-types'
import type { ExternalDocs, ParsedExample, ParsedLink, ParsedOperation, ParsedParameter, ParsedRequestBody, ParsedResponse, ParsedServer, ParsedSpec, ParsedTag } from './types.js'

export async function resolveSpec(doc: OpenAPIV3.Document): Promise<ParsedSpec> {
  const validation = await validate(structuredClone(doc))
  if (!validation.valid) {
    const validationResult = validation as { valid: false; errors?: unknown[]; warnings?: unknown[] }
    const errors = validationResult.errors ?? []
    throw new Error(`Invalid OpenAPI spec: ${JSON.stringify(errors)}`)
  }
  const dereferenced = (await dereference(structuredClone(doc))) as OpenAPIV3.Document

  const operations = extractOperations(dereferenced)
  const schemas = extractSchemas(dereferenced)
  const securitySchemes = extractSecuritySchemes(dereferenced)
  const servers = extractServers(dereferenced)
  const tags = extractTags(dereferenced)
  const externalDocs = extractExternalDocs(dereferenced.externalDocs as OpenAPIV3.ExternalDocumentationObject | undefined)

  return {
    title: dereferenced.info.title,
    version: dereferenced.info.version,
    description: dereferenced.info.description,
    servers,
    operations,
    schemas,
    securitySchemes,
    tags,
    externalDocs,
    raw: dereferenced,
  }
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'] as const

function extractOperations(doc: OpenAPIV3.Document): ParsedOperation[] {
  const operations: ParsedOperation[] = []
  const paths = doc.paths ?? {}

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue

    const pathParams = (pathItem.parameters ?? []) as OpenAPIV3.ParameterObject[]

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!operation) continue

      const operationParams = (operation.parameters ?? []) as OpenAPIV3.ParameterObject[]
      const allParams = mergeParameters(pathParams, operationParams)

      const operationId =
        operation.operationId ?? generateOperationId(method, path)

      const parameters: ParsedParameter[] = allParams.map((p) => ({
        name: p.name,
        in: p.in as ParsedParameter['in'],
        required: p.required ?? p.in === 'path',
        description: p.description,
        schema: (p.schema as OpenAPIV3.SchemaObject) ?? { type: 'string' },
        example: p.example,
        examples: p.examples ? extractExamples(p.examples as Record<string, OpenAPIV3.ExampleObject>) : undefined,
        deprecated: p.deprecated,
      }))

      let requestBody: ParsedRequestBody | undefined
      if (operation.requestBody) {
        const rb = operation.requestBody as OpenAPIV3.RequestBodyObject
        const content: ParsedRequestBody['content'] = {}
        for (const [mediaType, mediaObj] of Object.entries(rb.content ?? {})) {
          if (mediaObj.schema) {
            content[mediaType] = {
              schema: mediaObj.schema as OpenAPIV3.SchemaObject,
              example: mediaObj.example,
              examples: mediaObj.examples ? extractExamples(mediaObj.examples as Record<string, OpenAPIV3.ExampleObject>) : undefined,
            }
          }
        }
        requestBody = {
          required: rb.required ?? false,
          description: rb.description,
          content,
        }
      }

      const responses: Record<string, ParsedResponse> = {}
      for (const [code, resp] of Object.entries(operation.responses ?? {})) {
        responses[code] = extractResponse(resp as OpenAPIV3.ResponseObject)
      }

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary,
        description: operation.description,
        deprecated: operation.deprecated,
        hidden: (operation as Record<string, unknown>)['x-hidden'] === true,
        parameters,
        requestBody,
        responses,
        security: operation.security ?? doc.security ?? [],
        tags: operation.tags ?? [],
        externalDocs: extractExternalDocs(operation.externalDocs),
      })
    }
  }

  return operations
}

function extractResponse(resp: OpenAPIV3.ResponseObject): ParsedResponse {
  const parsed: ParsedResponse = {
    description: resp.description ?? '',
    content: {},
  }

  if (resp.content) {
    for (const [mediaType, mediaObj] of Object.entries(resp.content)) {
      parsed.content![mediaType] = {
        schema: mediaObj.schema as OpenAPIV3.SchemaObject | undefined,
      }

      // Pick the primary schema (prefer JSON)
      if (!parsed.schema && mediaObj.schema) {
        parsed.schema = mediaObj.schema as OpenAPIV3.SchemaObject
        parsed.mediaType = mediaType
      }

      // Pick example from first media type that has one
      if (parsed.example === undefined && mediaObj.example !== undefined) {
        parsed.example = mediaObj.example
      }
      if (!parsed.examples && mediaObj.examples) {
        parsed.examples = extractExamples(mediaObj.examples as Record<string, OpenAPIV3.ExampleObject>)
      }
    }
  }

  if (resp.links) {
    parsed.links = extractLinks(resp.links as Record<string, OpenAPIV3.LinkObject>)
  }

  return parsed
}

function extractExamples(examples: Record<string, OpenAPIV3.ExampleObject>): Record<string, ParsedExample> {
  const result: Record<string, ParsedExample> = {}
  for (const [name, ex] of Object.entries(examples)) {
    result[name] = {
      summary: ex.summary,
      description: ex.description,
      value: ex.value,
    }
  }
  return result
}

function extractLinks(links: Record<string, OpenAPIV3.LinkObject>): Record<string, ParsedLink> {
  const result: Record<string, ParsedLink> = {}
  for (const [name, link] of Object.entries(links)) {
    result[name] = {
      operationId: link.operationId,
      operationRef: link.operationRef,
      parameters: link.parameters as Record<string, string> | undefined,
      description: link.description,
    }
  }
  return result
}

function generateOperationId(method: string, path: string): string {
  const cleaned = path
    .replace(/\{([^}]+)\}/g, 'by_$1')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  return `${method}_${cleaned}`.toLowerCase()
}

function mergeParameters(
  pathParams: OpenAPIV3.ParameterObject[],
  operationParams: OpenAPIV3.ParameterObject[]
): OpenAPIV3.ParameterObject[] {
  const merged = new Map<string, OpenAPIV3.ParameterObject>()

  for (const p of pathParams) {
    merged.set(`${p.in}:${p.name}`, p)
  }

  for (const p of operationParams) {
    merged.set(`${p.in}:${p.name}`, p)
  }

  return Array.from(merged.values())
}

function extractSchemas(doc: OpenAPIV3.Document): Record<string, OpenAPIV3.SchemaObject> {
  const schemas: Record<string, OpenAPIV3.SchemaObject> = {}
  const components = doc.components?.schemas ?? {}

  for (const [name, schema] of Object.entries(components)) {
    schemas[name] = schema as OpenAPIV3.SchemaObject
  }

  return schemas
}

function extractSecuritySchemes(doc: OpenAPIV3.Document): Record<string, OpenAPIV3.SecuritySchemeObject> {
  const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {}
  const components = doc.components?.securitySchemes ?? {}

  for (const [name, scheme] of Object.entries(components)) {
    schemes[name] = scheme as OpenAPIV3.SecuritySchemeObject
  }

  return schemes
}

function extractServers(doc: OpenAPIV3.Document): ParsedServer[] {
  return (doc.servers ?? []).map((s) => {
    const server: ParsedServer = { url: s.url }
    if (s.description) server.description = s.description
    if (s.variables) {
      server.variables = {}
      for (const [name, v] of Object.entries(s.variables)) {
        server.variables[name] = {
          default: v.default,
          enum: v.enum,
          description: v.description,
        }
      }
    }
    return server
  })
}

function extractTags(doc: OpenAPIV3.Document): ParsedTag[] {
  return (doc.tags ?? []).map((t) => {
    const tag: ParsedTag = { name: t.name }
    if (t.description) tag.description = t.description
    if (t.externalDocs) {
      tag.externalDocs = {
        url: t.externalDocs.url,
        description: t.externalDocs.description,
      }
    }
    return tag
  })
}

function extractExternalDocs(docs: OpenAPIV3.ExternalDocumentationObject | undefined): ExternalDocs | undefined {
  if (!docs) return undefined
  return {
    url: docs.url,
    description: docs.description,
  }
}

import type { OpenAPIV3 } from 'openapi-types'

export interface ParsedServerVariable {
  enum?: string[]
  default: string
  description?: string
}

export interface ParsedServer {
  url: string
  description?: string
  variables?: Record<string, ParsedServerVariable>
}

export interface ParsedTag {
  name: string
  description?: string
  externalDocs?: { url: string; description?: string }
}

export interface ExternalDocs {
  url: string
  description?: string
}

export interface ParsedExample {
  summary?: string
  description?: string
  value?: unknown
}

export interface ParsedLink {
  operationId?: string
  operationRef?: string
  parameters?: Record<string, string>
  description?: string
}

export interface ParsedResponse {
  description: string
  content?: Record<string, { schema?: OpenAPIV3.SchemaObject }>
  schema?: OpenAPIV3.SchemaObject
  mediaType?: string
  example?: unknown
  examples?: Record<string, ParsedExample>
  links?: Record<string, ParsedLink>
}

export interface ParsedOperation {
  operationId: string
  method: string
  path: string
  summary?: string
  description?: string
  deprecated?: boolean
  /** Set by the `x-hidden: true` vendor extension on the operation. Hidden ops are always removed by `filterOperations`. */
  hidden?: boolean
  parameters: ParsedParameter[]
  requestBody?: ParsedRequestBody
  responses: Record<string, ParsedResponse>
  security: OpenAPIV3.SecurityRequirementObject[]
  tags: string[]
  externalDocs?: ExternalDocs
}

export interface ParsedParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  description?: string
  schema: OpenAPIV3.SchemaObject
  example?: unknown
  examples?: Record<string, ParsedExample>
  deprecated?: boolean
}

export interface ParsedRequestBody {
  required: boolean
  description?: string
  content: Record<string, { schema: OpenAPIV3.SchemaObject; example?: unknown; examples?: Record<string, ParsedExample> }>
}

export interface ParsedSpec {
  title: string
  version: string
  description?: string
  servers: ParsedServer[]
  operations: ParsedOperation[]
  schemas: Record<string, OpenAPIV3.SchemaObject>
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>
  tags: ParsedTag[]
  externalDocs?: ExternalDocs
  raw: OpenAPIV3.Document
}

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { notFound, usageError } from '../errors.ts'
import { fileForm, type AtlassianClient, type QueryValue } from '../http/client.ts'

export const PRODUCTS = ['jira', 'agile', 'confluence', 'confluence-v1'] as const
export type Product = (typeof PRODUCTS)[number]

export type JsonSchema = Record<string, unknown>

export interface Parameter {
  name: string
  in: 'path' | 'query'
  required?: boolean
  schema: JsonSchema
  description?: string
}

export interface Operation {
  id: string
  method: string
  path: string
  summary: string
  description?: string
  tags: string[]
  deprecated?: boolean
  scopes?: string[]
  parameters: Parameter[]
  body?: { contentType: string; required?: boolean; schema: JsonSchema }
}

interface Catalog {
  product: Product
  source: string
  generatedAt: string
  operations: Operation[]
  schemas: Record<string, JsonSchema>
}

const catalogs = new Map<Product, Catalog>()
const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog')

export function isProduct(value: string): value is Product {
  return (PRODUCTS as readonly string[]).includes(value)
}

export function loadCatalog(product: Product): Catalog {
  let catalog = catalogs.get(product)
  if (!catalog) {
    catalog = JSON.parse(readFileSync(path.join(catalogDir, `${product}.json`), 'utf8')) as Catalog
    catalogs.set(product, catalog)
  }
  return catalog
}

export function productOf(operation: Operation): Product {
  const product = operation.id.slice(0, operation.id.indexOf('.'))
  return isProduct(product) ? product : 'jira'
}

export function allOperations(products: readonly Product[] = PRODUCTS): Operation[] {
  return products.flatMap((product) => loadCatalog(product).operations)
}

export function findOperation(id: string): Operation {
  const dot = id.indexOf('.')
  const prefix = dot > 0 ? id.slice(0, dot) : ''
  if (isProduct(prefix)) {
    const found = loadCatalog(prefix).operations.find((operation) => operation.id === id)
    if (found) return found
  }
  const matches = allOperations().filter((operation) => operation.id.endsWith(`.${id}`))
  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length > 1) throw usageError(`"${id}" exists in several products: ${matches.map((operation) => operation.id).join(', ')}.`)
  throw notFound(`There is no operation "${id}".`, 'OPERATION_NOT_FOUND', 'Search with "atl api search <words>".')
}

export interface SearchOptions {
  products?: readonly Product[]
  tag?: string
  method?: string
  limit?: number
  includeDeprecated?: boolean
}

export function searchOperations(query: string, options: SearchOptions = {}): Operation[] {
  const words = query.toLowerCase().split(/[\s/._-]+/).filter((word) => word.length > 0)
  const scored: Array<{ operation: Operation; score: number }> = []
  for (const operation of allOperations(options.products ?? PRODUCTS)) {
    if (operation.deprecated && !options.includeDeprecated) continue
    if (options.tag && !operation.tags.some((tag) => tag.toLowerCase() === options.tag?.toLowerCase())) continue
    if (options.method && operation.method !== options.method.toUpperCase()) continue
    const id = operation.id.toLowerCase()
    const summary = operation.summary.toLowerCase()
    const route = operation.path.toLowerCase()
    const tags = operation.tags.join(' ').toLowerCase()
    const description = (operation.description ?? '').toLowerCase()
    let score = 0
    for (const word of words) {
      const hit = (id.includes(word) ? 4 : 0) + (summary.includes(word) ? 3 : 0) + (tags.includes(word) ? 2 : 0) + (route.includes(word) ? 2 : 0) + (description.includes(word) ? 1 : 0)
      if (hit === 0) {
        score = -1
        break
      }
      score += hit
    }
    if (words.length === 0) score = 1
    if (score > 0) scored.push({ operation, score })
  }
  scored.sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id))
  return scored.slice(0, options.limit ?? 25).map((entry) => entry.operation)
}

export function resolveSchema(product: Product, schema: unknown, depth = 3, seen: ReadonlySet<string> = new Set()): JsonSchema {
  if (Array.isArray(schema)) return schema.map((item) => resolveSchema(product, item, depth, seen)) as unknown as JsonSchema
  if (typeof schema !== 'object' || schema === null) return schema as JsonSchema
  const record = schema as JsonSchema
  const ref = record['$ref']
  if (typeof ref === 'string') {
    const target = loadCatalog(product).schemas[ref]
    if (!target || depth <= 0 || seen.has(ref)) {
      return { type: 'object', description: `${ref}${typeof record['description'] === 'string' ? `: ${record['description']}` : ''}` }
    }
    const resolved = resolveSchema(product, target, depth - 1, new Set([...seen, ref]))
    return typeof record['description'] === 'string' ? { ...resolved, description: record['description'] } : resolved
  }
  const output: JsonSchema = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'nullable') continue
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      output[key] = Object.fromEntries(Object.entries(value as JsonSchema).map(([name, inner]) => [name, resolveSchema(product, inner, depth, seen)]))
    } else if (key === 'items' || key === 'additionalProperties' || key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      output[key] = typeof value === 'boolean' ? value : resolveSchema(product, value, depth, seen)
    } else {
      output[key] = value
    }
  }
  return output
}

function isMultipart(operation: Operation): boolean {
  return operation.body?.contentType.startsWith('multipart/') ?? false
}

export function inputSchema(operation: Operation, depth = 2): JsonSchema {
  const product = productOf(operation)
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const parameter of operation.parameters) {
    const schema = resolveSchema(product, parameter.schema, depth)
    properties[parameter.name] = { ...schema, ...(parameter.description ? { description: parameter.description } : {}) }
    if (parameter.required) required.push(parameter.name)
  }
  if (operation.body) {
    if (isMultipart(operation)) {
      properties['file'] = { type: 'string', description: 'Absolute path of the local file to upload.' }
      required.push('file')
    } else {
      properties['body'] = { ...resolveSchema(product, operation.body.schema, depth), description: `Request body (${operation.body.contentType}).` }
      if (operation.body.required) required.push('body')
    }
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

export function describeOperation(operation: Operation, depth = 3): Record<string, unknown> {
  return {
    id: operation.id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    ...(operation.description ? { description: operation.description } : {}),
    tags: operation.tags,
    ...(operation.deprecated ? { deprecated: true } : {}),
    ...(operation.scopes ? { scopes: operation.scopes } : {}),
    input: inputSchema(operation, depth),
  }
}

export function buildRequest(operation: Operation, args: Record<string, unknown>): { path: string; query: Record<string, QueryValue>; body: unknown; file?: string } {
  const missing = operation.parameters.filter((parameter) => parameter.required && (args[parameter.name] === undefined || args[parameter.name] === null)).map((parameter) => parameter.name)
  if (operation.body?.required && !isMultipart(operation) && args['body'] === undefined) missing.push('body')
  if (isMultipart(operation) && typeof args['file'] !== 'string') missing.push('file')
  if (missing.length > 0) throw usageError(`${operation.id} needs: ${missing.join(', ')}.`, `Describe it with "atl api describe ${operation.id}".`)
  const known = new Set([...operation.parameters.map((parameter) => parameter.name), 'body', 'file'])
  const unknown = Object.keys(args).filter((key) => !known.has(key))
  if (unknown.length > 0) throw usageError(`${operation.id} does not take: ${unknown.join(', ')}.`, `Describe it with "atl api describe ${operation.id}".`)

  let route = operation.path
  const query: Record<string, QueryValue> = {}
  for (const parameter of operation.parameters) {
    const value = args[parameter.name]
    if (value === undefined || value === null) continue
    if (parameter.in === 'path') route = route.replace(`{${parameter.name}}`, encodeURIComponent(String(value)))
    else query[parameter.name] = Array.isArray(value) ? (value as Array<string | number | boolean>) : typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean)
  }
  return { path: route, query, body: args['body'], ...(typeof args['file'] === 'string' ? { file: args['file'] } : {}) }
}

export async function callOperation(client: AtlassianClient, operation: Operation, args: Record<string, unknown>): Promise<unknown> {
  const request = buildRequest(operation, args)
  if (request.file) {
    return client.request(request.path, { method: operation.method, query: request.query, form: await fileForm(request.file) })
  }
  return client.request(request.path, {
    method: operation.method,
    query: request.query,
    ...(request.body !== undefined ? { json: request.body } : {}),
  })
}

export function catalogStats(): Array<{ product: Product; operations: number; generatedAt: string }> {
  return PRODUCTS.map((product) => {
    const catalog = loadCatalog(product)
    return { product, operations: catalog.operations.length, generatedAt: catalog.generatedAt }
  })
}

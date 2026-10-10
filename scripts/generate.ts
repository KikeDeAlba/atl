import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface Source {
  product: string
  url: string
  prefix: string
}

const SOURCES: Source[] = [
  { product: 'jira', url: 'https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json', prefix: '' },
  { product: 'agile', url: 'https://dac-static.atlassian.com/cloud/jira/software/swagger.v3.json', prefix: '' },
  { product: 'confluence', url: 'https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json', prefix: '/wiki/api/v2' },
  { product: 'confluence-v1', url: 'https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json', prefix: '' },
]

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const
const SCHEMA_KEYS = new Set(['type', 'format', 'enum', 'items', 'properties', 'required', 'additionalProperties', '$ref', 'oneOf', 'anyOf', 'allOf', 'description', 'default', 'nullable', 'maxLength', 'minimum', 'maximum', 'readOnly'])

type Json = Record<string, unknown>

function shortText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const plain = value
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length === 0) return undefined
  const firstSentence = plain.split(/(?<=\.)\s/)[0] ?? plain
  const text = firstSentence.length <= limit ? firstSentence : `${plain.slice(0, limit - 1)}…`
  return text
}

function compactSchema(schema: unknown, prefix: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => compactSchema(item, prefix))
  if (typeof schema !== 'object' || schema === null) return schema
  const output: Json = {}
  for (const [key, value] of Object.entries(schema as Json)) {
    if (!SCHEMA_KEYS.has(key)) continue
    if (key === 'readOnly') continue
    if (key === 'description') {
      const text = shortText(value, 140)
      if (text) output['description'] = text
      continue
    }
    if (key === '$ref' && typeof value === 'string') {
      output['$ref'] = value.replace('#/components/schemas/', '')
      continue
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties: Json = {}
      for (const [name, property] of Object.entries(value as Json)) {
        if ((property as Json)?.['readOnly'] === true) continue
        properties[name] = compactSchema(property, prefix)
      }
      output['properties'] = properties
      continue
    }
    output[key] = compactSchema(value, prefix)
  }
  return output
}

function resolveParameter(spec: Json, parameter: Json): Json {
  const ref = parameter['$ref']
  if (typeof ref !== 'string') return parameter
  const name = ref.split('/').pop() ?? ''
  return ((spec['components'] as Json)?.['parameters'] as Json)?.[name] as Json ?? parameter
}

function resolveBody(spec: Json, body: Json): Json {
  const ref = body['$ref']
  if (typeof ref !== 'string') return body
  const name = ref.split('/').pop() ?? ''
  return ((spec['components'] as Json)?.['requestBodies'] as Json)?.[name] as Json ?? body
}

function scopesOf(operation: Json): string[] {
  const scopes = new Set<string>()
  for (const requirement of (operation['security'] as Json[] | undefined) ?? []) {
    for (const list of Object.values(requirement)) for (const scope of (list as string[]) ?? []) scopes.add(scope)
  }
  return [...scopes]
}

async function load(source: Source, cache: string): Promise<Json> {
  const file = path.join(cache, `${source.product}.json`)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Json
  } catch {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error(`${source.url} answered ${response.status}`)
    const text = await response.text()
    await mkdir(cache, { recursive: true })
    await writeFile(file, text)
    return JSON.parse(text) as Json
  }
}

function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, into))
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value as Json)) {
      if (key === '$ref' && typeof inner === 'string') into.add(inner)
      else collectRefs(inner, into)
    }
  }
}

async function generate(source: Source, cache: string, outDir: string): Promise<number> {
  const spec = await load(source, cache)
  const operations: Json[] = []
  const used = new Set<string>()
  for (const [route, item] of Object.entries(spec['paths'] as Json)) {
    const shared = ((item as Json)['parameters'] as Json[] | undefined) ?? []
    for (const method of METHODS) {
      const operation = (item as Json)[method] as Json | undefined
      if (!operation) continue
      const parameters = [...shared, ...((operation['parameters'] as Json[] | undefined) ?? [])]
        .map((parameter) => resolveParameter(spec, parameter))
        .filter((parameter) => parameter['in'] === 'path' || parameter['in'] === 'query')
        .map((parameter) => {
          const schema = compactSchema(parameter['schema'] ?? { type: 'string' }, source.prefix)
          collectRefs(schema, used)
          const description = shortText(parameter['description'], 160)
          return {
            name: parameter['name'],
            in: parameter['in'],
            ...(parameter['required'] === true || parameter['in'] === 'path' ? { required: true } : {}),
            schema,
            ...(description ? { description } : {}),
          }
        })
      let body: Json | undefined
      const rawBody = operation['requestBody'] ? resolveBody(spec, operation['requestBody'] as Json) : undefined
      if (rawBody) {
        const content = (rawBody['content'] as Json | undefined) ?? {}
        const contentType = Object.keys(content).find((type) => type.includes('json')) ?? Object.keys(content)[0] ?? 'application/json'
        const schema = compactSchema((content[contentType] as Json | undefined)?.['schema'] ?? {}, source.prefix)
        collectRefs(schema, used)
        body = { contentType, ...(rawBody['required'] === true ? { required: true } : {}), schema }
      }
      const summary = shortText(operation['summary'], 120) ?? `${method.toUpperCase()} ${route}`
      const description = shortText(operation['description'], 300)
      operations.push({
        id: `${source.product}.${operation['operationId'] as string}`,
        method: method.toUpperCase(),
        path: `${source.prefix}${route}`,
        summary,
        ...(description && description !== summary ? { description } : {}),
        tags: (operation['tags'] as string[] | undefined) ?? [],
        ...(operation['deprecated'] === true ? { deprecated: true } : {}),
        ...(scopesOf(operation).length > 0 ? { scopes: scopesOf(operation) } : {}),
        parameters,
        ...(body ? { body } : {}),
      })
    }
  }

  const all = ((spec['components'] as Json)?.['schemas'] as Json | undefined) ?? {}
  const schemas: Json = {}
  const pending = [...used].map((ref) => ref.replace('#/components/schemas/', ''))
  while (pending.length > 0) {
    const name = pending.pop()
    if (!name || name in schemas || !(name in all)) continue
    const compact = compactSchema(all[name], source.prefix)
    schemas[name] = compact
    const nested = new Set<string>()
    collectRefs(compact, nested)
    pending.push(...nested)
  }

  operations.sort((a, b) => String(a['id']).localeCompare(String(b['id'])))
  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, `${source.product}.json`),
    `${JSON.stringify({ product: source.product, source: source.url, generatedAt: new Date().toISOString().slice(0, 10), operations, schemas })}\n`,
  )
  return operations.length
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = process.env['ATL_SPEC_CACHE'] ?? path.join(root, '.cache', 'specs')
const outDir = path.join(root, 'src', 'api', 'catalog')
let total = 0
for (const source of SOURCES) {
  const count = await generate(source, cache, outDir)
  total += count
  process.stdout.write(`${source.product}: ${count} operations\n`)
}
process.stdout.write(`total: ${total}\n`)

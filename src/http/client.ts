import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AtlError, EXIT } from '../errors.ts'
import type { Credentials } from '../core/sites.ts'

export type Fetch = typeof globalThis.fetch

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>

export interface RequestOptions {
  method?: string
  query?: Record<string, QueryValue>
  json?: unknown
  form?: FormData
  headers?: Record<string, string>
  raw?: boolean
  accept?: string
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  contentType: string | null
  body: Buffer
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  drawio: 'application/vnd.jgraph.mxfile',
  mmd: 'text/plain',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  pdf: 'application/pdf',
  zip: 'application/zip',
}

export function mediaTypeOf(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

export async function fileForm(filePath: string, extra: Record<string, string> = {}, field = 'file'): Promise<FormData> {
  const filename = basename(filePath)
  const form = new FormData()
  form.append(field, new Blob([await readFile(filePath)], { type: mediaTypeOf(filename) }), filename)
  for (const [key, value] of Object.entries(extra)) form.append(key, value)
  return form
}

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.set(key, String(value))
  }
  const text = params.toString()
  return text.length > 0 ? `?${text}` : ''
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      errorMessages?: string[]
      errors?: Record<string, string> | Array<{ title?: string; detail?: string }>
      message?: string
    }
    const errors = parsed.errors
    const messages = [
      ...(parsed.errorMessages ?? []),
      ...(Array.isArray(errors) ? errors.map((error) => error.detail ?? error.title ?? '') : Object.entries(errors ?? {}).map(([field, message]) => `${field}: ${message}`)),
      ...(parsed.message ? [parsed.message] : []),
    ].filter((message) => message.length > 0)
    if (messages.length > 0) return messages.join('; ')
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 300)
  }
  return text.replace(/\s+/g, ' ').slice(0, 300)
}

export class AtlassianClient {
  readonly site: string
  readonly siteName: string
  private readonly authorization: string
  private readonly fetchImpl: Fetch
  private readonly maxRetries: number

  constructor(credentials: Credentials, options: { fetch?: Fetch; maxRetries?: number } = {}) {
    this.site = credentials.site.url
    this.siteName = credentials.site.name
    this.authorization = `Basic ${Buffer.from(`${credentials.site.email}:${credentials.token}`).toString('base64')}`
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.maxRetries = options.maxRetries ?? 4
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    if (/^https?:\/\//.test(path)) return `${path}${buildQuery(query)}`
    return `${this.site}${path.startsWith('/') ? path : `/${path}`}${buildQuery(query)}`
  }

  async send(path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: options.accept ?? 'application/json',
      ...(options.headers ?? {}),
    }
    let body: RequestInit['body'] | undefined
    if (options.form) {
      body = options.form
      headers['X-Atlassian-Token'] = 'no-check'
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json)
      headers['Content-Type'] = 'application/json'
    }
    const target = this.url(path, options.query)
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await this.fetchImpl(target, { method: options.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) })
      } catch (error) {
        if (attempt < this.maxRetries) {
          await sleep(backoff(attempt, null))
          continue
        }
        throw new AtlError(`Could not reach ${this.site}: ${error instanceof Error ? error.message : String(error)}`, { code: 'NETWORK', exitCode: EXIT.http })
      }
      if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < this.maxRetries) {
        await response.arrayBuffer().catch(() => undefined)
        await sleep(backoff(attempt, response.headers.get('retry-after')))
        continue
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => (responseHeaders[key] = value))
      if (response.status === 401 || response.status === 403) {
        throw new AtlError(`${this.siteName} refused the request (HTTP ${response.status}): ${errorDetail(bytes.toString('utf8'))}`, {
          code: response.status === 401 ? 'AUTH' : 'FORBIDDEN',
          exitCode: EXIT.auth,
          status: response.status,
          hint: response.status === 401 ? `Check the token with "atl site test ${this.siteName}".` : 'The account lacks permission for this resource.',
        })
      }
      if (response.status === 404) {
        throw new AtlError(`Not found on ${this.siteName}: ${errorDetail(bytes.toString('utf8'))}`, { code: 'NOT_FOUND', exitCode: EXIT.notFound, status: 404 })
      }
      if (!response.ok) {
        throw new AtlError(`${this.siteName} answered HTTP ${response.status}: ${errorDetail(bytes.toString('utf8'))}`, {
          code: 'HTTP',
          exitCode: EXIT.http,
          status: response.status,
          details: safeJson(bytes.toString('utf8')),
        })
      }
      return { status: response.status, headers: responseHeaders, contentType: response.headers.get('content-type'), body: bytes }
    }
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options)
    if (response.body.length === 0) return null as T
    const text = response.body.toString('utf8')
    if (response.contentType && !response.contentType.includes('json')) return text as T
    return (safeJson(text) ?? text) as T
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, { ...(query ? { query } : {}) })
  }

  post<T = unknown>(path: string, json?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, { method: 'POST', ...(json !== undefined ? { json } : {}), ...(query ? { query } : {}) })
  }

  put<T = unknown>(path: string, json?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, { method: 'PUT', ...(json !== undefined ? { json } : {}), ...(query ? { query } : {}) })
  }

  delete<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', ...(query ? { query } : {}) })
  }

  async *pages<T>(path: string, query: Record<string, QueryValue>, select: (body: unknown) => { items: T[]; next: Record<string, QueryValue> | string | null }): AsyncGenerator<T> {
    let currentPath = path
    let currentQuery: Record<string, QueryValue> | undefined = query
    for (;;) {
      const body = await this.get(currentPath, currentQuery)
      const { items, next } = select(body)
      for (const item of items) yield item
      if (next === null || items.length === 0) return
      if (typeof next === 'string') {
        currentPath = next
        currentQuery = undefined
      } else {
        currentQuery = { ...currentQuery, ...next }
      }
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250)
}

export function startAtPager(itemsKey: string) {
  return (body: unknown): { items: unknown[]; next: Record<string, QueryValue> | null } => {
    const record = (body ?? {}) as Record<string, unknown>
    const items = Array.isArray(record[itemsKey]) ? (record[itemsKey] as unknown[]) : []
    const startAt = typeof record['startAt'] === 'number' ? record['startAt'] : 0
    const total = typeof record['total'] === 'number' ? record['total'] : null
    const isLast = record['isLast'] === true || (total !== null && startAt + items.length >= total)
    return { items, next: isLast || items.length === 0 ? null : { startAt: startAt + items.length } }
  }
}

export function linksPager(body: unknown): { items: unknown[]; next: string | null } {
  const record = (body ?? {}) as { results?: unknown[]; _links?: { next?: string; base?: string } }
  const next = record._links?.next
  return { items: record.results ?? [], next: next ? (next.startsWith('/wiki') ? next : `/wiki${next}`) : null }
}

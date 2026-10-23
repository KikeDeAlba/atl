import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileStore } from '@kikedealba/kit/credentials'
import { SiteRegistry } from '../src/core/sites.ts'
import { ToolContext } from '../src/tools/context.ts'

export async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'atl-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: IncomingMessage['headers']
}

export type Handler = (request: Recorded) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined

export interface FakeAtlassian {
  url: string
  requests: Recorded[]
  close(): Promise<void>
}

export async function fakeAtlassian(t: { after: (fn: () => Promise<void>) => void }, handler: Handler): Promise<FakeAtlassian> {
  const requests: Recorded[] = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let body: unknown = raw
    if ((request.headers['content-type'] ?? '').includes('json') && raw.length > 0) body = JSON.parse(raw)
    const recorded: Recorded = { method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, body, headers: request.headers }
    requests.push(recorded)
    const answer = handler(recorded) ?? { status: 404, body: { errorMessages: [`no fake for ${recorded.method} ${recorded.path}`] } }
    response.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json', ...(answer.headers ?? {}) })
    response.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const fake = { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  t.after(fake.close)
  return fake
}

export async function sandboxContext(t: { after: (fn: () => Promise<void>) => void }, siteUrl?: string): Promise<{ ctx: ToolContext; registry: SiteRegistry; dir: string }> {
  const dir = await tempDir(t)
  const registry = new SiteRegistry({ configFile: path.join(dir, 'config.json'), env: {}, store: fileStore(path.join(dir, 'credentials.json')) })
  if (siteUrl) await registry.add({ url: siteUrl, email: 'me@example.com', token: 'secret', name: 'test' })
  return { ctx: new ToolContext(registry), registry, dir }
}

export function cliEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATL_CONFIG_PATH: path.join(dir, 'config.json'),
    KIT_CREDENTIALS: 'file',
    KIT_REGISTRY_DIR: path.join(dir, 'registry'),
    XDG_CONFIG_HOME: dir,
    XDG_DATA_HOME: path.join(dir, 'data'),
    APPDATA: dir,
    LOCALAPPDATA: path.join(dir, 'data'),
  }
}

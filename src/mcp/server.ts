import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { allOperations, callOperation, inputSchema, type Operation } from '../api/catalog.ts'
import { AtlError } from '../errors.ts'
import { ToolContext } from '../tools/context.ts'
import { TOOLS, toolInputSchema, type ToolDefinition } from '../tools/definitions.ts'
import { s } from '../tools/schema.ts'
import { VERSION } from '../version.ts'

export interface McpOptions {
  allOperations?: boolean
  readOnly?: boolean
  context?: ToolContext
}

interface Entry {
  tool: Tool
  run(args: Record<string, unknown>): Promise<unknown>
}

const INSTRUCTIONS = `atl talks to Jira, Jira Software and Confluence Cloud on one or more Atlassian sites.
- Every tool takes an optional "site" (name or URL); atl_sites lists them. Without it the default site is used.
- Descriptions and comments are Markdown; atl converts them to Atlassian Document Format or Confluence storage.
- For anything not covered by a named tool, use api_search, then api_describe, then api_call: they reach every REST operation of the three products.`

export function operationToolName(operation: Operation): string {
  const name = `op_${operation.id.replace(/[^A-Za-z0-9]+/g, '_')}`
  return name.length <= 64 ? name : name.slice(0, 64)
}

function curatedEntries(ctx: ToolContext, readOnly: boolean): Entry[] {
  return TOOLS.filter((tool) => !readOnly || tool.readOnly)
    .map((tool) => toEntry(ctx, tool, readOnly))
}

function toEntry(ctx: ToolContext, tool: ToolDefinition, readOnly: boolean): Entry {
  return {
    tool: {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toolInputSchema(tool) as Tool['inputSchema'],
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly === true,
        destructiveHint: tool.destructive === true,
        idempotentHint: tool.readOnly === true,
        openWorldHint: tool.network !== false,
      },
    },
    run: async (args) => {
      if (readOnly && tool.name === 'api_call') throw new AtlError('This server is read-only.', { code: 'READ_ONLY' })
      return tool.run(ctx, args)
    },
  }
}

function operationEntries(ctx: ToolContext, readOnly: boolean): Entry[] {
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const operation of allOperations()) {
    if (operation.deprecated) continue
    if (readOnly && operation.method !== 'GET') continue
    const name = operationToolName(operation)
    if (seen.has(name)) continue
    seen.add(name)
    const schema = inputSchema(operation, 1) as { properties?: Record<string, unknown> }
    entries.push({
      tool: {
        name,
        description: `${operation.method} ${operation.path} — ${operation.summary}${operation.description ? ` ${operation.description}` : ''}`.slice(0, 1000),
        inputSchema: { ...schema, type: 'object', properties: { ...(schema.properties ?? {}), site: s.string('Atlassian site name or URL.') } } as Tool['inputSchema'],
        annotations: { readOnlyHint: operation.method === 'GET', destructiveHint: operation.method === 'DELETE', openWorldHint: true },
      },
      run: async (args) => {
        const { site, ...rest } = args
        return callOperation(await ctx.client(typeof site === 'string' ? site : null), operation, rest)
      },
    })
  }
  return entries
}

function result(value: unknown): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  return { content: [{ type: 'text', text }] }
}

function failure(error: unknown): CallToolResult {
  if (error instanceof AtlError) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.status ? { status: error.status } : {}), ...(error.details ? { details: error.details } : {}) }, null, 2) }] }
  }
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
}

export function createMcpServer(options: McpOptions = {}): Server {
  const ctx = options.context ?? new ToolContext()
  const readOnly = options.readOnly === true
  const entries = [...curatedEntries(ctx, readOnly), ...(options.allOperations ? operationEntries(ctx, readOnly) : [])]
  const byName = new Map(entries.map((entry) => [entry.tool.name, entry]))
  const server = new Server({ name: 'atl', title: 'atl — Atlassian', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: entries.map((entry) => entry.tool) }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = byName.get(request.params.name)
    if (!entry) return failure(new AtlError(`Unknown tool ${request.params.name}.`, { code: 'UNKNOWN_TOOL' }))
    try {
      return result(await entry.run((request.params.arguments ?? {}) as Record<string, unknown>))
    } catch (error) {
      return failure(error)
    }
  })
  return server
}

export async function runStdio(options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(options)
  await server.connect(new StdioServerTransport() as unknown as Transport)
}

export interface HttpOptions extends McpOptions {
  host?: string
  port?: number
  token?: string | null
  log?: (line: string) => void
}

export interface RunningHttp {
  server: HttpServer
  url: string
  sessions(): number
  close(): Promise<void>
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length > 0 ? (JSON.parse(text) as unknown) : undefined
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

export async function runHttp(options: HttpOptions = {}): Promise<RunningHttp> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 7781
  const ctx = options.context ?? new ToolContext()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const log = options.log ?? (() => undefined)
  let boundPort = port
  const allowedHosts = () => [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`, host === '0.0.0.0' ? '' : `${host}:${boundPort}`].filter((value) => value.length > 0)

  const httpServer = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname === '/health') return sendJson(response, 200, { ok: true, name: 'atl', version: VERSION, sessions: transports.size })
      if (url.pathname !== '/mcp') return sendJson(response, 404, { error: 'not found' })
      if (options.token) {
        const header = request.headers.authorization ?? ''
        const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
        if (!sameToken(given, options.token)) return sendJson(response, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })
      }
      const sessionId = request.headers['mcp-session-id']
      const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
      if (request.method === 'POST') {
        const body = await readBody(request)
        if (existing) return await existing.handleRequest(request, response, body)
        if (sessionId === undefined && isInitializeRequest(body)) {
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: allowedHosts(),
            onsessioninitialized: (id) => {
              transports.set(id, transport)
              log(`session ${id} opened (${transports.size} active)`)
            },
            onsessionclosed: (id) => {
              transports.delete(id)
              log(`session ${id} closed (${transports.size} active)`)
            },
          })
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId)
          }
          await createMcpServer({ ...options, context: ctx }).connect(transport as unknown as Transport)
          return await transport.handleRequest(request, response, body)
        }
        return sendJson(response, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Missing or unknown session id' }, id: null })
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        if (!existing) return sendJson(response, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Missing or unknown session id' }, id: null })
        return await existing.handleRequest(request, response)
      }
      response.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) sendJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => resolve())
  })
  const address = httpServer.address()
  boundPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    server: httpServer,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}/mcp`,
    sessions: () => transports.size,
    close: async () => {
      for (const transport of transports.values()) await transport.close().catch(() => undefined)
      transports.clear()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

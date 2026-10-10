import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { runHttp } from '../src/mcp/server.ts'
import { cliEnv, fakeAtlassian, sandboxContext } from './helpers.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'atl.ts')

function issueFake(name: string) {
  return (request: { path: string }) => {
    if (request.path === '/rest/api/3/issue/PP-1') return { body: { id: '1', key: 'PP-1', fields: { summary: `from ${name}`, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] } } } }
    return undefined
  }
}

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? ''
}

test('the HTTP server serves several clients and several sites at once', async (t) => {
  const siteA = await fakeAtlassian(t, issueFake('A'))
  const siteB = await fakeAtlassian(t, issueFake('B'))
  const { ctx, registry } = await sandboxContext(t, siteA.url)
  await registry.add({ url: siteB.url.replace('127.0.0.1', 'localhost'), email: 'b@x.com', token: 'tb', name: 'second' })

  const running = await runHttp({ context: ctx, port: 0, token: 'local-secret' })
  t.after(() => running.close())

  const connect = async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: 'Bearer local-secret' } } })
    await client.connect(transport as unknown as Transport)
    return client
  }
  const [one, two] = await Promise.all([connect(), connect()])
  t.after(async () => {
    await one.close()
    await two.close()
  })
  assert.equal(running.sessions(), 2)

  const tools = await one.listTools()
  const names = tools.tools.map((tool) => tool.name)
  for (const expected of ['jira_get_issue', 'jira_create_issues', 'confluence_upsert_page', 'api_search', 'api_call']) assert.ok(names.includes(expected), expected)
  const getIssue = tools.tools.find((tool) => tool.name === 'jira_get_issue')
  assert.ok((getIssue?.inputSchema.properties as Record<string, unknown>)['site'])
  assert.equal(getIssue?.annotations?.readOnlyHint, true)

  const [fromA, fromB] = await Promise.all([
    one.callTool({ name: 'jira_get_issue', arguments: { key: 'PP-1' } }),
    two.callTool({ name: 'jira_get_issue', arguments: { key: 'PP-1', site: 'second' } }),
  ])
  assert.match(textOf(fromA), /from A/)
  assert.match(textOf(fromA), /"description": "hello"/)
  assert.match(textOf(fromB), /from B/)

  const failed = await one.callTool({ name: 'jira_get_issue', arguments: { key: 'PP-1', site: 'nowhere' } })
  assert.equal(failed.isError, true)
  assert.match(textOf(failed), /SITE_NOT_FOUND/)

  const unauthorized = await fetch(running.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(unauthorized.status, 401)
  const health = await (await fetch(running.url.replace('/mcp', '/health'))).json() as { ok: boolean; sessions: number }
  assert.equal(health.ok, true)
})

test('read-only mode hides every tool that writes', async (t) => {
  const { ctx } = await sandboxContext(t)
  const running = await runHttp({ context: ctx, port: 0, token: null, readOnly: true, allOperations: true })
  t.after(() => running.close())
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)) as unknown as Transport)
  t.after(() => client.close())
  const { tools } = await client.listTools()
  assert.ok(tools.length > 300)
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true), tools.find((tool) => tool.annotations?.readOnlyHint !== true)?.name)
  assert.ok(!tools.some((tool) => tool.name === 'jira_create_issue'))
  assert.ok(tools.some((tool) => tool.name === 'op_agile_getBoard'))
})

test('the stdio server answers a real client', async (t) => {
  const site = await fakeAtlassian(t, issueFake('stdio'))
  const { dir, registry } = await sandboxContext(t)
  const env = cliEnv(dir)
  const { SiteRegistry } = await import('../src/core/sites.ts')
  const { fileStore } = await import('@kikedealba/kit/credentials')
  void registry
  const shared = new SiteRegistry({ configFile: env['ATL_CONFIG_PATH'] as string, env: {}, store: fileStore(path.join(dir, 'kikedealba', 'credentials.json')) })
  await shared.add({ url: site.url, email: 'me@x.com', token: 'secret', name: 'local' })

  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: env as Record<string, string> })
  await client.connect(transport as unknown as Transport)
  t.after(() => client.close())
  const result = await client.callTool({ name: 'jira_get_issue', arguments: { key: 'PP-1' } })
  assert.match(textOf(result), /from stdio/)
  const sites = await client.callTool({ name: 'atl_sites', arguments: {} })
  assert.match(textOf(sites), /"name": "local"/)
})

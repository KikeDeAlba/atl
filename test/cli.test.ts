import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { assertConformance } from '@kikedealba/kit/conformance'
import { readManifest } from '@kikedealba/kit/registry'
import { platformContext } from '@kikedealba/kit/platform'
import { manifest } from '../src/setup.ts'
import { cliEnv, fakeAtlassian, tempDir } from './helpers.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'atl.ts')

async function atl(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr })
    })
    child.stdin?.end(input ?? '')
  })
}

test('atl passes the kit conformance checks', async () => {
  await assertConformance([process.execPath, BIN], manifest())
})

test('a site added from the CLI is used by every command', async (t) => {
  const dir = await tempDir(t)
  const env = cliEnv(dir)
  const fake = await fakeAtlassian(t, (request) => {
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'acc', displayName: 'Tester' } }
    if (request.path === '/wiki/rest/api/user/current') return { body: { accountId: 'acc', displayName: 'Tester' } }
    if (request.path === '/rest/api/3/issue' && request.method === 'POST') return { status: 201, body: { id: '9', key: 'PP-9' } }
    if (request.path === '/rest/api/3/issue/PP-9/comment') return { status: 201, body: { id: 'c1', created: 'now' } }
    return undefined
  })

  const added = await atl(['site', 'add', fake.url, '--email', 'me@x.com', '--name', 'local', '--token-stdin', '--json'], env, 'tok\n')
  assert.equal(added.code, 0, added.stdout + added.stderr)
  const envelope = JSON.parse(added.stdout) as { data: { check: { jira: { ok: boolean } } } }
  assert.equal(envelope.data.check.jira.ok, true)

  const created = await atl(['jira', 'issue', 'create', '--project', 'PP', '--type', 'Task', '--summary', 'From CLI', '--labels', 'x,y', '--json'], env)
  assert.equal(created.code, 0, created.stderr)
  assert.equal((JSON.parse(created.stdout) as { data: { key: string } }).data.key, 'PP-9')
  const post = fake.requests.find((request) => request.method === 'POST' && request.path === '/rest/api/3/issue')
  assert.deepEqual((post?.body as { fields: { labels: string[] } }).fields.labels, ['x', 'y'])

  const commented = await atl(['jira', 'comment', 'add', 'PP-9', '--body', '@-', '--json'], env, '**done**')
  assert.equal(commented.code, 0, commented.stderr)
  const comment = fake.requests.find((request) => request.path === '/rest/api/3/issue/PP-9/comment')
  assert.equal(JSON.stringify(comment?.body).includes('"strong"'), true)

  const missing = await atl(['jira', 'issue', 'get', '--json'], env)
  assert.equal(missing.code, 2)
  assert.equal((JSON.parse(missing.stdout) as { error: { code: string } }).error.code, 'USAGE')
})

test('setup --mcp stdio registers atl and its MCP server in the agents', async (t) => {
  const dir = await tempDir(t)
  const env = { ...cliEnv(dir), HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CODEX_HOME: path.join(dir, '.codex'), GEMINI_CLI_HOME: dir, PATH: path.dirname(process.execPath) }
  const targets = agents.AGENTS.filter((agent) => agent !== 'claude' && agent !== 'claude-desktop')
  const result = await atl(['setup', '--agents', targets.join(','), '--mcp', 'stdio', '--json'], env)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const registered = await readManifest('atl', platformContext({ env, home: dir }))
  assert.ok(registered?.capabilities.includes('confluence.page.write'))
  assert.deepEqual(registered?.mcp?.stdio?.slice(-1), ['mcp'])
  assert.match(await readFile(path.join(dir, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.atl\]/)
  const extension = JSON.parse(await readFile(path.join(dir, '.gemini', 'extensions', 'atl', 'gemini-extension.json'), 'utf8'))
  assert.equal(extension.mcpServers.atl.args.at(-1), 'mcp')
  assert.ok(existsSync(path.join(dir, '.gemini', 'extensions', 'atl', 'skills', 'atl', 'SKILL.md')))
  const antigravity = JSON.parse(await readFile(path.join(dir, '.gemini', 'config', 'mcp_config.json'), 'utf8'))
  assert.equal(antigravity.mcpServers.atl.args.at(-1), 'mcp')
  assert.ok(existsSync(path.join(dir, 'opencode', 'opencode.json')))

  const removed = await atl(['uninstall', '--json'], env)
  assert.equal(removed.code, 0)
  assert.equal(await readManifest('atl', platformContext({ env, home: dir })), null)
  assert.ok(!existsSync(path.join(dir, '.gemini', 'extensions', 'atl')))
  assert.equal(JSON.parse(await readFile(path.join(dir, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers.atl, undefined)
})

test('setup registers the command on PATH when it is this same atl', async (t) => {
  const dir = await tempDir(t)
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  const shim = path.join(bin, process.platform === 'win32' ? 'atl.cmd' : 'atl')
  await writeFile(shim, process.platform === 'win32' ? `@"${process.execPath}" "${BIN}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
  await chmod(shim, 0o755)
  const env = { ...cliEnv(dir), HOME: dir, USERPROFILE: dir, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter) }
  const result = await atl(['setup', '--no-agents', '--json'], env)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const registered = await readManifest('atl', platformContext({ env, home: dir }))
  assert.deepEqual(registered?.bin, [shim])
  assert.deepEqual(registered?.mcp?.stdio, [shim, 'mcp'])
})

test('setup by default installs the skill only and removes the MCP server a previous install left', async (t) => {
  const dir = await tempDir(t)
  const env = { ...cliEnv(dir), HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, '.codex'), KIT_AGENTS_HOME: path.join(dir, '.agents'), PATH: path.dirname(process.execPath) }
  await mkdir(path.join(dir, '.codex'), { recursive: true })
  await writeFile(path.join(dir, '.codex', 'config.toml'), '[mcp_servers.atl]\ncommand = "atl"\nargs = ["mcp"]\n')
  await mkdir(path.join(dir, '.gemini', 'config'), { recursive: true })
  await writeFile(path.join(dir, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { atl: { command: 'atl', args: ['mcp'], disabled: false, [agents.ANTIGRAVITY_MCP_MARKER]: 'atl' } } }))
  const result = await atl(['setup', '--agents', 'codex,antigravity', '--json'], env)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const envelope = JSON.parse(result.stdout) as { data: { mcp: string; steps: Array<{ agent: string; item: string; state: string }> } }
  assert.equal(envelope.data.mcp, 'none')
  assert.ok(envelope.data.steps.some((step) => step.agent === 'codex' && step.item === 'mcp atl' && step.state === 'removed'))
  assert.ok(envelope.data.steps.some((step) => step.agent === 'antigravity' && step.item === 'mcp atl' && step.state === 'removed'))
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers, {})
  assert.doesNotMatch(await readFile(path.join(dir, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.atl/)
  assert.ok(existsSync(path.join(dir, '.agents', 'skills', 'atl', 'SKILL.md')))
})

test('list commands return compact objects and honor --fields and --limit', async (t) => {
  const dir = await tempDir(t)
  const env = { ...cliEnv(dir), ATL_SITE_URL: '', ATL_EMAIL: '', ATL_TOKEN: '' }
  const issue = (n: number) => ({ id: String(n), key: `PP-${n}`, fields: { summary: `Issue ${n}`, status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Task' }, project: { key: 'PP' }, assignee: { displayName: 'Ana' }, reporter: { displayName: 'Beto' }, priority: { name: 'Medium' }, labels: ['x'], created: '2026-10-01', updated: '2026-10-02', timetracking: { originalEstimateSeconds: 3600 } } })
  const fake = await fakeAtlassian(t, (request) => {
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'acc', displayName: 'Tester' } }
    if (request.path === '/wiki/rest/api/user/current') return { body: { accountId: 'acc', displayName: 'Tester' } }
    if (request.path === '/rest/api/3/search/jql') return { body: { issues: [issue(1), issue(2), issue(3)] } }
    return undefined
  })
  assert.equal((await atl(['site', 'add', fake.url, '--email', 'me@x.com', '--name', 'local', '--token-stdin', '--json'], env, 'tok\n')).code, 0)

  const compact = await atl(['jira', 'search', 'project = PP', '--json'], env)
  assert.equal(compact.code, 0, compact.stderr)
  const compactData = (JSON.parse(compact.stdout) as { data: Array<Record<string, unknown>> }).data
  assert.deepEqual(compactData[0], { key: 'PP-1', summary: 'Issue 1', status: 'To Do', assignee: 'Ana' })
  const firstBody = fake.requests.filter((request) => request.path === '/rest/api/3/search/jql').at(-1)?.body as { fields: string[] }
  assert.deepEqual(firstBody.fields, ['summary', 'status', 'assignee'])

  const picked = await atl(['jira', 'search', 'project = PP', '--fields', 'key,parentKey,originalEstimateSeconds', '--limit', '2', '--json'], env)
  const pickedData = (JSON.parse(picked.stdout) as { data: Array<Record<string, unknown>> }).data
  assert.deepEqual(pickedData, [{ key: 'PP-1', parentKey: null, originalEstimateSeconds: 3600 }, { key: 'PP-2', parentKey: null, originalEstimateSeconds: 3600 }])
  const pickedBody = fake.requests.filter((request) => request.path === '/rest/api/3/search/jql').at(-1)?.body as { fields: string[]; maxResults: number }
  assert.deepEqual(pickedBody.fields, ['parent', 'timetracking'])
  assert.equal(pickedBody.maxResults, 2)

  const full = await atl(['jira', 'search', 'project = PP', '--fields', 'all', '--json'], env)
  const fullData = (JSON.parse(full.stdout) as { data: Array<Record<string, unknown>> }).data
  assert.equal(fullData[0]?.['reporter'], 'Beto')
  assert.ok(full.stdout.length > compact.stdout.length * 2)

  const sites = await atl(['site', 'ls', '--fields', 'name', '--json'], env)
  assert.deepEqual((JSON.parse(sites.stdout) as { data: unknown[] }).data, [{ name: 'local' }])

  const bad = await atl(['jira', 'search', 'project = PP', '--limit', 'zero', '--json'], env)
  assert.equal(bad.code, 2)
  const typo = await atl(['jira', 'search', 'project = PP', '--fields', 'key,sumary', '--json'], env)
  assert.equal(typo.code, 2)
  assert.match(typo.stdout, /sumary/)
  const fullBody = fake.requests.filter((request) => request.path === '/rest/api/3/search/jql').at(-1)?.body as { fields: string[] }
  assert.ok(fullBody.fields.includes('description'))
})

test('setup rejects unknown agents', async (t) => {
  const dir = await tempDir(t)
  const env = { ...cliEnv(dir), HOME: dir, USERPROFILE: dir, PATH: path.dirname(process.execPath) }
  const result = await atl(['setup', '--agents', 'claude-dekstop', '--json'], env)
  assert.equal(result.code, 2, result.stdout + result.stderr)
  assert.match((JSON.parse(result.stdout) as { error: { message: string } }).error.message, /claude-desktop/)
})

test('help and README cover every agent kit supports', async (t) => {
  const dir = await tempDir(t)
  const help = await atl(['--help'], cliEnv(dir))
  assert.equal(help.code, 0, help.stderr)
  assert.ok(help.stdout.includes(`--agents detected|all|${agents.AGENTS.join(',')}`), help.stdout)
  const labels: Record<(typeof agents.AGENTS)[number], string> = {
    claude: 'Claude Code',
    opencode: 'opencode',
    codex: 'Codex',
    gemini: 'Gemini CLI',
    antigravity: 'Antigravity CLI',
    'claude-desktop': 'Claude Desktop',
  }
  const readme = await readFile(path.join(path.dirname(BIN), '..', '..', 'README.md'), 'utf8')
  const table = readme.split('\n').filter((line) => line.startsWith('| ')).join('\n')
  for (const agent of agents.AGENTS) assert.ok(table.includes(labels[agent]), `README table misses ${agent}`)
  const keywords = (JSON.parse(await readFile(path.join(path.dirname(BIN), '..', '..', 'package.json'), 'utf8')) as { keywords: string[] }).keywords
  for (const agent of agents.AGENTS) assert.ok(keywords.some((keyword) => keyword.startsWith(agent)), `keywords miss ${agent}`)
})

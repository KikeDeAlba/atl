import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
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

test('setup registers atl and its MCP server in the agents', async (t) => {
  const dir = await tempDir(t)
  const env = { ...cliEnv(dir), HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CODEX_HOME: path.join(dir, '.codex'), GEMINI_CLI_HOME: dir, PATH: path.dirname(process.execPath) }
  const result = await atl(['setup', '--agents', 'codex,gemini', '--json'], env)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const registered = await readManifest('atl', platformContext({ env, home: dir }))
  assert.ok(registered?.capabilities.includes('confluence.page.write'))
  assert.deepEqual(registered?.mcp?.stdio?.slice(-1), ['mcp'])
  assert.match(await readFile(path.join(dir, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.atl\]/)
  const extension = JSON.parse(await readFile(path.join(dir, '.gemini', 'extensions', 'atl', 'gemini-extension.json'), 'utf8'))
  assert.equal(extension.mcpServers.atl.args.at(-1), 'mcp')
  assert.ok(existsSync(path.join(dir, '.gemini', 'extensions', 'atl', 'skills', 'atl', 'SKILL.md')))

  const removed = await atl(['uninstall', '--json'], env)
  assert.equal(removed.code, 0)
  assert.equal(await readManifest('atl', platformContext({ env, home: dir })), null)
  assert.ok(!existsSync(path.join(dir, '.gemini', 'extensions', 'atl')))
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

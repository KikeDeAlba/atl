import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(ROOT, file), 'utf8')) as Record<string, unknown>
}

test('the repo is a Claude Code marketplace with the atl plugin at its root', async () => {
  const pkg = await json('package.json')
  const marketplace = await json('.claude-plugin/marketplace.json')
  const plugin = await json('.claude-plugin/plugin.json')
  assert.equal(marketplace['name'], 'atl')
  const entries = marketplace['plugins'] as Array<Record<string, unknown>>
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.['name'], 'atl')
  assert.equal(entries[0]?.['source'], './')
  assert.equal(entries[0]?.['version'], pkg['version'])
  assert.equal(plugin['name'], 'atl')
  assert.equal(plugin['version'], pkg['version'])
  assert.equal(plugin['mcpServers'], undefined)
  assert.ok(!existsSync(path.join(ROOT, '.mcp.json')))
  assert.ok((pkg['files'] as string[]).includes('skills'))
  assert.ok((pkg['files'] as string[]).includes('.claude-plugin'))
})

test('the skill is lean, Spanish and points at its reference', async () => {
  const text = (await readFile(path.join(ROOT, 'skills', 'atl', 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n')
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
  const front = { data: Object.fromEntries(header.split('\n').map((line) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)).filter((match) => match !== null).map((match) => [match[1], match[2]])) as Record<string, string | undefined> }
  assert.equal(front.data['name'], 'atl')
  assert.ok((front.data['description'] ?? '').length > 100)
  assert.match(front.data['allowed-tools'] ?? '', /Bash\(atl jira search:\*\)/)
  assert.ok(text.split('\n').length < 120)
  assert.match(text, /--fields/)
  assert.match(text, /reference\.md/)
  assert.ok(existsSync(path.join(ROOT, 'skills', 'atl', 'reference.md')))
  assert.doesNotMatch(text, /Rovo/)
})

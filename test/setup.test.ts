import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { CLAUDE_PLUGIN, SKILL_DIR, integration, setupAgents, uninstallAgents } from '../src/setup.ts'
import { tempDir } from './helpers.ts'

interface Sandbox {
  dir: string
  calls: string[][]
  options: { ctx: ReturnType<typeof platformContext>; exec: (command: string, args: readonly string[]) => Promise<string>; locate: (command: string) => Promise<string | null> }
}

async function sandbox(t: { after: (fn: () => Promise<void>) => void }, mcpRegistered = true, plugins = '[]'): Promise<Sandbox> {
  const dir = await tempDir(t)
  const env = { HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CODEX_HOME: path.join(dir, '.codex'), XDG_CONFIG_HOME: path.join(dir, '.config'), XDG_DATA_HOME: path.join(dir, '.local', 'share'), GEMINI_CLI_HOME: dir, KIT_AGENTS_HOME: path.join(dir, '.agents') }
  const calls: string[][] = []
  const exec = async (command: string, args: readonly string[]): Promise<string> => {
    calls.push([path.basename(command), ...args])
    const joined = args.join(' ')
    if (joined === 'plugin marketplace list --json') return '[]'
    if (joined === 'plugin list --json') return plugins
    if (joined.startsWith('mcp remove') && !mcpRegistered) throw new Error('No MCP server found with name: atl')
    return ''
  }
  const locate = async (command: string): Promise<string | null> => (command === 'claude' ? path.join(dir, 'bin', 'claude') : null)
  return { dir, calls, options: { ctx: platformContext({ env, home: dir }), exec, locate } }
}

async function legacyInstall(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.claude', 'skills'), { recursive: true })
  await symlink(SKILL_DIR, path.join(dir, '.claude', 'skills', 'atl'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status:*)', 'Bash(atl jira search:*)', 'mcp__atl__jira_search'] } }))
  await mkdir(path.join(dir, '.codex'), { recursive: true })
  await writeFile(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.atl]\ncommand = "atl"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "other"\n')
  await mkdir(path.join(dir, '.config', 'opencode'), { recursive: true })
  await writeFile(path.join(dir, '.config', 'opencode', 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { atl: { type: 'local', command: ['atl', 'mcp'], enabled: true }, other: { type: 'local', command: ['other'] } } }))
  await mkdir(path.join(dir, '.gemini', 'extensions', 'atl'), { recursive: true })
  await writeFile(path.join(dir, '.gemini', 'extensions', 'atl', 'gemini-extension.json'), JSON.stringify({ name: 'atl', version: '0.1.1', mcpServers: { atl: { command: 'atl', args: ['mcp'] } } }))
}

test('setup installs the Claude Code plugin and drops every MCP server a previous install registered', async (t) => {
  const box = await sandbox(t)
  await legacyInstall(box.dir)
  const steps = await setupAgents({ mode: 'none', agents: 'all', ...box.options })

  assert.deepEqual(box.calls.find((call) => call[1] === 'plugin' && call[2] === 'marketplace' && call[3] === 'add'), ['claude', 'plugin', 'marketplace', 'add', CLAUDE_PLUGIN.marketplace])
  assert.ok(box.calls.some((call) => call.join(' ') === 'claude plugin install atl@atl --scope user'))
  assert.ok(box.calls.some((call) => call.join(' ') === 'claude mcp remove --scope user atl'))
  assert.ok(!box.calls.some((call) => call[1] === 'mcp' && call[2] === 'add'))

  assert.ok(!existsSync(path.join(box.dir, '.claude', 'skills', 'atl')))
  const settings = JSON.parse(await readFile(path.join(box.dir, '.claude', 'settings.json'), 'utf8')) as { permissions: { allow: string[] } }
  assert.deepEqual(settings.permissions.allow, ['Bash(git status:*)'])

  const codex = await readFile(path.join(box.dir, '.codex', 'config.toml'), 'utf8')
  assert.doesNotMatch(codex, /mcp_servers\.atl/)
  assert.match(codex, /\[mcp_servers\.other\]/)
  const opencode = JSON.parse(await readFile(path.join(box.dir, '.config', 'opencode', 'opencode.json'), 'utf8')) as { mcp: Record<string, unknown> }
  assert.deepEqual(Object.keys(opencode.mcp), ['other'])
  const gemini = JSON.parse(await readFile(path.join(box.dir, '.gemini', 'extensions', 'atl', 'gemini-extension.json'), 'utf8')) as { mcpServers?: unknown }
  assert.equal(gemini.mcpServers, undefined)

  const removed = steps.filter((step) => step.item === 'mcp atl' && step.state === 'removed').map((step) => step.agent).sort()
  assert.deepEqual(removed, ['claude', 'codex', 'gemini', 'opencode'])
  assert.ok(existsSync(path.join(box.dir, '.agents', 'skills', 'atl', 'SKILL.md')))
  assert.ok(existsSync(path.join(box.dir, '.config', 'opencode', 'skills', 'atl', 'SKILL.md')))
  assert.ok(existsSync(path.join(box.dir, '.gemini', 'extensions', 'atl', 'skills', 'atl', 'SKILL.md')))
  assert.ok(!steps.some((step) => step.state === 'failed'), JSON.stringify(steps, null, 2))
})

test('setup without a previous MCP server reports nothing removed', async (t) => {
  const box = await sandbox(t, false)
  const steps = await setupAgents({ mode: 'none', agents: ['claude', 'codex', 'opencode'], ...box.options })
  assert.ok(!steps.some((step) => step.item === 'mcp atl' && step.state === 'removed'), JSON.stringify(steps, null, 2))
  assert.ok(!existsSync(path.join(box.dir, '.codex', 'config.toml')))
})

test('setup --mcp stdio registers the server everywhere on top of the plugin', async (t) => {
  const box = await sandbox(t)
  await legacyInstall(box.dir)
  const bin = ['/usr/local/bin/atl']
  await setupAgents({ mode: 'stdio', agents: 'all', bin, ...box.options })

  assert.ok(box.calls.some((call) => call.join(' ') === 'claude plugin install atl@atl --scope user'))
  assert.ok(box.calls.some((call) => call.join(' ') === 'claude mcp add --scope user atl -- /usr/local/bin/atl mcp'))
  const settings = JSON.parse(await readFile(path.join(box.dir, '.claude', 'settings.json'), 'utf8')) as { permissions: { allow: string[] } }
  assert.ok(settings.permissions.allow.includes('mcp__atl__jira_search'))
  assert.ok(!settings.permissions.allow.includes('Bash(atl jira search:*)'))
  assert.ok(!existsSync(path.join(box.dir, '.claude', 'skills', 'atl')))
  assert.match(await readFile(path.join(box.dir, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.atl\]\ncommand = "\/usr\/local\/bin\/atl"/)
  const opencode = JSON.parse(await readFile(path.join(box.dir, '.config', 'opencode', 'opencode.json'), 'utf8')) as { mcp: Record<string, { command: string[] }> }
  assert.deepEqual(opencode.mcp['atl']?.command, ['/usr/local/bin/atl', 'mcp'])
  const gemini = JSON.parse(await readFile(path.join(box.dir, '.gemini', 'extensions', 'atl', 'gemini-extension.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> }
  assert.deepEqual(gemini.mcpServers['atl']?.args, ['mcp'])
})

test('uninstall removes the Claude Code plugin', async (t) => {
  const box = await sandbox(t, true, JSON.stringify([{ id: 'atl@atl', scope: 'user' }]))
  await uninstallAgents({ ...box.options, agents: ['claude'] })
  assert.ok(box.calls.some((call) => call.join(' ') === 'claude plugin uninstall atl@atl --scope user'))
  assert.ok(box.calls.some((call) => call.join(' ') === 'claude mcp remove --scope user atl'))
})

test('setup keeps the skill in Claude Code when the plugin cannot be installed', async (t) => {
  const box = await sandbox(t)
  await legacyInstall(box.dir)
  const steps = await setupAgents({ mode: 'none', agents: ['claude'], ...box.options, locate: async () => null })
  assert.ok(steps.some((step) => step.item === 'plugin atl@atl' && step.state === 'unavailable'))
  assert.ok(existsSync(path.join(box.dir, '.claude', 'skills', 'atl', 'SKILL.md')))
  const settings = JSON.parse(await readFile(path.join(box.dir, '.claude', 'settings.json'), 'utf8')) as { permissions: { allow: string[] } }
  assert.ok(settings.permissions.allow.includes('Bash(atl jira search:*)'))
})

test('integration in mode none gives MCP only to Claude Desktop', () => {
  const bin = ['/Users/a/Library/pnpm/bin/atl']
  const none = integration('none', undefined, bin)
  assert.deepEqual(none.mcp, [])
  assert.deepEqual(none.claudeDesktop, { mcp: [{ name: 'atl', command: ['/Users/a/Library/pnpm/bin/atl', 'mcp'] }] })
  assert.deepEqual(integration('stdio', undefined, bin).claudeDesktop, none.claudeDesktop)
})

async function desktopSandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<Sandbox & { config: string }> {
  const box = await sandbox(t)
  const ctx = platformContext({ env: box.options.ctx.env, home: box.dir, platform: 'darwin' })
  const dir = path.join(box.dir, 'Library', 'Application Support', 'Claude')
  await mkdir(dir, { recursive: true })
  const config = path.join(dir, 'claude_desktop_config.json')
  await writeFile(config, JSON.stringify({ preferences: { sidebarMode: 'chat' }, mcpServers: {} }))
  return { ...box, options: { ...box.options, ctx }, config }
}

test('setup registers the MCP server in Claude Desktop and keeps the CLI agents without MCP', async (t) => {
  const box = await desktopSandbox(t)
  const bin = ['/usr/local/bin/atl']
  const steps = await setupAgents({ mode: 'none', bin, ...box.options })
  assert.ok(steps.some((step) => step.agent === 'claude-desktop' && step.state === 'installed'), JSON.stringify(steps, null, 2))
  const config = JSON.parse(await readFile(box.config, 'utf8')) as { preferences: unknown; mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }
  assert.deepEqual(config.preferences, { sidebarMode: 'chat' })
  assert.equal(config.mcpServers['atl']?.command, '/usr/local/bin/atl')
  assert.deepEqual(config.mcpServers['atl']?.args, ['mcp'])
  assert.ok(config.mcpServers['atl']?.env['PATH']?.split(path.delimiter).includes(path.dirname(process.execPath)))
  assert.ok(!box.calls.some((call) => call[1] === 'mcp' && call[2] === 'add'))
  assert.ok(!steps.some((step) => step.state === 'failed'), JSON.stringify(steps, null, 2))

  await uninstallAgents({ ...box.options, agents: ['claude-desktop'] })
  const cleaned = JSON.parse(await readFile(box.config, 'utf8')) as { preferences: unknown; mcpServers: Record<string, unknown> }
  assert.deepEqual(cleaned, { preferences: { sidebarMode: 'chat' }, mcpServers: {} })
})

test('setup --no-desktop leaves Claude Desktop alone', async (t) => {
  const box = await desktopSandbox(t)
  const steps = await setupAgents({ mode: 'stdio', bin: ['/usr/local/bin/atl'], desktop: false, ...box.options })
  assert.ok(!steps.some((step) => step.agent === 'claude-desktop'))
  assert.deepEqual(JSON.parse(await readFile(box.config, 'utf8')), { preferences: { sidebarMode: 'chat' }, mcpServers: {} })
  const explicit = await setupAgents({ mode: 'none', agents: ['codex', 'claude-desktop'], desktop: false, ...box.options })
  assert.ok(!explicit.some((step) => step.agent === 'claude-desktop'))
})

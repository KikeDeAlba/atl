import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { defineManifest, registerTool, stableBin, unregisterTool, type ToolManifest } from '@kikedealba/kit/registry'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const CAPABILITIES = [
  'atlassian.sites',
  'atlassian.api.call',
  'jira.issue.read',
  'jira.issue.write',
  'jira.comment.write',
  'jira.worklog.write',
  'jira.attachment.write',
  'jira.agile.read',
  'jira.agile.write',
  'confluence.page.read',
  'confluence.page.write',
  'confluence.attachment.write',
  'confluence.comment.write',
  'markdown.adf',
  'markdown.storage',
  'mcp.stdio',
  'mcp.http',
]

export const INSTALL_HINT = 'npm install -g @kikedealba/atl && atl setup'

export function binEntry(): string {
  const built = path.join(PACKAGE_ROOT, 'dist', 'bin', 'atl.js')
  return existsSync(built) ? built : path.join(PACKAGE_ROOT, 'src', 'bin', 'atl.ts')
}

export function binCommand(): string[] {
  return [process.execPath, binEntry()]
}

export async function installedBin(): Promise<string[]> {
  return stableBin('atl', VERSION, binCommand())
}

export function manifest(httpUrl?: string | null, bin: readonly string[] = binCommand()): ToolManifest {
  return defineManifest({
    name: 'atl',
    version: VERSION,
    description: 'Atlassian CLI and MCP server',
    bin: [...bin],
    capabilities: CAPABILITIES,
    mcp: { stdio: [...bin, 'mcp'], ...(httpUrl ? { http: httpUrl } : {}) },
    homepage: 'https://github.com/KikeDeAlba/atl',
    install: INSTALL_HINT,
  })
}

export type McpMode = 'stdio' | 'http' | 'none'

export const CLAUDE_PLUGIN = { marketplace: 'KikeDeAlba/atl', marketplaceName: 'atl', plugin: 'atl' } as const

export const SKILL_DIR = path.join(PACKAGE_ROOT, 'skills', 'atl')

export async function antigravityRules(): Promise<string> {
  return agents.parseFrontmatter(await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')).body.trimStart().replaceAll('](reference.md)', '](../skills/atl/reference.md)')
}

const CLI_PERMISSIONS = [
  'Bash(atl site ls:*)',
  'Bash(atl jira issue get:*)',
  'Bash(atl jira search:*)',
  'Bash(atl jira comment ls:*)',
  'Bash(atl jira worklog ls:*)',
  'Bash(atl jira createmeta:*)',
  'Bash(atl confluence page get:*)',
  'Bash(atl confluence search:*)',
  'Bash(atl api search:*)',
  'Bash(atl api describe:*)',
  'Bash(atl --version)',
]

const MCP_PERMISSIONS = [
  'mcp__atl__atl_sites',
  'mcp__atl__jira_get_issue',
  'mcp__atl__jira_search',
  'mcp__atl__confluence_get_page',
  'mcp__atl__confluence_search',
  'mcp__atl__api_search',
  'mcp__atl__api_describe',
]

function mcpServers(mode: McpMode, http: { url: string; token: string | null } | undefined, bin: readonly string[]): agents.McpServer[] {
  if (mode === 'none') return []
  if (mode === 'http' && http) return [{ name: 'atl', url: http.url, ...(http.token ? { headers: { Authorization: `Bearer ${http.token}` } } : {}) }]
  return [{ name: 'atl', command: [...bin, 'mcp'] }]
}

function desktopBin(bin: readonly string[]): readonly string[] {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin[0] ?? '') ? binCommand() : bin
}

export function integration(mode: McpMode, http?: { url: string; token: string | null }, bin: readonly string[] = binCommand(), rules?: string): agents.AgentIntegration {
  return {
    tool: 'atl',
    version: VERSION,
    description: 'Jira, Jira Software and Confluence Cloud through atl',
    skills: [{ name: 'atl', dir: SKILL_DIR }],
    mcp: mcpServers(mode, http, bin),
    claude: { permissions: { allow: [...CLI_PERMISSIONS, ...MCP_PERMISSIONS] } },
    claudeDesktop: { mcp: [{ name: 'atl', command: [...desktopBin(bin), 'mcp'] }] },
    ...(rules ? { antigravity: { rules } } : {}),
  }
}

function claudeMcpIntegration(mode: McpMode, http: { url: string; token: string | null } | undefined, bin: readonly string[]): agents.AgentIntegration {
  return { tool: 'atl', version: VERSION, mcp: mcpServers(mode, http, bin), claude: { permissions: { allow: MCP_PERMISSIONS } } }
}

export interface AgentSetup extends agents.InstallOptions {
  mode: McpMode
  http?: { url: string; token: string | null }
  bin?: readonly string[]
  desktop?: boolean
}

const STALE_MCP: agents.AgentIntegration = { tool: 'atl', version: VERSION, mcp: [{ name: 'atl', command: ['atl', 'mcp'] }] }

async function hasCodexMcp(homes: agents.AgentHomes): Promise<boolean> {
  const file = path.join(homes.codex, 'config.toml')
  return existsSync(file) && /^\s*\[mcp_servers\.(atl|"atl")\]\s*$/m.test(await readFile(file, 'utf8'))
}

async function hasOpenCodeMcp(homes: agents.AgentHomes): Promise<boolean> {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const file = path.join(homes.opencode, name)
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8')
    try {
      const value = JSON.parse(text) as { mcp?: Record<string, unknown> }
      return typeof value.mcp === 'object' && value.mcp !== null && 'atl' in value.mcp
    } catch {
      return /"mcp"\s*:/.test(text) && /"atl"\s*:\s*\{/.test(text)
    }
  }
  return false
}

async function hasGeminiMcp(homes: agents.AgentHomes): Promise<boolean> {
  const file = path.join(homes.gemini, 'extensions', 'atl', 'gemini-extension.json')
  if (!existsSync(file)) return false
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { mcpServers?: Record<string, unknown> }
    return typeof value.mcpServers === 'object' && value.mcpServers !== null && 'atl' in value.mcpServers
  } catch {
    return false
  }
}

async function hasAntigravityMcp(homes: agents.AgentHomes): Promise<boolean> {
  const file = path.join(homes.antigravity, 'mcp_config.json')
  if (!existsSync(file)) return false
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown> | null> }
    return value.mcpServers?.['atl']?.[agents.ANTIGRAVITY_MCP_MARKER] === 'atl'
  } catch {
    return false
  }
}

async function removeStaleMcp(targets: readonly agents.AgentName[], homes: agents.AgentHomes, options: agents.InstallOptions): Promise<agents.Step[]> {
  const steps: agents.Step[] = []
  const stale: agents.AgentName[] = []
  if (targets.includes('codex') && (await hasCodexMcp(homes))) stale.push('codex')
  if (targets.includes('opencode') && (await hasOpenCodeMcp(homes))) stale.push('opencode')
  if (stale.length > 0) {
    steps.push(...(await agents.uninstallIntegration(STALE_MCP, { ...options, agents: stale })))
  }
  if (targets.includes('antigravity') && (await hasAntigravityMcp(homes))) {
    const removed = await agents.uninstallIntegration(STALE_MCP, { ...options, agents: ['antigravity'], locate: async () => null })
    steps.push(...removed.filter((step) => step.item === 'mcp atl'))
  }
  return steps
}

async function withAntigravityRules<T>(targets: readonly agents.AgentName[], run: (rules?: string) => Promise<T>): Promise<T> {
  if (!targets.includes('antigravity')) return run()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atl-rules-'))
  try {
    const file = path.join(dir, 'atl.md')
    await writeFile(file, await antigravityRules())
    return await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function setupAgents(setup: AgentSetup): Promise<agents.Step[]> {
  const { mode, http, bin: givenBin, desktop = true, ...options } = setup
  const bin = givenBin ?? binCommand()
  const ctx = options.ctx ?? platformContext()
  const homes = agents.agentHomes(ctx, options.homes)
  const wanted = options.agents ?? 'detected'
  const resolved = wanted === 'all' ? [...agents.AGENTS] : wanted === 'detected' ? await agents.detectAgents(ctx, homes, options.locate) : [...wanted]
  const selected = desktop ? resolved : resolved.filter((agent) => agent !== 'claude-desktop')
  const base: agents.InstallOptions = { ...options, ctx }
  const steps: agents.Step[] = []
  if (selected.includes('claude')) {
    const plugin = await agents.installClaudePlugin(CLAUDE_PLUGIN, base)
    steps.push(...plugin)
    if (plugin.some((step) => step.state === 'failed' || step.state === 'unavailable')) {
      steps.push(...(await agents.installIntegration(integration(mode, http, bin), { ...base, agents: ['claude'] })))
      if (mode === 'none') steps.push(...(await agents.removeLegacyClaude(STALE_MCP, base)))
    } else {
      const legacy = integration('stdio', undefined, bin)
      steps.push(...(await agents.removeLegacyClaude(mode === 'none' ? legacy : { ...legacy, mcp: [] }, base)))
      if (mode !== 'none') steps.push(...(await agents.installIntegration(claudeMcpIntegration(mode, http, bin), { ...base, agents: ['claude'] })))
    }
  }
  const others = selected.filter((agent) => agent !== 'claude')
  if (others.length > 0) {
    const geminiHadMcp = mode === 'none' && others.includes('gemini') && (await hasGeminiMcp(homes))
    if (mode === 'none') steps.push(...(await removeStaleMcp(others, homes, base)))
    const installed = await withAntigravityRules(others, (rules) => agents.installIntegration(integration(mode, http, bin, rules), { ...base, agents: others }))
    steps.push(...installed)
    if (geminiHadMcp && installed.some((step) => step.agent === 'gemini' && step.item === 'extension' && step.state === 'installed')) {
      steps.push({ agent: 'gemini', item: 'mcp atl', state: 'removed', detail: 'MCP server atl dropped from the Gemini extension', path: path.join(homes.gemini, 'extensions', 'atl', 'gemini-extension.json') })
    }
  }
  return steps
}

export async function uninstallAgents(options: agents.InstallOptions = {}): Promise<agents.Step[]> {
  const steps = await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)
  steps.push(...(await agents.uninstallIntegration(integration('stdio'), { ...options, agents: options.agents ?? 'all' })))
  return steps
}

export async function register(httpUrl?: string | null, bin?: readonly string[]): Promise<string> {
  return registerTool(manifest(httpUrl, bin ?? (await installedBin())))
}

export async function unregister(): Promise<boolean> {
  return unregisterTool('atl')
}

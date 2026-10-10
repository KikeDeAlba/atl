import { existsSync } from 'node:fs'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
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

export function integration(mode: McpMode, http?: { url: string; token: string | null }, bin: readonly string[] = binCommand()): agents.AgentIntegration {
  const mcp: agents.McpServer[] =
    mode === 'none'
      ? []
      : mode === 'http' && http
        ? [{ name: 'atl', url: http.url, ...(http.token ? { headers: { Authorization: `Bearer ${http.token}` } } : {}) }]
        : [{ name: 'atl', command: [...bin, 'mcp'] }]
  return {
    tool: 'atl',
    version: VERSION,
    description: 'Jira, Jira Software and Confluence Cloud through atl',
    skills: [{ name: 'atl', dir: path.join(PACKAGE_ROOT, 'skill') }],
    mcp,
    claude: {
      permissions: {
        allow: [
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
          'mcp__atl__atl_sites',
          'mcp__atl__jira_get_issue',
          'mcp__atl__jira_search',
          'mcp__atl__confluence_get_page',
          'mcp__atl__confluence_search',
          'mcp__atl__api_search',
          'mcp__atl__api_describe',
        ],
      },
    },
  }
}

export async function register(httpUrl?: string | null, bin?: readonly string[]): Promise<string> {
  return registerTool(manifest(httpUrl, bin ?? (await installedBin())))
}

export async function unregister(): Promise<boolean> {
  return unregisterTool('atl')
}

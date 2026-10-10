import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toolDirs } from '@kikedealba/kit/platform'

export interface SiteConfig {
  name: string
  url: string
  email: string
  default?: boolean
}

export interface McpConfig {
  port?: number
  token?: string
}

export interface AtlConfig {
  sites: SiteConfig[]
  mcp?: McpConfig
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['ATL_CONFIG_PATH'] ?? path.join(toolDirs('atl').config, 'config.json')
}

export function emptyConfig(): AtlConfig {
  return { sites: [] }
}

export async function readConfig(file: string = configPath()): Promise<AtlConfig> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<AtlConfig>
    return { ...parsed, sites: Array.isArray(parsed.sites) ? parsed.sites.filter(isSite) : [] }
  } catch {
    return emptyConfig()
  }
}

export async function writeConfig(config: AtlConfig, file: string = configPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

function isSite(value: unknown): value is SiteConfig {
  if (typeof value !== 'object' || value === null) return false
  const site = value as Record<string, unknown>
  return typeof site['name'] === 'string' && typeof site['url'] === 'string' && typeof site['email'] === 'string'
}

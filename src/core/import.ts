import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { credentialStore, type CredentialStore } from '@kikedealba/kit/credentials'
import { normalizeSiteUrl, type SiteRegistry } from './sites.ts'

export const BITA_KEYCHAIN_SERVICE = 'bita-atlassian'

export interface ImportOutcome {
  url: string
  email: string
  state: 'imported' | 'no-token' | 'invalid'
  name?: string
}

export function bitaConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['BITA_CONFIG_PATH'] ?? path.join(homedir(), '.config', 'bita', 'config.json')
}

export async function importFromBita(
  registry: SiteRegistry,
  options: { configFile?: string; store?: CredentialStore } = {},
): Promise<ImportOutcome[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(options.configFile ?? bitaConfigPath(), 'utf8'))
  } catch {
    return []
  }
  const config = raw as { atlassian?: { sites?: Array<{ site?: string; email?: string }> }; jira?: { siteUrl?: string; email?: string } }
  const entries = [...(config.atlassian?.sites ?? [])]
  if (entries.length === 0 && config.jira?.siteUrl && config.jira.email) entries.push({ site: config.jira.siteUrl, email: config.jira.email })
  const store = options.store ?? (await credentialStore())
  const outcomes: ImportOutcome[] = []
  for (const entry of entries) {
    const url = entry.site ? normalizeSiteUrl(entry.site) : null
    const email = entry.email ?? ''
    if (!url || !email) {
      outcomes.push({ url: entry.site ?? '', email, state: 'invalid' })
      continue
    }
    const token = (await store.get(BITA_KEYCHAIN_SERVICE, `${url}|${email}`)) ?? (await store.get(BITA_KEYCHAIN_SERVICE, email))
    if (!token) {
      outcomes.push({ url, email, state: 'no-token' })
      continue
    }
    const site = await registry.add({ url, email, token })
    outcomes.push({ url, email, state: 'imported', name: site.name })
  }
  return outcomes
}

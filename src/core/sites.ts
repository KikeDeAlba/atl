import { credentialStore, type CredentialStore } from '@kikedealba/kit/credentials'
import { AtlError, EXIT, notFound, usageError } from '../errors.ts'
import { readConfig, writeConfig, type AtlConfig, type SiteConfig } from './config.ts'

export const CREDENTIAL_SERVICE = 'atl'
export const ENV_SITE = 'ATL_SITE_URL'
export const ENV_EMAIL = 'ATL_EMAIL'
export const ENV_TOKEN = 'ATL_TOKEN'

export const LOGIN_HINT =
  'Run "atl site add https://<name>.atlassian.net --email <you@company.com>" and paste an API token from https://id.atlassian.com/manage-profile/security/api-tokens'

export interface Credentials {
  site: SiteConfig
  token: string
}

export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '').replace(/\/wiki$/, '')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.includes('.') ? trimmed : `${trimmed}.atlassian.net`}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
    if (url.pathname !== '/' && url.pathname !== '') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

export function defaultSiteName(url: string): string {
  const host = new URL(url).hostname
  return host.endsWith('.atlassian.net') ? host.slice(0, -'.atlassian.net'.length) : host
}

export function account(site: SiteConfig): string {
  return `${site.url}|${site.email}`
}

export function findSite(config: AtlConfig, ref: string): SiteConfig | undefined {
  const byName = config.sites.find((site) => site.name.toLowerCase() === ref.toLowerCase())
  if (byName) return byName
  const url = normalizeSiteUrl(ref)
  return url ? config.sites.find((site) => site.url === url) : undefined
}

export function defaultSite(config: AtlConfig): SiteConfig | undefined {
  return config.sites.find((site) => site.default) ?? config.sites[0]
}

function envSite(env: NodeJS.ProcessEnv): Credentials | null {
  const url = env[ENV_SITE] ? normalizeSiteUrl(env[ENV_SITE]) : null
  const email = env[ENV_EMAIL]
  const token = env[ENV_TOKEN]
  if (!url || !email || !token) return null
  return { site: { name: defaultSiteName(url), url, email }, token }
}

export class SiteRegistry {
  private config: AtlConfig | null = null
  private store: CredentialStore | null = null
  private readonly cache = new Map<string, Credentials>()

  private readonly options: { configFile?: string; env?: NodeJS.ProcessEnv; store?: CredentialStore }

  constructor(options: { configFile?: string; env?: NodeJS.ProcessEnv; store?: CredentialStore } = {}) {
    this.options = options
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  async load(): Promise<AtlConfig> {
    if (!this.config) this.config = await readConfig(this.options.configFile)
    return this.config
  }

  async save(config: AtlConfig): Promise<void> {
    await writeConfig(config, this.options.configFile)
    this.config = config
    this.cache.clear()
  }

  async credentialStore(): Promise<CredentialStore> {
    if (!this.store) this.store = this.options.store ?? (await credentialStore())
    return this.store
  }

  async list(): Promise<SiteConfig[]> {
    return (await this.load()).sites
  }

  async resolve(ref?: string | null): Promise<SiteConfig> {
    const config = await this.load()
    if (ref) {
      const found = findSite(config, ref)
      if (found) return found
      const fromEnv = envSite(this.env())
      if (fromEnv && (fromEnv.site.name === ref || fromEnv.site.url === normalizeSiteUrl(ref))) return fromEnv.site
      throw notFound(`There is no Atlassian site "${ref}".`, 'SITE_NOT_FOUND', `Known sites: ${config.sites.map((site) => site.name).join(', ') || 'none'}. ${LOGIN_HINT}`)
    }
    const fallback = defaultSite(config) ?? envSite(this.env())?.site
    if (!fallback) throw new AtlError('There is no Atlassian site yet.', { code: 'LOGIN_REQUIRED', exitCode: EXIT.auth, hint: LOGIN_HINT })
    return fallback
  }

  async credentials(ref?: string | null): Promise<Credentials> {
    const site = await this.resolve(ref)
    const cached = this.cache.get(site.url)
    if (cached) return cached
    const fromEnv = envSite(this.env())
    let token: string | null = fromEnv && fromEnv.site.url === site.url && fromEnv.site.email === site.email ? fromEnv.token : null
    token ??= await (await this.credentialStore()).get(CREDENTIAL_SERVICE, account(site))
    if (!token) {
      throw new AtlError(`There is no API token for ${site.email} on ${site.url}.`, { code: 'LOGIN_REQUIRED', exitCode: EXIT.auth, hint: LOGIN_HINT })
    }
    const credentials = { site, token }
    this.cache.set(site.url, credentials)
    return credentials
  }

  async add(input: { url: string; email: string; token: string; name?: string; makeDefault?: boolean }): Promise<SiteConfig> {
    const url = normalizeSiteUrl(input.url)
    if (!url) throw usageError(`"${input.url}" is not an Atlassian site.`, 'Expected something like https://company.atlassian.net')
    const config = await this.load()
    const name = input.name ?? config.sites.find((site) => site.url === url)?.name ?? defaultSiteName(url)
    const clash = config.sites.find((site) => site.name === name && site.url !== url)
    if (clash) throw usageError(`The name "${name}" is already used by ${clash.url}.`, 'Pick another one with --name.')
    const previous = config.sites.find((site) => site.url === url)
    const site: SiteConfig = { name, url, email: input.email, ...(previous?.default ? { default: true } : {}) }
    let sites = previous ? config.sites.map((entry) => (entry.url === url ? site : entry)) : [...config.sites, site]
    if (input.makeDefault || sites.length === 1) sites = withDefault(sites, url)
    await (await this.credentialStore()).set(CREDENTIAL_SERVICE, account(site), input.token)
    if (previous && previous.email !== input.email) await (await this.credentialStore()).delete(CREDENTIAL_SERVICE, account(previous))
    await this.save({ ...config, sites })
    return sites.find((entry) => entry.url === url) ?? site
  }

  async remove(ref: string): Promise<SiteConfig> {
    const config = await this.load()
    const site = findSite(config, ref)
    if (!site) throw notFound(`There is no Atlassian site "${ref}".`, 'SITE_NOT_FOUND')
    await (await this.credentialStore()).delete(CREDENTIAL_SERVICE, account(site))
    let sites = config.sites.filter((entry) => entry.url !== site.url)
    if (site.default && sites[0]) sites = sites.map((entry, index) => (index === 0 ? { ...entry, default: true } : entry))
    await this.save({ ...config, sites })
    return site
  }

  async setDefault(ref: string): Promise<SiteConfig> {
    const config = await this.load()
    const site = findSite(config, ref)
    if (!site) throw notFound(`There is no Atlassian site "${ref}".`, 'SITE_NOT_FOUND')
    const sites = withDefault(config.sites, site.url)
    await this.save({ ...config, sites })
    return { ...site, default: true }
  }
}

function withDefault(sites: readonly SiteConfig[], url: string): SiteConfig[] {
  return sites.map(({ default: _default, ...entry }) => (entry.url === url ? { ...entry, default: true } : entry))
}

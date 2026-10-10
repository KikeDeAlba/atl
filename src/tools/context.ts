import { SiteRegistry } from '../core/sites.ts'
import { AtlassianClient, type Fetch } from '../http/client.ts'
import { JiraService } from '../jira/service.ts'
import { ConfluenceService } from '../confluence/service.ts'

export class ToolContext {
  private readonly clients = new Map<string, AtlassianClient>()
  readonly sites: SiteRegistry
  private readonly fetchImpl: Fetch | undefined

  constructor(sites: SiteRegistry = new SiteRegistry(), fetchImpl?: Fetch) {
    this.sites = sites
    this.fetchImpl = fetchImpl
  }

  async client(site?: string | null): Promise<AtlassianClient> {
    const credentials = await this.sites.credentials(site ?? null)
    let client = this.clients.get(credentials.site.url)
    if (!client) {
      client = new AtlassianClient(credentials, this.fetchImpl ? { fetch: this.fetchImpl } : {})
      this.clients.set(credentials.site.url, client)
    }
    return client
  }

  async jira(site?: string | null): Promise<JiraService> {
    return new JiraService(await this.client(site))
  }

  async confluence(site?: string | null): Promise<ConfluenceService> {
    return new ConfluenceService(await this.client(site))
  }
}

import { AtlError, EXIT } from '../errors.ts'
import { fileForm, linksPager, mediaTypeOf, type AtlassianClient } from '../http/client.ts'
import { markdownToStorage, storageToMarkdown } from '../convert/storage.ts'

export type BodyFormat = 'markdown' | 'storage'

export interface PageView {
  id: string
  title: string
  version: number
  spaceId: string | null
  parentId: string | null
  status: string | null
  url: string | null
  body?: string
  format?: BodyFormat
}

export interface PageSummary {
  id: string
  title: string
  status: string | null
  spaceId: string | null
  position: number | null
}

interface RawPage {
  id: string | number
  title?: string
  status?: string
  spaceId?: string | number | null
  parentId?: string | number | null
  version?: { number?: number }
  body?: { storage?: { value?: string } }
  _links?: { webui?: string; base?: string }
}

function idOf(value: string | number | null | undefined): string | null {
  return value === undefined || value === null ? null : String(value)
}

export function toStorage(body: string, format: BodyFormat): string {
  return format === 'markdown' ? markdownToStorage(body) : body
}

export class ConfluenceService {
  readonly client: AtlassianClient

  constructor(client: AtlassianClient) {
    this.client = client
  }

  private webUrl(links: { webui?: string; base?: string } | undefined): string | null {
    return links?.webui ? `${links.base ?? `${this.client.site}/wiki`}${links.webui}` : null
  }

  private view(raw: RawPage, format: BodyFormat | null): PageView {
    const storage = raw.body?.storage?.value
    return {
      id: String(raw.id),
      title: raw.title ?? '',
      version: raw.version?.number ?? 1,
      spaceId: idOf(raw.spaceId),
      parentId: idOf(raw.parentId),
      status: raw.status ?? null,
      url: this.webUrl(raw._links),
      ...(format && storage !== undefined ? { body: format === 'markdown' ? storageToMarkdown(storage) : storage, format } : {}),
    }
  }

  async currentUser(): Promise<{ accountId: string; displayName: string }> {
    const body = (await this.client.get('/wiki/rest/api/user/current')) as { accountId?: string; displayName?: string }
    return { accountId: body.accountId ?? '', displayName: body.displayName ?? '' }
  }

  async spaces(options: { keys?: string[]; limit?: number } = {}): Promise<Array<{ id: string; key: string; name: string; type: string | null; homepageId: string | null; url: string | null }>> {
    const found = []
    const limit = options.limit ?? 250
    for await (const raw of this.client.pages('/wiki/api/v2/spaces', { limit: Math.min(limit, 250), ...(options.keys ? { keys: options.keys.join(',') } : {}) }, linksPager)) {
      const space = raw as { id: string | number; key: string; name?: string; type?: string; homepageId?: string | number | null; _links?: { webui?: string; base?: string } }
      found.push({ id: String(space.id), key: space.key, name: space.name ?? space.key, type: space.type ?? null, homepageId: idOf(space.homepageId), url: this.webUrl(space._links) })
      if (found.length >= limit) break
    }
    return found
  }

  async spaceId(ref: string): Promise<string> {
    if (/^\d+$/.test(ref)) return ref
    const [space] = await this.spaces({ keys: [ref], limit: 1 })
    if (!space) throw new AtlError(`There is no Confluence space ${ref}, or it is not visible.`, { code: 'SPACE_NOT_FOUND', exitCode: EXIT.notFound })
    return space.id
  }

  async getPage(id: string, format: BodyFormat | null = 'markdown'): Promise<PageView> {
    const body = (await this.client.get(`/wiki/api/v2/pages/${encodeURIComponent(id)}`, format ? { 'body-format': 'storage' } : undefined)) as RawPage
    return this.view(body, format)
  }

  async findPageByTitle(space: string, title: string): Promise<PageView | null> {
    const spaceId = await this.spaceId(space)
    const body = (await this.client.get('/wiki/api/v2/pages', { 'space-id': spaceId, title, limit: 1 })) as { results?: RawPage[] }
    const first = body.results?.[0]
    return first ? this.view(first, null) : null
  }

  async createPage(input: { space: string; title: string; body: string; format?: BodyFormat; parentId?: string; draft?: boolean }): Promise<PageView> {
    const spaceId = await this.spaceId(input.space)
    const raw = (await this.client.post('/wiki/api/v2/pages', {
      spaceId,
      status: input.draft ? 'draft' : 'current',
      title: input.title,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      body: { representation: 'storage', value: toStorage(input.body, input.format ?? 'markdown') },
    })) as RawPage
    return this.view(raw, null)
  }

  async updatePage(input: { id: string; title?: string; body?: string; format?: BodyFormat; message?: string; parentId?: string; version?: number }): Promise<PageView> {
    const current = await this.getPage(input.id, input.body === undefined ? 'storage' : null)
    const storage = input.body === undefined ? (current.body ?? '') : toStorage(input.body, input.format ?? 'markdown')
    const raw = (await this.client.put(`/wiki/api/v2/pages/${encodeURIComponent(input.id)}`, {
      id: input.id,
      status: 'current',
      title: input.title ?? current.title,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      body: { representation: 'storage', value: storage },
      version: { number: (input.version ?? current.version) + 1, ...(input.message ? { message: input.message } : {}) },
    })) as RawPage
    return this.view(raw, null)
  }

  async upsertPage(input: { space: string; title: string; body: string; format?: BodyFormat; parentId?: string; message?: string }): Promise<PageView & { created: boolean }> {
    const existing = await this.findPageByTitle(input.space, input.title)
    if (existing) {
      return { ...(await this.updatePage({ id: existing.id, body: input.body, ...(input.format ? { format: input.format } : {}), ...(input.message ? { message: input.message } : {}) })), created: false }
    }
    return { ...(await this.createPage(input)), created: true }
  }

  async deletePage(id: string, purge = false): Promise<void> {
    await this.client.delete(`/wiki/api/v2/pages/${encodeURIComponent(id)}`, purge ? { purge: true } : undefined)
  }

  async children(id: string): Promise<PageSummary[]> {
    const found: PageSummary[] = []
    for await (const raw of this.client.pages(`/wiki/api/v2/pages/${encodeURIComponent(id)}/children`, { limit: 250 }, linksPager)) {
      const page = raw as { id: string | number; title?: string; status?: string; spaceId?: string | number; childPosition?: number }
      found.push({ id: String(page.id), title: page.title ?? '', status: page.status ?? null, spaceId: idOf(page.spaceId), position: page.childPosition ?? null })
    }
    return found
  }

  async descendants(id: string, depth = 5): Promise<Array<PageSummary & { depth: number; parentId: string | null }>> {
    const found: Array<PageSummary & { depth: number; parentId: string | null }> = []
    for await (const raw of this.client.pages(`/wiki/api/v2/pages/${encodeURIComponent(id)}/descendants`, { limit: 250, depth }, linksPager)) {
      const page = raw as { id: string | number; title?: string; status?: string; parentId?: string | number; depth?: number; childPosition?: number }
      found.push({ id: String(page.id), title: page.title ?? '', status: page.status ?? null, spaceId: null, position: page.childPosition ?? null, depth: page.depth ?? 0, parentId: idOf(page.parentId) })
    }
    return found
  }

  async search(cql: string, limit = 25): Promise<Array<{ id: string; type: string; title: string; space: string | null; excerpt: string; lastModified: string | null; url: string | null }>> {
    const body = (await this.client.get('/wiki/rest/api/search', { cql, limit })) as {
      results?: Array<{ content?: { id?: string; type?: string; title?: string }; title?: string; excerpt?: string; url?: string; lastModified?: string; resultGlobalContainer?: { title?: string } }>
    }
    return (body.results ?? []).map((raw) => ({
      id: raw.content?.id ?? '',
      type: raw.content?.type ?? '',
      title: raw.content?.title ?? raw.title ?? '',
      space: raw.resultGlobalContainer?.title ?? null,
      excerpt: (raw.excerpt ?? '').replace(/@@@(end)?hl@@@/g, ''),
      lastModified: raw.lastModified ?? null,
      url: raw.url ? `${this.client.site}/wiki${raw.url}` : null,
    }))
  }

  async attach(pageId: string, filePath: string, comment?: string): Promise<{ attachmentId: string; filename: string; fileId: string | null; mediaType: string; downloadUrl: string | null }> {
    const form = await fileForm(filePath, { minorEdit: 'true', ...(comment ? { comment } : {}) })
    const body = (await this.client.request(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`, { method: 'PUT', form })) as {
      results?: RawAttachment[]
    } & RawAttachment
    const raw = body.results?.[0] ?? body
    const filename = filePath.split(/[\\/]/).pop() ?? filePath
    return {
      attachmentId: raw.id ?? '',
      filename: raw.title ?? filename,
      fileId: raw.extensions?.fileId ?? null,
      mediaType: raw.extensions?.mediaType ?? raw.metadata?.mediaType ?? mediaTypeOf(filename),
      downloadUrl: raw._links?.download ? `${this.client.site}/wiki${raw._links.download}` : null,
    }
  }

  async attachments(pageId: string): Promise<Array<{ id: string; title: string; mediaType: string | null; fileSize: number | null; downloadUrl: string | null }>> {
    const found = []
    for await (const raw of this.client.pages(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/attachments`, { limit: 250 }, linksPager)) {
      const item = raw as { id: string; title?: string; mediaType?: string; fileSize?: number; downloadLink?: string }
      found.push({ id: item.id, title: item.title ?? '', mediaType: item.mediaType ?? null, fileSize: item.fileSize ?? null, downloadUrl: item.downloadLink ? `${this.client.site}/wiki${item.downloadLink}` : null })
    }
    return found
  }

  async addFooterComment(pageId: string, body: string, format: BodyFormat = 'markdown'): Promise<{ id: string }> {
    const raw = (await this.client.post('/wiki/api/v2/footer-comments', { pageId, body: { representation: 'storage', value: toStorage(body, format) } })) as { id?: string | number }
    return { id: String(raw.id ?? '') }
  }

  async footerComments(pageId: string): Promise<Array<{ id: string; author: string | null; created: string | null; body: string }>> {
    const found = []
    for await (const raw of this.client.pages(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/footer-comments`, { limit: 100, 'body-format': 'storage' }, linksPager)) {
      const item = raw as { id: string | number; version?: { authorId?: string; createdAt?: string }; body?: { storage?: { value?: string } } }
      found.push({ id: String(item.id), author: item.version?.authorId ?? null, created: item.version?.createdAt ?? null, body: storageToMarkdown(item.body?.storage?.value ?? '') })
    }
    return found
  }

  async labels(pageId: string): Promise<string[]> {
    const found: string[] = []
    for await (const raw of this.client.pages(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/labels`, { limit: 250 }, linksPager)) {
      const name = (raw as { name?: string }).name
      if (name) found.push(name)
    }
    return found
  }

  async addLabels(pageId: string, labels: readonly string[]): Promise<void> {
    await this.client.post(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/label`, labels.map((name) => ({ prefix: 'global', name })))
  }
}

interface RawAttachment {
  id?: string
  title?: string
  extensions?: { fileId?: string; mediaType?: string }
  metadata?: { mediaType?: string }
  _links?: { download?: string }
}

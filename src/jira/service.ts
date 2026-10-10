import { AtlError, EXIT, usageError } from '../errors.ts'
import { fileForm, startAtPager, type AtlassianClient } from '../http/client.ts'
import { adfToMarkdown, markdownToAdf, type AdfDocument } from '../convert/adf.ts'

export interface IssueView {
  id: string
  key: string
  url: string
  summary: string
  status: string | null
  statusCategory: string | null
  issueType: string | null
  parentKey: string | null
  projectKey: string | null
  assignee: string | null
  reporter: string | null
  priority: string | null
  labels: string[]
  description: string
  originalEstimateSeconds: number | null
  timeSpentSeconds: number | null
  created: string | null
  updated: string | null
  fields?: Record<string, unknown>
}

export interface NewIssue {
  project: string
  type: string
  summary: string
  description?: string
  parent?: string
  estimate?: string
  assignee?: string
  labels?: string[]
  priority?: string
  components?: string[]
  fields?: Record<string, unknown>
}

function nested(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const step of path) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[step]
  }
  return current ?? null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

export function jiraDateTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) throw usageError(`"${iso}" is not a date and time.`)
  return parsed.toISOString().replace('Z', '+0000')
}

export function parseDuration(text: string): number {
  const trimmed = text.trim().toLowerCase()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  let seconds = 0
  let matched = false
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/g)) {
    matched = true
    const value = Number(match[1])
    const unit = match[2]
    seconds += value * (unit === 'w' ? 5 * 8 * 3600 : unit === 'd' ? 8 * 3600 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1)
  }
  if (!matched) throw usageError(`"${text}" is not a duration. Use forms like 1h30m, 2d, 45m or seconds.`)
  return Math.round(seconds)
}

export function richText(value: string | AdfDocument | undefined): AdfDocument | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? markdownToAdf(value) : value
}

export class JiraService {
  readonly client: AtlassianClient

  constructor(client: AtlassianClient) {
    this.client = client
  }

  issueUrl(key: string): string {
    return `${this.client.site}/browse/${key}`
  }

  toView(raw: unknown, includeFields = false): IssueView {
    const fields = (nested(raw, 'fields') ?? {}) as Record<string, unknown>
    const key = str(nested(raw, 'key')) ?? ''
    return {
      id: str(nested(raw, 'id')) ?? '',
      key,
      url: this.issueUrl(key),
      summary: str(fields['summary']) ?? '',
      status: str(nested(fields, 'status', 'name')),
      statusCategory: str(nested(fields, 'status', 'statusCategory', 'key')),
      issueType: str(nested(fields, 'issuetype', 'name')),
      parentKey: str(nested(fields, 'parent', 'key')),
      projectKey: str(nested(fields, 'project', 'key')),
      assignee: str(nested(fields, 'assignee', 'displayName')),
      reporter: str(nested(fields, 'reporter', 'displayName')),
      priority: str(nested(fields, 'priority', 'name')),
      labels: Array.isArray(fields['labels']) ? (fields['labels'] as string[]) : [],
      description: adfToMarkdown(fields['description']),
      originalEstimateSeconds: num(nested(fields, 'timetracking', 'originalEstimateSeconds')) ?? num(fields['timeoriginalestimate']),
      timeSpentSeconds: num(nested(fields, 'timetracking', 'timeSpentSeconds')) ?? num(fields['timespent']),
      created: str(fields['created']),
      updated: str(fields['updated']),
      ...(includeFields ? { fields } : {}),
    }
  }

  async myself(): Promise<{ accountId: string; displayName: string; emailAddress: string | null; timeZone: string | null }> {
    const body = await this.client.get('/rest/api/3/myself')
    return {
      accountId: str(nested(body, 'accountId')) ?? '',
      displayName: str(nested(body, 'displayName')) ?? '',
      emailAddress: str(nested(body, 'emailAddress')),
      timeZone: str(nested(body, 'timeZone')),
    }
  }

  async projects(query?: string): Promise<Array<{ id: string; key: string; name: string; type: string | null }>> {
    const found = []
    for await (const raw of this.client.pages('/rest/api/3/project/search', { maxResults: 50, ...(query ? { query } : {}) }, startAtPager('values'))) {
      found.push({ id: str(nested(raw, 'id')) ?? '', key: str(nested(raw, 'key')) ?? '', name: str(nested(raw, 'name')) ?? '', type: str(nested(raw, 'projectTypeKey')) })
    }
    return found
  }

  async getIssue(key: string, options: { fields?: readonly string[]; expand?: string; includeFields?: boolean } = {}): Promise<IssueView> {
    const body = await this.client.get(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      ...(options.fields && options.fields.length > 0 ? { fields: options.fields.join(',') } : {}),
      ...(options.expand ? { expand: options.expand } : {}),
    })
    return this.toView(body, options.includeFields ?? false)
  }

  async resolveAccountId(value: string): Promise<string> {
    if (value === 'me' || value === '@me') return (await this.myself()).accountId
    if (!value.includes('@') && !value.includes(' ')) return value
    const users = (await this.client.get('/rest/api/3/user/search', { query: value, maxResults: 5 })) as unknown[]
    const first = users[0]
    const accountId = str(nested(first, 'accountId'))
    if (!accountId) throw new AtlError(`No Jira user matches "${value}".`, { code: 'USER_NOT_FOUND', exitCode: EXIT.notFound })
    return accountId
  }

  async issueFields(input: Partial<NewIssue>): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = { ...(input.fields ?? {}) }
    if (input.project) fields['project'] = /^\d+$/.test(input.project) ? { id: input.project } : { key: input.project }
    if (input.type) fields['issuetype'] = /^\d+$/.test(input.type) ? { id: input.type } : { name: input.type }
    if (input.summary !== undefined) fields['summary'] = input.summary
    if (input.description !== undefined) fields['description'] = markdownToAdf(input.description)
    if (input.parent) fields['parent'] = { key: input.parent }
    if (input.estimate) fields['timetracking'] = { originalEstimate: input.estimate }
    if (input.assignee) fields['assignee'] = { accountId: await this.resolveAccountId(input.assignee) }
    if (input.labels) fields['labels'] = input.labels
    if (input.priority) fields['priority'] = { name: input.priority }
    if (input.components) fields['components'] = input.components.map((name) => ({ name }))
    return fields
  }

  async createIssue(input: NewIssue): Promise<{ id: string; key: string; url: string }> {
    const body = await this.client.post('/rest/api/3/issue', { fields: await this.issueFields(input) })
    const key = str(nested(body, 'key')) ?? ''
    return { id: str(nested(body, 'id')) ?? '', key, url: this.issueUrl(key) }
  }

  async editIssue(key: string, input: Partial<NewIssue>, notify = true): Promise<void> {
    const { project: _project, ...rest } = input
    const fields = await this.issueFields(rest)
    await this.client.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields }, notify ? undefined : { notifyUsers: false })
  }

  async deleteIssue(key: string, withSubtasks = false): Promise<void> {
    await this.client.delete(`/rest/api/3/issue/${encodeURIComponent(key)}`, { deleteSubtasks: withSubtasks })
  }

  async assign(key: string, assignee: string | null): Promise<void> {
    const accountId = assignee === null ? null : await this.resolveAccountId(assignee)
    await this.client.put(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId })
  }

  async transitions(key: string): Promise<Array<{ id: string; name: string; to: string | null; category: string | null }>> {
    const body = await this.client.get(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
    const list = nested(body, 'transitions')
    return (Array.isArray(list) ? list : []).map((raw) => ({
      id: str(nested(raw, 'id')) ?? '',
      name: str(nested(raw, 'name')) ?? '',
      to: str(nested(raw, 'to', 'name')),
      category: str(nested(raw, 'to', 'statusCategory', 'key')),
    }))
  }

  async transition(key: string, target: string, comment?: string): Promise<{ id: string; name: string; to: string | null }> {
    const available = await this.transitions(key)
    const wanted = target.toLowerCase()
    const match =
      available.find((transition) => transition.id === target) ??
      available.find((transition) => transition.name.toLowerCase() === wanted) ??
      available.find((transition) => transition.to?.toLowerCase() === wanted) ??
      (wanted === 'done' ? available.find((transition) => transition.category === 'done') : undefined)
    if (!match) {
      throw new AtlError(`${key} cannot move to "${target}".`, {
        code: 'TRANSITION_NOT_AVAILABLE',
        exitCode: EXIT.conflict,
        hint: `Available: ${available.map((transition) => `${transition.name} → ${transition.to ?? '?'}`).join(', ') || 'none'}`,
      })
    }
    await this.client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: match.id },
      ...(comment ? { update: { comment: [{ add: { body: markdownToAdf(comment) } }] } } : {}),
    })
    return match
  }

  async search(jql: string, options: { limit?: number; fields?: readonly string[] } = {}): Promise<IssueView[]> {
    const limit = options.limit ?? 50
    const fields = options.fields ?? ['summary', 'status', 'issuetype', 'parent', 'project', 'assignee', 'reporter', 'priority', 'labels', 'timetracking', 'created', 'updated']
    const issues: IssueView[] = []
    let nextPageToken: string | undefined
    while (issues.length < limit) {
      const body = await this.client.post('/rest/api/3/search/jql', {
        jql,
        maxResults: Math.min(100, limit - issues.length),
        fields,
        ...(nextPageToken ? { nextPageToken } : {}),
      })
      const page = nested(body, 'issues')
      for (const raw of Array.isArray(page) ? page : []) issues.push(this.toView(raw))
      const token = str(nested(body, 'nextPageToken'))
      if (!token || !Array.isArray(page) || page.length === 0) break
      nextPageToken = token
    }
    return issues.slice(0, limit)
  }

  async createMeta(project: string, issueType?: string): Promise<unknown> {
    if (!issueType) {
      const body = await this.client.get(`/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`, { maxResults: 200 })
      const list = nested(body, 'issueTypes') ?? nested(body, 'values')
      return (Array.isArray(list) ? list : []).map((raw) => ({
        id: str(nested(raw, 'id')) ?? '',
        name: str(nested(raw, 'name')) ?? '',
        subtask: nested(raw, 'subtask') === true,
        hierarchyLevel: num(nested(raw, 'hierarchyLevel')),
      }))
    }
    let typeId = issueType
    if (!/^\d+$/.test(issueType)) {
      const types = (await this.createMeta(project)) as Array<{ id: string; name: string }>
      const found = types.find((type) => type.name.toLowerCase() === issueType.toLowerCase())
      if (!found) throw new AtlError(`${project} has no issue type "${issueType}".`, { code: 'ISSUE_TYPE_NOT_FOUND', exitCode: EXIT.notFound, hint: `Types: ${types.map((type) => type.name).join(', ')}` })
      typeId = found.id
    }
    const body = await this.client.get(`/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(typeId)}`, { maxResults: 200 })
    const list = nested(body, 'fields') ?? nested(body, 'values')
    return (Array.isArray(list) ? list : []).map((raw) => ({
      fieldId: str(nested(raw, 'fieldId')) ?? str(nested(raw, 'key')) ?? '',
      name: str(nested(raw, 'name')) ?? '',
      required: nested(raw, 'required') === true,
      schema: nested(raw, 'schema'),
      allowedValues: nested(raw, 'allowedValues'),
    }))
  }

  async addWorklog(key: string, input: { started: string; timeSpent: string | number; comment?: string; adjustEstimate?: 'auto' | 'leave' | 'new' | 'manual'; newEstimate?: string }): Promise<{ id: string; started: string; timeSpentSeconds: number }> {
    const seconds = typeof input.timeSpent === 'number' ? input.timeSpent : parseDuration(input.timeSpent)
    const body = await this.client.post(
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`,
      { started: jiraDateTime(input.started), timeSpentSeconds: seconds, ...(input.comment ? { comment: markdownToAdf(input.comment) } : {}) },
      { ...(input.adjustEstimate ? { adjustEstimate: input.adjustEstimate } : {}), ...(input.newEstimate ? { newEstimate: input.newEstimate } : {}) },
    )
    return { id: str(nested(body, 'id')) ?? '', started: str(nested(body, 'started')) ?? jiraDateTime(input.started), timeSpentSeconds: num(nested(body, 'timeSpentSeconds')) ?? seconds }
  }

  async worklogs(key: string): Promise<Array<{ id: string; author: string | null; started: string | null; timeSpentSeconds: number | null; comment: string }>> {
    const found = []
    for await (const raw of this.client.pages(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, { maxResults: 1000 }, startAtPager('worklogs'))) {
      found.push({
        id: str(nested(raw, 'id')) ?? '',
        author: str(nested(raw, 'author', 'displayName')),
        started: str(nested(raw, 'started')),
        timeSpentSeconds: num(nested(raw, 'timeSpentSeconds')),
        comment: adfToMarkdown(nested(raw, 'comment')),
      })
    }
    return found
  }

  async addComment(key: string, markdown: string): Promise<{ id: string; created: string | null }> {
    const body = await this.client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: markdownToAdf(markdown) })
    return { id: str(nested(body, 'id')) ?? '', created: str(nested(body, 'created')) }
  }

  async comments(key: string): Promise<Array<{ id: string; author: string | null; created: string | null; updated: string | null; body: string }>> {
    const found = []
    for await (const raw of this.client.pages(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { maxResults: 100, orderBy: 'created' }, startAtPager('comments'))) {
      found.push({
        id: str(nested(raw, 'id')) ?? '',
        author: str(nested(raw, 'author', 'displayName')),
        created: str(nested(raw, 'created')),
        updated: str(nested(raw, 'updated')),
        body: adfToMarkdown(nested(raw, 'body')),
      })
    }
    return found
  }

  async deleteComment(key: string, commentId: string): Promise<void> {
    await this.client.delete(`/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`)
  }

  async attach(key: string, filePath: string): Promise<Array<{ id: string; filename: string; size: number | null; url: string | null }>> {
    const body = await this.client.request(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, { method: 'POST', form: await fileForm(filePath) })
    return (Array.isArray(body) ? body : []).map((raw) => ({
      id: str(nested(raw, 'id')) ?? '',
      filename: str(nested(raw, 'filename')) ?? '',
      size: num(nested(raw, 'size')),
      url: str(nested(raw, 'content')),
    }))
  }

  async link(type: string, inward: string, outward: string, comment?: string): Promise<void> {
    await this.client.post('/rest/api/3/issueLink', {
      type: { name: type },
      inwardIssue: { key: inward },
      outwardIssue: { key: outward },
      ...(comment ? { comment: { body: markdownToAdf(comment) } } : {}),
    })
  }

  async linkTypes(): Promise<Array<{ id: string; name: string; inward: string; outward: string }>> {
    const body = await this.client.get('/rest/api/3/issueLinkType')
    const list = nested(body, 'issueLinkTypes')
    return (Array.isArray(list) ? list : []).map((raw) => ({ id: str(nested(raw, 'id')) ?? '', name: str(nested(raw, 'name')) ?? '', inward: str(nested(raw, 'inward')) ?? '', outward: str(nested(raw, 'outward')) ?? '' }))
  }

  async remoteLink(key: string, url: string, title: string): Promise<{ id: number | null }> {
    const body = await this.client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, { object: { url, title } })
    return { id: num(nested(body, 'id')) }
  }

  async boards(project?: string): Promise<Array<{ id: number; name: string; type: string | null }>> {
    const found = []
    for await (const raw of this.client.pages('/rest/agile/1.0/board', { maxResults: 50, ...(project ? { projectKeyOrId: project } : {}) }, startAtPager('values'))) {
      found.push({ id: num(nested(raw, 'id')) ?? 0, name: str(nested(raw, 'name')) ?? '', type: str(nested(raw, 'type')) })
    }
    return found
  }

  async sprints(boardId: number, state?: string): Promise<Array<{ id: number; name: string; state: string | null; startDate: string | null; endDate: string | null; goal: string | null }>> {
    const found = []
    for await (const raw of this.client.pages(`/rest/agile/1.0/board/${boardId}/sprint`, { maxResults: 50, ...(state ? { state } : {}) }, startAtPager('values'))) {
      found.push({
        id: num(nested(raw, 'id')) ?? 0,
        name: str(nested(raw, 'name')) ?? '',
        state: str(nested(raw, 'state')),
        startDate: str(nested(raw, 'startDate')),
        endDate: str(nested(raw, 'endDate')),
        goal: str(nested(raw, 'goal')),
      })
    }
    return found
  }

  async moveToSprint(sprintId: number, issues: readonly string[]): Promise<void> {
    await this.client.post(`/rest/agile/1.0/sprint/${sprintId}/issue`, { issues })
  }
}

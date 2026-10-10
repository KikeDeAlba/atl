import { describeOperation, callOperation, catalogStats, findOperation, isProduct, PRODUCTS, searchOperations, type Product } from '../api/catalog.ts'
import { adfToMarkdown, markdownToAdf } from '../convert/adf.ts'
import { markdownToStorage, storageToMarkdown } from '../convert/storage.ts'
import { usageError } from '../errors.ts'
import type { NewIssue } from '../jira/service.ts'
import type { BodyFormat } from '../confluence/service.ts'
import type { ToolContext } from './context.ts'
import { objectSchema, s, type Schema } from './schema.ts'

export interface ToolDefinition {
  name: string
  title: string
  description: string
  properties: Record<string, Schema>
  required?: string[]
  network?: boolean
  readOnly?: boolean
  destructive?: boolean
  cli: { path: string[]; positionals?: string[] }
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>
}

const SITE = s.string('Atlassian site name or URL. Defaults to the default site.')

export function toolInputSchema(tool: ToolDefinition): Schema {
  const properties = tool.network === false ? tool.properties : { ...tool.properties, site: SITE }
  return objectSchema(properties, tool.required ?? [])
}

function site(args: Record<string, unknown>): string | null {
  return typeof args['site'] === 'string' && args['site'].length > 0 ? args['site'] : null
}

function text(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function need(args: Record<string, unknown>, key: string): string {
  const value = text(args, key)
  if (value === undefined || value.length === 0) throw usageError(`Missing "${key}".`)
  return value
}

function list(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return undefined
}

function integer(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const value = args[key]
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return fallback
}

function format(args: Record<string, unknown>): BodyFormat {
  return args['format'] === 'storage' ? 'storage' : 'markdown'
}

function newIssue(args: Record<string, unknown>): NewIssue {
  const issue: NewIssue = { project: need(args, 'project'), type: need(args, 'type'), summary: need(args, 'summary') }
  const description = text(args, 'description')
  if (description !== undefined) issue.description = description
  const parent = text(args, 'parent')
  if (parent) issue.parent = parent
  const estimate = text(args, 'estimate')
  if (estimate) issue.estimate = estimate
  const assignee = text(args, 'assignee')
  if (assignee) issue.assignee = assignee
  const labels = list(args, 'labels')
  if (labels) issue.labels = labels
  const priority = text(args, 'priority')
  if (priority) issue.priority = priority
  const components = list(args, 'components')
  if (components) issue.components = components
  if (typeof args['fields'] === 'object' && args['fields'] !== null) issue.fields = args['fields'] as Record<string, unknown>
  return issue
}

const ISSUE_FIELDS = {
  description: s.string('Description in Markdown; converted to Atlassian Document Format.'),
  parent: s.string('Parent issue key (epic for a story, story for a subtask).'),
  estimate: s.string('Original estimate in Jira notation, e.g. "2h 30m" or "1d".'),
  assignee: s.string('Assignee: account id, email, or "me".'),
  labels: s.strings('Labels.'),
  priority: s.string('Priority name.'),
  components: s.strings('Component names.'),
  fields: s.object('Extra raw Jira fields, e.g. {"customfield_10016": 3}.'),
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'atl_sites',
    title: 'List Atlassian sites',
    description: 'List the Atlassian sites configured in atl, with the default one marked. Use the name as the "site" argument of any other tool.',
    properties: {},
    network: false,
    readOnly: true,
    cli: { path: ['site', 'ls'] },
    run: async (ctx) => ctx.sites.list(),
  },
  {
    name: 'jira_myself',
    title: 'Current Jira user',
    description: 'Return the Jira account behind the credentials of a site.',
    properties: {},
    readOnly: true,
    cli: { path: ['jira', 'myself'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).myself(),
  },
  {
    name: 'jira_projects',
    title: 'List Jira projects',
    description: 'List Jira projects visible to the account, optionally filtered by name or key.',
    properties: { query: s.string('Filter by name or key.') },
    readOnly: true,
    cli: { path: ['jira', 'project', 'ls'], positionals: ['query'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).projects(text(args, 'query')),
  },
  {
    name: 'jira_get_issue',
    title: 'Get a Jira issue',
    description: 'Get a Jira issue with its description as Markdown. Pass fields to limit or "*all" to include every raw field.',
    properties: { key: s.string('Issue key, e.g. PP-123.'), fields: s.strings('Fields to return.'), expand: s.string('Jira expand parameter, e.g. "changelog,renderedFields".'), raw: s.boolean('Include the raw fields object.') },
    required: ['key'],
    readOnly: true,
    cli: { path: ['jira', 'issue', 'get'], positionals: ['key'] },
    run: async (ctx, args) => {
      const fields = list(args, 'fields')
      const expand = text(args, 'expand')
      return (await ctx.jira(site(args))).getIssue(need(args, 'key'), { ...(fields ? { fields } : {}), ...(expand ? { expand } : {}), includeFields: args['raw'] === true || fields?.includes('*all') === true })
    },
  },
  {
    name: 'jira_search',
    title: 'Search Jira with JQL',
    description: 'Search issues with JQL. Returns summaries; use jira_get_issue for full descriptions.',
    properties: { jql: s.string('JQL query.'), limit: s.integer('Maximum issues (default 50).'), fields: s.strings('Fields to fetch.') },
    required: ['jql'],
    readOnly: true,
    cli: { path: ['jira', 'search'], positionals: ['jql'] },
    run: async (ctx, args) => {
      const fields = list(args, 'fields')
      return (await ctx.jira(site(args))).search(need(args, 'jql'), { limit: integer(args, 'limit', 50) ?? 50, ...(fields ? { fields } : {}) })
    },
  },
  {
    name: 'jira_create_issue',
    title: 'Create a Jira issue',
    description: 'Create an issue (epic, story, task, subtask...). Description is Markdown. Use parent for hierarchy and estimate for the original estimate.',
    properties: { project: s.string('Project key or id.'), type: s.string('Issue type name or id, e.g. Story, Subtask.'), summary: s.string('Summary.'), ...ISSUE_FIELDS },
    required: ['project', 'type', 'summary'],
    cli: { path: ['jira', 'issue', 'create'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).createIssue(newIssue(args)),
  },
  {
    name: 'jira_create_issues',
    title: 'Create a Jira hierarchy',
    description:
      'Create several issues in order, wiring parents by reference. Each item takes the jira_create_issue fields plus an optional "ref" and "parentRef" pointing at an earlier item, so an epic, its stories and their subtasks go in one call. Stops at the first failure and reports what was created.',
    properties: {
      project: s.string('Default project key for items that omit it.'),
      issues: {
        type: 'array',
        description: 'Issues to create, parents before children.',
        items: objectSchema({ ref: s.string('Local reference for children.'), parentRef: s.string('ref of an earlier item.'), project: s.string('Project key.'), type: s.string('Issue type.'), summary: s.string('Summary.'), ...ISSUE_FIELDS }, ['type', 'summary']),
      },
    },
    required: ['issues'],
    cli: { path: ['jira', 'issue', 'create-many'] },
    run: async (ctx, args) => {
      const jira = await ctx.jira(site(args))
      const items = Array.isArray(args['issues']) ? (args['issues'] as Record<string, unknown>[]) : []
      const refs = new Map<string, string>()
      const created: Array<{ ref: string | null; key: string; url: string }> = []
      for (const [index, item] of items.entries()) {
        const parentRef = text(item, 'parentRef')
        const parent = parentRef ? refs.get(parentRef) : text(item, 'parent')
        if (parentRef && !parent) throw usageError(`Item ${index} points at parentRef "${parentRef}", which was not created before it.`)
        try {
          const result = await jira.createIssue(newIssue({ ...item, project: text(item, 'project') ?? text(args, 'project'), ...(parent ? { parent } : {}) }))
          const ref = text(item, 'ref') ?? null
          if (ref) refs.set(ref, result.key)
          created.push({ ref, key: result.key, url: result.url })
        } catch (error) {
          return { created, failed: { index, summary: text(item, 'summary'), error: error instanceof Error ? error.message : String(error) } }
        }
      }
      return { created }
    },
  },
  {
    name: 'jira_edit_issue',
    title: 'Edit a Jira issue',
    description: 'Edit an issue. Only the fields passed change. Description is Markdown.',
    properties: { key: s.string('Issue key.'), summary: s.string('New summary.'), type: s.string('New issue type.'), notify: s.boolean('Notify watchers (default true).'), ...ISSUE_FIELDS },
    required: ['key'],
    cli: { path: ['jira', 'issue', 'edit'], positionals: ['key'] },
    run: async (ctx, args) => {
      const { project: _project, type: _type, summary: _summary, ...rest } = newIssue({ ...args, project: 'x', type: text(args, 'type') ?? 'x', summary: text(args, 'summary') ?? 'x' })
      const changes: Partial<NewIssue> = { ...rest }
      const summary = text(args, 'summary')
      if (summary) changes.summary = summary
      const type = text(args, 'type')
      if (type) changes.type = type
      await (await ctx.jira(site(args))).editIssue(need(args, 'key'), changes, args['notify'] !== false)
      return { key: need(args, 'key'), updated: true }
    },
  },
  {
    name: 'jira_delete_issue',
    title: 'Delete a Jira issue',
    description: 'Delete an issue permanently. Set subtasks to delete its subtasks too.',
    properties: { key: s.string('Issue key.'), subtasks: s.boolean('Delete subtasks as well.') },
    required: ['key'],
    destructive: true,
    cli: { path: ['jira', 'issue', 'delete'], positionals: ['key'] },
    run: async (ctx, args) => {
      await (await ctx.jira(site(args))).deleteIssue(need(args, 'key'), args['subtasks'] === true)
      return { key: need(args, 'key'), deleted: true }
    },
  },
  {
    name: 'jira_assign',
    title: 'Assign a Jira issue',
    description: 'Assign an issue to an account id, email or "me"; pass "none" to unassign.',
    properties: { key: s.string('Issue key.'), assignee: s.string('Account id, email, "me" or "none".') },
    required: ['key', 'assignee'],
    cli: { path: ['jira', 'issue', 'assign'], positionals: ['key', 'assignee'] },
    run: async (ctx, args) => {
      const assignee = need(args, 'assignee')
      await (await ctx.jira(site(args))).assign(need(args, 'key'), assignee === 'none' ? null : assignee)
      return { key: need(args, 'key'), assignee }
    },
  },
  {
    name: 'jira_transitions',
    title: 'List Jira transitions',
    description: 'List the transitions available for an issue right now.',
    properties: { key: s.string('Issue key.') },
    required: ['key'],
    readOnly: true,
    cli: { path: ['jira', 'issue', 'transitions'], positionals: ['key'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).transitions(need(args, 'key')),
  },
  {
    name: 'jira_transition',
    title: 'Transition a Jira issue',
    description: 'Move an issue by transition id, transition name or target status name ("done" picks any transition into the done category). Optional Markdown comment.',
    properties: { key: s.string('Issue key.'), to: s.string('Transition id or name, or target status.'), comment: s.string('Comment in Markdown.') },
    required: ['key', 'to'],
    cli: { path: ['jira', 'issue', 'transition'], positionals: ['key', 'to'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).transition(need(args, 'key'), need(args, 'to'), text(args, 'comment')),
  },
  {
    name: 'jira_add_comment',
    title: 'Comment on a Jira issue',
    description: 'Add a Markdown comment to an issue.',
    properties: { key: s.string('Issue key.'), body: s.string('Comment in Markdown.') },
    required: ['key', 'body'],
    cli: { path: ['jira', 'comment', 'add'], positionals: ['key'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).addComment(need(args, 'key'), need(args, 'body')),
  },
  {
    name: 'jira_comments',
    title: 'List Jira comments',
    description: 'List the comments of an issue as Markdown.',
    properties: { key: s.string('Issue key.') },
    required: ['key'],
    readOnly: true,
    cli: { path: ['jira', 'comment', 'ls'], positionals: ['key'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).comments(need(args, 'key')),
  },
  {
    name: 'jira_delete_comment',
    title: 'Delete a Jira comment',
    description: 'Delete one comment from an issue.',
    properties: { key: s.string('Issue key.'), id: s.string('Comment id.') },
    required: ['key', 'id'],
    destructive: true,
    cli: { path: ['jira', 'comment', 'rm'], positionals: ['key', 'id'] },
    run: async (ctx, args) => {
      await (await ctx.jira(site(args))).deleteComment(need(args, 'key'), need(args, 'id'))
      return { key: need(args, 'key'), id: need(args, 'id'), deleted: true }
    },
  },
  {
    name: 'jira_add_worklog',
    title: 'Log work on a Jira issue',
    description: 'Add a worklog: when it started (ISO 8601) and how long (e.g. "1h 30m" or seconds). Optional Markdown comment.',
    properties: {
      key: s.string('Issue key.'),
      started: s.string('Start time, ISO 8601.'),
      timeSpent: s.string('Duration, e.g. "45m", "1h 30m", or seconds.'),
      comment: s.string('Comment in Markdown.'),
      adjustEstimate: s.enum('How to adjust the remaining estimate.', ['auto', 'leave', 'new', 'manual']),
      newEstimate: s.string('Remaining estimate when adjustEstimate is "new".'),
    },
    required: ['key', 'started', 'timeSpent'],
    cli: { path: ['jira', 'worklog', 'add'], positionals: ['key'] },
    run: async (ctx, args) => {
      const comment = text(args, 'comment')
      const adjust = text(args, 'adjustEstimate') as 'auto' | 'leave' | 'new' | 'manual' | undefined
      const newEstimate = text(args, 'newEstimate')
      return (await ctx.jira(site(args))).addWorklog(need(args, 'key'), {
        started: need(args, 'started'),
        timeSpent: typeof args['timeSpent'] === 'number' ? args['timeSpent'] : need(args, 'timeSpent'),
        ...(comment ? { comment } : {}),
        ...(adjust ? { adjustEstimate: adjust } : {}),
        ...(newEstimate ? { newEstimate } : {}),
      })
    },
  },
  {
    name: 'jira_worklogs',
    title: 'List Jira worklogs',
    description: 'List the worklogs of an issue.',
    properties: { key: s.string('Issue key.') },
    required: ['key'],
    readOnly: true,
    cli: { path: ['jira', 'worklog', 'ls'], positionals: ['key'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).worklogs(need(args, 'key')),
  },
  {
    name: 'jira_attach',
    title: 'Attach a file to a Jira issue',
    description: 'Upload a local file as an attachment of an issue.',
    properties: { key: s.string('Issue key.'), file: s.string('Absolute path of the file.') },
    required: ['key', 'file'],
    cli: { path: ['jira', 'attach'], positionals: ['key', 'file'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).attach(need(args, 'key'), need(args, 'file')),
  },
  {
    name: 'jira_link',
    title: 'Link two Jira issues',
    description: 'Create an issue link of a given type (e.g. "Blocks", "Relates") from the inward issue to the outward issue.',
    properties: { type: s.string('Link type name.'), inward: s.string('Inward issue key.'), outward: s.string('Outward issue key.'), comment: s.string('Comment in Markdown.') },
    required: ['type', 'inward', 'outward'],
    cli: { path: ['jira', 'link'], positionals: ['type', 'inward', 'outward'] },
    run: async (ctx, args) => {
      await (await ctx.jira(site(args))).link(need(args, 'type'), need(args, 'inward'), need(args, 'outward'), text(args, 'comment'))
      return { linked: true }
    },
  },
  {
    name: 'jira_link_types',
    title: 'List Jira link types',
    description: 'List the issue link types of the site.',
    properties: {},
    readOnly: true,
    cli: { path: ['jira', 'link-types'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).linkTypes(),
  },
  {
    name: 'jira_remote_link',
    title: 'Add a web link to a Jira issue',
    description: 'Attach an external URL (Confluence page, PR, document) to an issue as a remote link.',
    properties: { key: s.string('Issue key.'), url: s.string('URL.'), title: s.string('Link title.') },
    required: ['key', 'url', 'title'],
    cli: { path: ['jira', 'remote-link'], positionals: ['key', 'url'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).remoteLink(need(args, 'key'), need(args, 'url'), need(args, 'title')),
  },
  {
    name: 'jira_create_meta',
    title: 'Jira create metadata',
    description: 'Without type: the issue types of a project. With type: the fields that type accepts, which are required, and their allowed values.',
    properties: { project: s.string('Project key.'), type: s.string('Issue type name or id.') },
    required: ['project'],
    readOnly: true,
    cli: { path: ['jira', 'createmeta'], positionals: ['project', 'type'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).createMeta(need(args, 'project'), text(args, 'type')),
  },
  {
    name: 'jira_boards',
    title: 'List Jira boards',
    description: 'List Jira Software boards, optionally for one project.',
    properties: { project: s.string('Project key or id.') },
    readOnly: true,
    cli: { path: ['jira', 'board', 'ls'], positionals: ['project'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).boards(text(args, 'project')),
  },
  {
    name: 'jira_sprints',
    title: 'List sprints of a board',
    description: 'List the sprints of a board, optionally by state (future, active, closed).',
    properties: { board: s.integer('Board id.'), state: s.string('Comma-separated states.') },
    required: ['board'],
    readOnly: true,
    cli: { path: ['jira', 'sprint', 'ls'], positionals: ['board'] },
    run: async (ctx, args) => (await ctx.jira(site(args))).sprints(integer(args, 'board') ?? 0, text(args, 'state')),
  },
  {
    name: 'jira_move_to_sprint',
    title: 'Move issues to a sprint',
    description: 'Move issues into a sprint.',
    properties: { sprint: s.integer('Sprint id.'), issues: s.strings('Issue keys.') },
    required: ['sprint', 'issues'],
    cli: { path: ['jira', 'sprint', 'add'], positionals: ['sprint'] },
    run: async (ctx, args) => {
      const issues = list(args, 'issues') ?? []
      await (await ctx.jira(site(args))).moveToSprint(integer(args, 'sprint') ?? 0, issues)
      return { sprint: integer(args, 'sprint'), moved: issues }
    },
  },
  {
    name: 'confluence_spaces',
    title: 'List Confluence spaces',
    description: 'List Confluence spaces, optionally only some keys.',
    properties: { keys: s.strings('Space keys.'), limit: s.integer('Maximum spaces (default 250).') },
    readOnly: true,
    cli: { path: ['confluence', 'space', 'ls'] },
    run: async (ctx, args) => {
      const keys = list(args, 'keys')
      return (await ctx.confluence(site(args))).spaces({ ...(keys ? { keys } : {}), limit: integer(args, 'limit', 250) ?? 250 })
    },
  },
  {
    name: 'confluence_get_page',
    title: 'Get a Confluence page',
    description: 'Get a page with its body as Markdown (default) or raw storage format.',
    properties: { id: s.string('Page id.'), format: s.enum('Body format.', ['markdown', 'storage']) },
    required: ['id'],
    readOnly: true,
    cli: { path: ['confluence', 'page', 'get'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).getPage(need(args, 'id'), format(args)),
  },
  {
    name: 'confluence_find_page',
    title: 'Find a Confluence page by title',
    description: 'Find a page by exact title inside a space.',
    properties: { space: s.string('Space key or id.'), title: s.string('Exact title.') },
    required: ['space', 'title'],
    readOnly: true,
    cli: { path: ['confluence', 'page', 'find'], positionals: ['space', 'title'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).findPageByTitle(need(args, 'space'), need(args, 'title')),
  },
  {
    name: 'confluence_create_page',
    title: 'Create a Confluence page',
    description: 'Create a page from Markdown (default) or storage format, optionally under a parent page.',
    properties: { space: s.string('Space key or id.'), title: s.string('Title.'), body: s.string('Body.'), format: s.enum('Body format.', ['markdown', 'storage']), parentId: s.string('Parent page id.'), draft: s.boolean('Create as draft.') },
    required: ['space', 'title', 'body'],
    cli: { path: ['confluence', 'page', 'create'], positionals: ['space', 'title'] },
    run: async (ctx, args) => {
      const parentId = text(args, 'parentId')
      return (await ctx.confluence(site(args))).createPage({ space: need(args, 'space'), title: need(args, 'title'), body: need(args, 'body'), format: format(args), ...(parentId ? { parentId } : {}), draft: args['draft'] === true })
    },
  },
  {
    name: 'confluence_update_page',
    title: 'Update a Confluence page',
    description: 'Replace the body and/or title of a page. The version is bumped automatically.',
    properties: { id: s.string('Page id.'), title: s.string('New title.'), body: s.string('New body.'), format: s.enum('Body format.', ['markdown', 'storage']), message: s.string('Version message.'), parentId: s.string('Move under this parent.') },
    required: ['id'],
    cli: { path: ['confluence', 'page', 'update'], positionals: ['id'] },
    run: async (ctx, args) => {
      const title = text(args, 'title')
      const body = text(args, 'body')
      const message = text(args, 'message')
      const parentId = text(args, 'parentId')
      return (await ctx.confluence(site(args))).updatePage({ id: need(args, 'id'), format: format(args), ...(title ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(message ? { message } : {}), ...(parentId ? { parentId } : {}) })
    },
  },
  {
    name: 'confluence_upsert_page',
    title: 'Create or update a Confluence page by title',
    description: 'Publish a page: update it if a page with that title exists in the space, otherwise create it.',
    properties: { space: s.string('Space key or id.'), title: s.string('Title.'), body: s.string('Body.'), format: s.enum('Body format.', ['markdown', 'storage']), parentId: s.string('Parent page id for a new page.'), message: s.string('Version message.') },
    required: ['space', 'title', 'body'],
    cli: { path: ['confluence', 'page', 'upsert'], positionals: ['space', 'title'] },
    run: async (ctx, args) => {
      const parentId = text(args, 'parentId')
      const message = text(args, 'message')
      return (await ctx.confluence(site(args))).upsertPage({ space: need(args, 'space'), title: need(args, 'title'), body: need(args, 'body'), format: format(args), ...(parentId ? { parentId } : {}), ...(message ? { message } : {}) })
    },
  },
  {
    name: 'confluence_delete_page',
    title: 'Delete a Confluence page',
    description: 'Move a page to the trash, or purge it from the trash.',
    properties: { id: s.string('Page id.'), purge: s.boolean('Purge a page that is already in the trash.') },
    required: ['id'],
    destructive: true,
    cli: { path: ['confluence', 'page', 'delete'], positionals: ['id'] },
    run: async (ctx, args) => {
      await (await ctx.confluence(site(args))).deletePage(need(args, 'id'), args['purge'] === true)
      return { id: need(args, 'id'), deleted: true }
    },
  },
  {
    name: 'confluence_children',
    title: 'List child pages',
    description: 'List the direct children of a page.',
    properties: { id: s.string('Page id.') },
    required: ['id'],
    readOnly: true,
    cli: { path: ['confluence', 'page', 'children'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).children(need(args, 'id')),
  },
  {
    name: 'confluence_descendants',
    title: 'List the page tree',
    description: 'List every descendant of a page down to a depth.',
    properties: { id: s.string('Page id.'), depth: s.integer('Depth (default 5).') },
    required: ['id'],
    readOnly: true,
    cli: { path: ['confluence', 'page', 'tree'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).descendants(need(args, 'id'), integer(args, 'depth', 5) ?? 5),
  },
  {
    name: 'confluence_search',
    title: 'Search Confluence with CQL',
    description: 'Search content with CQL, e.g. space = DOC AND title ~ "deploy".',
    properties: { cql: s.string('CQL query.'), limit: s.integer('Maximum results (default 25).') },
    required: ['cql'],
    readOnly: true,
    cli: { path: ['confluence', 'search'], positionals: ['cql'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).search(need(args, 'cql'), integer(args, 'limit', 25) ?? 25),
  },
  {
    name: 'confluence_attach',
    title: 'Attach a file to a Confluence page',
    description: 'Upload or replace an attachment on a page.',
    properties: { id: s.string('Page id.'), file: s.string('Absolute path of the file.'), comment: s.string('Attachment comment.') },
    required: ['id', 'file'],
    cli: { path: ['confluence', 'attach'], positionals: ['id', 'file'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).attach(need(args, 'id'), need(args, 'file'), text(args, 'comment')),
  },
  {
    name: 'confluence_attachments',
    title: 'List page attachments',
    description: 'List the attachments of a page.',
    properties: { id: s.string('Page id.') },
    required: ['id'],
    readOnly: true,
    cli: { path: ['confluence', 'attachment', 'ls'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).attachments(need(args, 'id')),
  },
  {
    name: 'confluence_add_comment',
    title: 'Comment on a Confluence page',
    description: 'Add a footer comment in Markdown (default) or storage format.',
    properties: { id: s.string('Page id.'), body: s.string('Comment.'), format: s.enum('Body format.', ['markdown', 'storage']) },
    required: ['id', 'body'],
    cli: { path: ['confluence', 'comment', 'add'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).addFooterComment(need(args, 'id'), need(args, 'body'), format(args)),
  },
  {
    name: 'confluence_comments',
    title: 'List Confluence comments',
    description: 'List the footer comments of a page as Markdown.',
    properties: { id: s.string('Page id.') },
    required: ['id'],
    readOnly: true,
    cli: { path: ['confluence', 'comment', 'ls'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).footerComments(need(args, 'id')),
  },
  {
    name: 'confluence_labels',
    title: 'List page labels',
    description: 'List the labels of a page.',
    properties: { id: s.string('Page id.') },
    required: ['id'],
    readOnly: true,
    cli: { path: ['confluence', 'label', 'ls'], positionals: ['id'] },
    run: async (ctx, args) => (await ctx.confluence(site(args))).labels(need(args, 'id')),
  },
  {
    name: 'confluence_add_labels',
    title: 'Label a Confluence page',
    description: 'Add labels to a page.',
    properties: { id: s.string('Page id.'), labels: s.strings('Labels.') },
    required: ['id', 'labels'],
    cli: { path: ['confluence', 'label', 'add'], positionals: ['id'] },
    run: async (ctx, args) => {
      const labels = list(args, 'labels') ?? []
      await (await ctx.confluence(site(args))).addLabels(need(args, 'id'), labels)
      return { id: need(args, 'id'), labels }
    },
  },
  {
    name: 'convert_markdown',
    title: 'Convert Markdown',
    description: 'Convert Markdown to Atlassian Document Format (Jira) or Confluence storage format, without calling any site.',
    properties: { markdown: s.string('Markdown.'), to: s.enum('Target format.', ['adf', 'storage']) },
    required: ['markdown', 'to'],
    network: false,
    readOnly: true,
    cli: { path: ['convert', 'from-markdown'], positionals: ['to'] },
    run: async (_ctx, args) => (need(args, 'to') === 'adf' ? markdownToAdf(need(args, 'markdown')) : { storage: markdownToStorage(need(args, 'markdown')) }),
  },
  {
    name: 'convert_to_markdown',
    title: 'Convert to Markdown',
    description: 'Convert Atlassian Document Format (JSON) or Confluence storage format to Markdown.',
    properties: { content: s.string('ADF JSON or storage XHTML.'), from: s.enum('Source format.', ['adf', 'storage']) },
    required: ['content', 'from'],
    network: false,
    readOnly: true,
    cli: { path: ['convert', 'to-markdown'], positionals: ['from'] },
    run: async (_ctx, args) => ({ markdown: need(args, 'from') === 'adf' ? adfToMarkdown(JSON.parse(need(args, 'content')) as unknown) : storageToMarkdown(need(args, 'content')) }),
  },
  {
    name: 'api_search',
    title: 'Search the Atlassian REST API',
    description: `Search every operation of the Jira, Jira Software (agile) and Confluence REST APIs (${PRODUCTS.join(', ')}) by words. Use it when no other tool covers the task, then api_describe and api_call.`,
    properties: { query: s.string('Words to look for, e.g. "version release" or "page restrictions".'), product: s.enum('Limit to one product.', PRODUCTS), tag: s.string('Limit to one tag.'), method: s.string('HTTP method.'), limit: s.integer('Maximum results (default 20).') },
    required: ['query'],
    network: false,
    readOnly: true,
    cli: { path: ['api', 'search'], positionals: ['query'] },
    run: async (_ctx, args) => {
      const product = text(args, 'product')
      if (product && !isProduct(product)) throw usageError(`Unknown product "${product}". Products: ${PRODUCTS.join(', ')}.`)
      const tag = text(args, 'tag')
      const method = text(args, 'method')
      return searchOperations(need(args, 'query'), { ...(product ? { products: [product as Product] } : {}), ...(tag ? { tag } : {}), ...(method ? { method } : {}), limit: integer(args, 'limit', 20) ?? 20 }).map((operation) => ({
        id: operation.id,
        method: operation.method,
        path: operation.path,
        summary: operation.summary,
      }))
    },
  },
  {
    name: 'api_describe',
    title: 'Describe a REST operation',
    description: 'Show the parameters and body schema of an operation found with api_search.',
    properties: { operation: s.string('Operation id, e.g. jira.createVersion.'), depth: s.integer('How deep to expand nested schemas (default 3).') },
    required: ['operation'],
    network: false,
    readOnly: true,
    cli: { path: ['api', 'describe'], positionals: ['operation'] },
    run: async (_ctx, args) => describeOperation(findOperation(need(args, 'operation')), integer(args, 'depth', 3) ?? 3),
  },
  {
    name: 'api_call',
    title: 'Call a REST operation',
    description: 'Call any Jira, Jira Software or Confluence REST operation by id. Path and query parameters go by name in "args"; the JSON body goes in args.body; uploads take args.file.',
    properties: { operation: s.string('Operation id.'), args: s.object('Arguments as described by api_describe.') },
    required: ['operation'],
    cli: { path: ['api', 'call'], positionals: ['operation'] },
    run: async (ctx, args) => {
      const operation = findOperation(need(args, 'operation'))
      const input = typeof args['args'] === 'object' && args['args'] !== null ? (args['args'] as Record<string, unknown>) : {}
      return callOperation(await ctx.client(site(args)), operation, input)
    },
  },
  {
    name: 'api_catalog',
    title: 'REST catalog summary',
    description: 'How many REST operations atl knows per product and when the catalog was generated.',
    properties: {},
    network: false,
    readOnly: true,
    cli: { path: ['api', 'catalog'] },
    run: async () => catalogStats(),
  },
]

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

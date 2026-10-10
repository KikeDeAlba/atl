import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AtlassianClient } from '../src/http/client.ts'
import { AtlError } from '../src/errors.ts'
import { parseDuration } from '../src/jira/service.ts'
import { fakeAtlassian, sandboxContext } from './helpers.ts'

test('the client retries 429 and maps auth and not-found errors', async (t) => {
  let calls = 0
  const fake = await fakeAtlassian(t, (request) => {
    if (request.path === '/flaky') {
      calls += 1
      return calls < 3 ? { status: 429, headers: { 'Retry-After': '0' }, body: {} } : { body: { ok: true } }
    }
    if (request.path === '/denied') return { status: 401, body: { message: 'bad token' } }
    if (request.path === '/broken') return { status: 400, body: { errorMessages: ['Field x is required'], errors: { summary: 'too long' } } }
    return undefined
  })
  const client = new AtlassianClient({ site: { name: 'fake', url: fake.url, email: 'me@x.com' }, token: 'secret' })
  assert.deepEqual(await client.get('/flaky'), { ok: true })
  assert.equal(calls, 3)
  assert.equal(fake.requests[0]?.headers.authorization, `Basic ${Buffer.from('me@x.com:secret').toString('base64')}`)
  await assert.rejects(client.get('/denied'), (error: unknown) => error instanceof AtlError && error.code === 'AUTH' && error.exitCode === 5)
  await assert.rejects(client.get('/missing'), (error: unknown) => error instanceof AtlError && error.code === 'NOT_FOUND')
  await assert.rejects(client.get('/broken'), (error: unknown) => error instanceof AtlError && /Field x is required; summary: too long/.test(error.message))
})

test('durations accept Jira notation', () => {
  assert.equal(parseDuration('1h 30m'), 5400)
  assert.equal(parseDuration('2d'), 57600)
  assert.equal(parseDuration('45'), 45)
  assert.throws(() => parseDuration('soon'))
})

test('jira issues are created with ADF, estimates and a hierarchy', async (t) => {
  let next = 100
  const fake = await fakeAtlassian(t, (request) => {
    if (request.method === 'POST' && request.path === '/rest/api/3/issue') {
      next += 1
      return { status: 201, body: { id: String(next), key: `PP-${next}` } }
    }
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'acc-1', displayName: 'Me' } }
    return undefined
  })
  const { ctx } = await sandboxContext(t, fake.url)
  const { TOOLS } = await import('../src/tools/definitions.ts')
  const createMany = TOOLS.find((tool) => tool.name === 'jira_create_issues')!
  const result = (await createMany.run(ctx, {
    project: 'PP',
    issues: [
      { ref: 'epic', type: 'Epic', summary: 'Epic' },
      { ref: 'story', parentRef: 'epic', type: 'Story', summary: 'Story', description: '## Goal\n\n- **one**', estimate: '2h', assignee: 'me' },
      { parentRef: 'story', type: 'Subtask', summary: 'Sub', labels: 'a,b' },
    ],
  })) as { created: Array<{ key: string }> }
  assert.deepEqual(result.created.map((item) => item.key), ['PP-101', 'PP-102', 'PP-103'])
  const posts = fake.requests.filter((request) => request.method === 'POST')
  const story = (posts[1]?.body as { fields: Record<string, unknown> }).fields
  assert.deepEqual(story['parent'], { key: 'PP-101' })
  assert.deepEqual(story['timetracking'], { originalEstimate: '2h' })
  assert.deepEqual(story['assignee'], { accountId: 'acc-1' })
  assert.equal((story['description'] as { type: string }).type, 'doc')
  const sub = (posts[2]?.body as { fields: Record<string, unknown> }).fields
  assert.deepEqual(sub['parent'], { key: 'PP-102' })
  assert.deepEqual(sub['labels'], ['a', 'b'])
})

test('transitions resolve by name, target status or the done category', async (t) => {
  const fake = await fakeAtlassian(t, (request) => {
    if (request.path === '/rest/api/3/issue/PP-1/transitions' && request.method === 'GET') {
      return { body: { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }, { id: '31', name: 'Finish', to: { name: 'Listo', statusCategory: { key: 'done' } } }] } }
    }
    if (request.path === '/rest/api/3/issue/PP-1/transitions' && request.method === 'POST') return { status: 204 }
    return undefined
  })
  const { ctx } = await sandboxContext(t, fake.url)
  const jira = await ctx.jira()
  assert.equal((await jira.transition('PP-1', 'done')).id, '31')
  assert.equal((await jira.transition('PP-1', 'in progress')).id, '11')
  await assert.rejects(jira.transition('PP-1', 'Closed'), (error: unknown) => error instanceof AtlError && error.code === 'TRANSITION_NOT_AVAILABLE')
})

test('jira search follows nextPageToken', async (t) => {
  const fake = await fakeAtlassian(t, (request) => {
    if (request.path !== '/rest/api/3/search/jql') return undefined
    const token = (request.body as { nextPageToken?: string }).nextPageToken
    if (!token) return { body: { issues: [{ id: '1', key: 'A-1', fields: { summary: 'one' } }], nextPageToken: 'p2' } }
    return { body: { issues: [{ id: '2', key: 'A-2', fields: { summary: 'two' } }] } }
  })
  const { ctx } = await sandboxContext(t, fake.url)
  const issues = await (await ctx.jira()).search('project = A')
  assert.deepEqual(issues.map((issue) => issue.key), ['A-1', 'A-2'])
})

test('confluence upsert creates once and then bumps the version', async (t) => {
  let exists = false
  const fake = await fakeAtlassian(t, (request) => {
    if (request.path === '/wiki/api/v2/spaces') return { body: { results: [{ id: '77', key: 'DOC', name: 'Docs' }] } }
    if (request.path === '/wiki/api/v2/pages' && request.method === 'GET') return { body: { results: exists ? [{ id: '5', title: 'Deploy', version: { number: 3 } }] : [] } }
    if (request.path === '/wiki/api/v2/pages' && request.method === 'POST') {
      exists = true
      return { body: { id: '5', title: 'Deploy', version: { number: 1 }, _links: { webui: '/spaces/DOC/pages/5', base: `${fake.url}/wiki` } } }
    }
    if (request.path === '/wiki/api/v2/pages/5' && request.method === 'GET') return { body: { id: '5', title: 'Deploy', version: { number: 3 } } }
    if (request.path === '/wiki/api/v2/pages/5' && request.method === 'PUT') return { body: { id: '5', title: 'Deploy', version: { number: 4 } } }
    return undefined
  })
  const { ctx } = await sandboxContext(t, fake.url)
  const confluence = await ctx.confluence()
  const created = await confluence.upsertPage({ space: 'DOC', title: 'Deploy', body: '# Steps\n\n1. build' })
  assert.equal(created.created, true)
  const post = fake.requests.find((request) => request.method === 'POST')
  assert.equal((post?.body as { spaceId: string }).spaceId, '77')
  assert.match((post?.body as { body: { value: string } }).body.value, /<h1>Steps<\/h1>/)
  const updated = await confluence.upsertPage({ space: 'DOC', title: 'Deploy', body: 'new', message: 'sync' })
  assert.equal(updated.created, false)
  const put = fake.requests.find((request) => request.method === 'PUT')
  assert.deepEqual((put?.body as { version: unknown }).version, { number: 4, message: 'sync' })
})

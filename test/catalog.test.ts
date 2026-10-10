import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRequest, callOperation, catalogStats, describeOperation, findOperation, inputSchema, searchOperations } from '../src/api/catalog.ts'
import { AtlError } from '../src/errors.ts'
import { fakeAtlassian, sandboxContext } from './helpers.ts'

test('the catalog covers the four REST APIs', () => {
  const stats = catalogStats()
  assert.deepEqual(stats.map((entry) => entry.product), ['jira', 'agile', 'confluence', 'confluence-v1'])
  assert.ok(stats.reduce((sum, entry) => sum + entry.operations, 0) > 1000)
})

test('operations are found by id, bare id or words', () => {
  assert.equal(findOperation('jira.createIssue').path, '/rest/api/3/issue')
  assert.equal(findOperation('getBoard').id, 'agile.getBoard')
  assert.equal(findOperation('confluence.getPageById').path, '/wiki/api/v2/pages/{id}')
  assert.throws(() => findOperation('nope.nothing'), (error: unknown) => error instanceof AtlError && error.code === 'OPERATION_NOT_FOUND')
  const hits = searchOperations('sprint issues', { products: ['agile'], limit: 5 })
  assert.ok(hits.length > 0 && hits.every((operation) => operation.id.startsWith('agile.')))
})

test('input schemas resolve references and requests substitute the path', () => {
  const operation = findOperation('jira.addWorklog')
  const schema = inputSchema(operation) as { properties: Record<string, { type?: string }>; required: string[] }
  assert.ok(schema.required.includes('issueIdOrKey'))
  assert.equal(schema.properties['body']?.type, 'object')
  const described = describeOperation(operation) as { method: string }
  assert.equal(described.method, 'POST')
  const request = buildRequest(operation, { issueIdOrKey: 'PP 1', notifyUsers: false, body: { timeSpentSeconds: 60 } })
  assert.equal(request.path, '/rest/api/3/issue/PP%201/worklog')
  assert.equal(request.query['notifyUsers'], false)
  assert.throws(() => buildRequest(operation, {}), /needs: issueIdOrKey/)
  assert.throws(() => buildRequest(operation, { issueIdOrKey: 'X', body: {}, nonsense: 1 }), /does not take: nonsense/)
})

test('api calls go through the site client', async (t) => {
  const fake = await fakeAtlassian(t, (request) => (request.path === '/rest/agile/1.0/board/7' ? { body: { id: 7, name: 'Team' } } : undefined))
  const { ctx } = await sandboxContext(t, fake.url)
  const result = await callOperation(await ctx.client(), findOperation('agile.getBoard'), { boardId: 7 })
  assert.deepEqual(result, { id: 7, name: 'Team' })
})

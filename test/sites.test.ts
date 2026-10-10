import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileStore } from '@kikedealba/kit/credentials'
import { SiteRegistry, normalizeSiteUrl, defaultSiteName } from '../src/core/sites.ts'
import { importFromBita } from '../src/core/import.ts'
import { AtlError } from '../src/errors.ts'
import { tempDir } from './helpers.ts'
import { writeFile } from 'node:fs/promises'

test('site URLs normalize to the bare origin', () => {
  assert.equal(normalizeSiteUrl('gruposti'), 'https://gruposti.atlassian.net')
  assert.equal(normalizeSiteUrl('https://gruposti.atlassian.net/wiki/'), 'https://gruposti.atlassian.net')
  assert.equal(normalizeSiteUrl('acme.atlassian.net'), 'https://acme.atlassian.net')
  assert.equal(normalizeSiteUrl('http://evil.com'), null)
  assert.equal(normalizeSiteUrl('https://x.atlassian.net/browse/PP-1'), null)
  assert.equal(defaultSiteName('https://gruposti.atlassian.net'), 'gruposti')
})

test('several sites live side by side with their own tokens', async (t) => {
  const dir = await tempDir(t)
  const store = fileStore(path.join(dir, 'creds.json'))
  const registry = new SiteRegistry({ configFile: path.join(dir, 'config.json'), env: {}, store })

  await assert.rejects(registry.resolve(), (error: unknown) => error instanceof AtlError && error.code === 'LOGIN_REQUIRED')

  const first = await registry.add({ url: 'gruposti', email: 'a@x.com', token: 't1' })
  assert.equal(first.default, true)
  await registry.add({ url: 'https://acme.atlassian.net', email: 'b@y.com', token: 't2', name: 'acme' })

  assert.equal((await registry.resolve()).name, 'gruposti')
  assert.equal((await registry.credentials('acme')).token, 't2')
  assert.equal((await registry.credentials('https://gruposti.atlassian.net')).token, 't1')

  await registry.setDefault('acme')
  assert.equal((await registry.resolve()).name, 'acme')
  const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(saved.sites.map((site: { name: string; default?: boolean }) => [site.name, site.default ?? false]), [['gruposti', false], ['acme', true]])

  await registry.remove('acme')
  assert.equal((await registry.resolve()).name, 'gruposti')
  assert.equal(await store.get('atl', 'https://acme.atlassian.net|b@y.com'), null)
  await assert.rejects(registry.resolve('acme'), (error: unknown) => error instanceof AtlError && error.code === 'SITE_NOT_FOUND')
})

test('environment credentials work without any configuration', async (t) => {
  const dir = await tempDir(t)
  const registry = new SiteRegistry({
    configFile: path.join(dir, 'config.json'),
    env: { ATL_SITE_URL: 'https://ci.atlassian.net', ATL_EMAIL: 'bot@x.com', ATL_TOKEN: 'from-env' },
    store: fileStore(path.join(dir, 'creds.json')),
  })
  const credentials = await registry.credentials()
  assert.equal(credentials.site.url, 'https://ci.atlassian.net')
  assert.equal(credentials.token, 'from-env')
})

test('imports bita sites and their tokens', async (t) => {
  const dir = await tempDir(t)
  const store = fileStore(path.join(dir, 'creds.json'))
  await store.set('bita-atlassian', 'https://gruposti.atlassian.net|me@x.com', 'tok-1')
  await store.set('bita-atlassian', 'other@x.com', 'tok-legacy')
  const bitaConfig = path.join(dir, 'bita.json')
  await writeFile(
    bitaConfig,
    JSON.stringify({ atlassian: { sites: [{ site: 'https://gruposti.atlassian.net', email: 'me@x.com' }, { site: 'https://acme.atlassian.net', email: 'other@x.com' }, { site: 'https://nope.atlassian.net', email: 'z@x.com' }] } }),
  )
  const registry = new SiteRegistry({ configFile: path.join(dir, 'config.json'), env: {}, store })
  const outcomes = await importFromBita(registry, { configFile: bitaConfig, store })
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['imported', 'imported', 'no-token'])
  assert.equal((await registry.credentials('acme')).token, 'tok-legacy')
})

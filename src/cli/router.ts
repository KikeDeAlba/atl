import { randomBytes } from 'node:crypto'
import { agents } from '@kikedealba/kit'
import { errorEnvelope, successEnvelope, writeJson } from '@kikedealba/kit/envelope'
import { AtlError, EXIT, usageError } from '../errors.ts'
import { readConfig, writeConfig, configPath } from '../core/config.ts'
import { SiteRegistry } from '../core/sites.ts'
import { importFromBita } from '../core/import.ts'
import { ToolContext } from '../tools/context.ts'
import { TOOLS, findTool, toolInputSchema, type ToolDefinition } from '../tools/definitions.ts'
import type { Schema } from '../tools/schema.ts'
import { CAPABILITIES, installedBin, register, setupAgents, uninstallAgents, unregister, type McpMode } from '../setup.ts'
import { SCHEMA_VERSION, VERSION } from '../version.ts'
import { argsFromSchema, kebab, parseArgv, type ParsedArgs } from './args.ts'
import { readSecret } from './prompt.ts'

interface Io {
  json: boolean
  command: string
}

function out(io: Io, data: unknown, human?: () => string): void {
  if (io.json) writeJson(successEnvelope(SCHEMA_VERSION, io.command, data))
  else process.stdout.write(`${human ? human() : typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`)
}

function flag(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.flags.get(name)
  return values ? values[values.length - 1] : undefined
}

function has(parsed: ParsedArgs, name: string): boolean {
  return parsed.booleans.has(name) || parsed.flags.get(name)?.[0] === 'true'
}

function booleanNames(properties: Record<string, Schema>): Set<string> {
  return new Set(Object.entries(properties).filter(([, schema]) => schema['type'] === 'boolean').map(([name]) => kebab(name)))
}

function matchTool(words: readonly string[]): { tool: ToolDefinition; rest: string[] } | null {
  let best: { tool: ToolDefinition; rest: string[] } | null = null
  for (const tool of TOOLS) {
    const route = tool.cli.path
    if (route.length > words.length) continue
    if (!route.every((word, index) => words[index] === word)) continue
    if (!best || route.length > best.tool.cli.path.length) best = { tool, rest: words.slice(route.length) }
  }
  return best
}

function toolHelp(tool: ToolDefinition): string {
  const properties = (toolInputSchema(tool)['properties'] ?? {}) as Record<string, Schema>
  const positionals = tool.cli.positionals ?? []
  const required = new Set(tool.required ?? [])
  const lines = [`atl ${tool.cli.path.join(' ')}${positionals.map((name) => (required.has(name) ? ` <${name}>` : ` [${name}]`)).join('')}`, '', tool.description, '']
  const list = tool.cli.list
  for (const [name, schema] of Object.entries(properties)) {
    if (positionals.includes(name)) continue
    if (list && (name === 'fields' || name === 'limit')) continue
    const type = schema['type'] === 'boolean' ? '' : ` <${String(schema['type'] ?? 'value')}>`
    lines.push(`  --${kebab(name)}${type}${required.has(name) ? ' (required)' : ''}  ${String(schema['description'] ?? '')}`)
  }
  if (list) {
    lines.push(`  --fields <a,b,c|all>  Keys to keep in each result (default: ${list.compact ? list.compact.join(',') : 'all'}).`)
    lines.push(`  --limit <integer>  ${String(properties['limit']?.['description'] ?? 'Maximum results.')}`)
  }
  lines.push('', 'String values accept @file, and @- reads stdin. Arrays take comma-separated values or JSON.', `MCP tool: ${tool.name}`)
  return lines.join('\n')
}

function help(): string {
  const groups = new Map<string, ToolDefinition[]>()
  for (const tool of TOOLS) {
    const group = tool.cli.path[0] ?? 'other'
    groups.set(group, [...(groups.get(group) ?? []), tool])
  }
  const lines = [
    `atl ${VERSION} — Jira, Jira Software and Confluence Cloud from the terminal and over MCP`,
    '',
    'Sites:',
    '  atl site add <url> --email <email> [--name n] [--default] [--token-stdin]',
    '  atl site ls | test [site] | rm <site> | default <site> | import --from-bita',
    '',
    'MCP server:',
    '  atl mcp [--all-operations] [--read-only]              stdio, one client',
    '  atl mcp serve [--port 7781] [--host 127.0.0.1] [--no-token] [--all-operations] [--read-only]',
    '                                                         HTTP, many clients at once',
    '  atl mcp token [--rotate]',
    '',
    'Setup:',
    '  atl setup [--agents detected|all|claude,opencode,codex,gemini,claude-desktop] [--mcp none|stdio|http] [--no-desktop]',
    '                                                         default: skill + CLI in coding agents, MCP in Claude Desktop',
    '                                                         --mcp applies to coding agents only; restart Claude Desktop after setup',
    '  atl uninstall',
    '',
  ]
  for (const [group, tools] of groups) {
    if (group === 'site') continue
    lines.push(`${group[0]?.toUpperCase()}${group.slice(1)}:`)
    for (const tool of tools) lines.push(`  atl ${[...tool.cli.path, ...(tool.cli.positionals ?? []).map((name) => ((tool.required ?? []).includes(name) ? `<${name}>` : `[${name}]`))].join(' ').padEnd(48)} ${tool.title}`)
    lines.push('')
  }
  lines.push('Every command takes --site <name|url> and --json. List commands take --limit <n> and --fields <a,b,c|all>', 'and return compact objects unless --fields asks for more. "atl <command> --help" lists its options.')
  return lines.join('\n')
}

async function runTool(io: Io, tool: ToolDefinition, argv: readonly string[], ctx: ToolContext): Promise<number> {
  const properties = (toolInputSchema(tool)['properties'] ?? {}) as Record<string, Schema>
  const parsed = parseArgv(argv, booleanNames(properties))
  if (parsed.booleans.has('help')) {
    process.stdout.write(`${toolHelp(tool)}\n`)
    return EXIT.ok
  }
  const shape = tool.cli.list ? listShape(tool, parsed, properties) : null
  const args = argsFromSchema(parsed, properties, tool.cli.positionals ?? [])
  if (shape) Object.assign(args, shape.args)
  const missing = (tool.required ?? []).filter((name) => args[name] === undefined)
  if (missing.length > 0) throw usageError(`Missing ${missing.map((name) => (tool.cli.positionals?.includes(name) ? `<${name}>` : `--${kebab(name)}`)).join(', ')}.`, `See "atl ${tool.cli.path.join(' ')} --help".`)
  const data = await tool.run(ctx, args)
  if (shape) checkProjection(data, shape.fields)
  out(io, shape ? project(data, shape.fields, shape.limit) : data)
  return EXIT.ok
}

interface ListShape {
  fields: string[] | null
  limit: number | null
  args: Record<string, unknown>
}

function listShape(tool: ToolDefinition, parsed: ParsedArgs, properties: Record<string, Schema>): ListShape {
  const list = tool.cli.list ?? {}
  if (parsed.booleans.has('fields')) throw usageError('--fields needs a comma-separated list of keys, or "all".')
  if (parsed.booleans.has('limit')) throw usageError('--limit needs a number.')
  const rawFields = flag(parsed, 'fields')
  const rawLimit = flag(parsed, 'limit')
  parsed.flags.delete('fields')
  parsed.flags.delete('limit')
  const args: Record<string, unknown> = {}
  let limit: number | null = null
  if (rawLimit !== undefined) {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1) throw usageError(`--limit expects a positive integer, got "${rawLimit}".`)
    if (properties['limit']) args['limit'] = limit
  }
  const requested = rawFields === undefined ? null : rawFields.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  if (requested !== null && requested.length === 0) throw usageError('--fields needs a comma-separated list of keys, or "all".')
  const fields = requested === null ? (list.compact ?? null) : requested.length === 1 && (requested[0] === 'all' || requested[0] === '*') ? null : requested
  if (list.fetch && properties['fields']) {
    const known = new Set(['id', 'key', 'url', ...Object.keys(list.fetch)])
    const unknown = (fields ?? []).filter((name) => !known.has(name))
    if (unknown.length > 0) throw usageError(`Unknown key${unknown.length > 1 ? 's' : ''} for --fields: ${unknown.join(', ')}.`, `Keys: ${[...known].join(', ')}, or "all".`)
    const fetch = [...new Set((fields ?? Object.keys(list.fetch)).flatMap((name) => list.fetch?.[name] ?? []))]
    args['fields'] = fetch.length > 0 ? fetch : ['summary']
  }
  return { fields, limit, args }
}

function checkProjection(data: unknown, fields: readonly string[] | null): void {
  if (!fields || !Array.isArray(data)) return
  const records = data.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
  if (records.length === 0) return
  const present = new Set(records.flatMap((record) => Object.keys(record)))
  const unknown = fields.filter((name) => !present.has(name))
  if (unknown.length > 0) throw usageError(`Unknown key${unknown.length > 1 ? 's' : ''} for --fields: ${unknown.join(', ')}.`, `Keys: ${[...present].join(', ')}, or "all".`)
}

export function project(data: unknown, fields: readonly string[] | null, limit: number | null): unknown {
  if (!Array.isArray(data)) return data
  const limited = limit === null ? data : data.slice(0, limit)
  if (!fields) return limited
  return limited.map((item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(fields.filter((name) => name in record).map((name) => [name, record[name]]))
  })
}

async function siteCommand(io: Io, words: string[], argv: readonly string[], ctx: ToolContext): Promise<number | null> {
  const sub = words[1]
  const parsed = parseArgv(argv, new Set(['default', 'token-stdin', 'from-bita']))
  const registry = ctx.sites
  if (sub === 'add') {
    const url = parsed.positionals[0] ?? flag(parsed, 'site')
    const email = flag(parsed, 'email')
    if (!url || !email) throw usageError('Usage: atl site add <url> --email <email> [--name n] [--default] [--token-stdin]')
    const token = has(parsed, 'token-stdin') || !process.stdin.isTTY ? (await readSecret('')).trim() : await readSecret(`API token for ${email} (https://id.atlassian.com/manage-profile/security/api-tokens): `)
    if (!token) throw usageError('The API token is empty.')
    const name = flag(parsed, 'name')
    const site = await registry.add({ url, email, token, ...(name ? { name } : {}), makeDefault: has(parsed, 'default') })
    const check = await testSite(ctx, site.name)
    out(io, { site, check }, () => `${site.name} saved (${site.url})${site.default ? ' [default]' : ''}\n${describeCheck(check)}`)
    return check.jira.ok || check.confluence.ok ? EXIT.ok : EXIT.auth
  }
  if (sub === 'test') {
    const check = await testSite(ctx, parsed.positionals[0] ?? null)
    out(io, check, () => describeCheck(check))
    return check.jira.ok || check.confluence.ok ? EXIT.ok : EXIT.auth
  }
  if (sub === 'rm' || sub === 'remove') {
    const ref = parsed.positionals[0]
    if (!ref) throw usageError('Usage: atl site rm <site>')
    const site = await registry.remove(ref)
    out(io, { removed: site }, () => `${site.name} removed`)
    return EXIT.ok
  }
  if (sub === 'default') {
    const ref = parsed.positionals[0]
    if (!ref) throw usageError('Usage: atl site default <site>')
    const site = await registry.setDefault(ref)
    out(io, site, () => `${site.name} is now the default site`)
    return EXIT.ok
  }
  if (sub === 'import') {
    if (!has(parsed, 'from-bita')) throw usageError('Usage: atl site import --from-bita')
    const outcomes = await importFromBita(registry)
    out(io, outcomes, () => (outcomes.length === 0 ? 'bita has no Atlassian sites to import' : outcomes.map((item) => `${item.state === 'imported' ? '-' : '!'} ${item.url} (${item.email}): ${item.state}`).join('\n')))
    return EXIT.ok
  }
  return null
}

interface SiteCheck {
  site: string
  jira: { ok: boolean; detail: string }
  confluence: { ok: boolean; detail: string }
}

async function testSite(ctx: ToolContext, ref: string | null): Promise<SiteCheck> {
  const site = await ctx.sites.resolve(ref)
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const jira = await ctx.jira(site.name).then((service) => service.myself()).then((me) => ({ ok: true, detail: `Jira: ${me.displayName}` }), (error: unknown) => ({ ok: false, detail: `Jira: ${reason(error)}` }))
  const confluence = await ctx.confluence(site.name).then((service) => service.currentUser()).then((me) => ({ ok: true, detail: `Confluence: ${me.displayName}` }), (error: unknown) => ({ ok: false, detail: `Confluence: ${reason(error)}` }))
  return { site: site.name, jira, confluence }
}

function describeCheck(check: SiteCheck): string {
  return [`${check.jira.ok ? '-' : '!'} ${check.jira.detail}`, `${check.confluence.ok ? '-' : '!'} ${check.confluence.detail}`].join('\n')
}

async function ensureToken(rotate: boolean): Promise<string> {
  const config = await readConfig()
  if (config.mcp?.token && !rotate) return config.mcp.token
  const token = randomBytes(24).toString('base64url')
  await writeConfig({ ...config, mcp: { ...config.mcp, token } })
  return token
}

async function mcpCommand(io: Io, words: string[], argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv, new Set(['all-operations', 'read-only', 'no-token', 'rotate']))
  const options = { allOperations: has(parsed, 'all-operations'), readOnly: has(parsed, 'read-only') }
  const { runHttp, runStdio } = await import('../mcp/server.ts')
  if (words[1] === undefined) {
    await runStdio(options)
    return new Promise<number>(() => undefined)
  }
  if (words[1] === 'token') {
    const token = await ensureToken(has(parsed, 'rotate'))
    out(io, { token }, () => token)
    return EXIT.ok
  }
  if (words[1] === 'serve') {
    const config = await readConfig()
    const port = Number(flag(parsed, 'port') ?? config.mcp?.port ?? 7781)
    const host = flag(parsed, 'host') ?? '127.0.0.1'
    const token = has(parsed, 'no-token') ? null : await ensureToken(false)
    if (host !== '127.0.0.1' && host !== 'localhost' && !token) throw usageError('Listening beyond localhost requires a token; drop --no-token.')
    const running = await runHttp({ ...options, host, port, token, log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) })
    if (config.mcp?.port !== port) await writeConfig({ ...config, mcp: { ...config.mcp, port, ...(token ? { token } : {}) } })
    await register(running.url)
    out(io, { url: running.url, auth: token ? 'bearer' : 'none' }, () => `atl MCP listening on ${running.url}${token ? '\nAuthorization: Bearer <atl mcp token>' : ''}`)
    const stop = async () => {
      await running.close()
      process.exit(0)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return new Promise<number>(() => undefined)
  }
  throw usageError(`Unknown mcp command "${words[1]}".`)
}

async function setupCommand(io: Io, argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv, new Set(['no-agents', 'no-desktop']))
  const mode = (flag(parsed, 'mcp') ?? 'none') as McpMode
  if (!['stdio', 'http', 'none'].includes(mode)) throw usageError('--mcp must be stdio, http or none.')
  const agentsFlag = flag(parsed, 'agents') ?? 'detected'
  const names = agentsFlag.split(',').filter((name) => name.length > 0)
  const unknown = names.filter((name) => !(agents.AGENTS as readonly string[]).includes(name))
  if (agentsFlag !== 'all' && agentsFlag !== 'detected' && (names.length === 0 || unknown.length > 0)) throw usageError(`--agents takes detected, all or a list of ${agents.AGENTS.join(', ')}${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}.`)
  const selection = agentsFlag === 'all' || agentsFlag === 'detected' ? agentsFlag : (names as agents.AgentName[])
  const config = await readConfig()
  const port = config.mcp?.port ?? 7781
  const httpUrl = `http://127.0.0.1:${port}/mcp`
  const token = mode === 'http' ? await ensureToken(false) : null
  const bin = await installedBin()
  const manifestPath = await register(mode === 'http' ? httpUrl : null, bin)
  const steps = has(parsed, 'no-agents') ? [] : await setupAgents({ mode, http: { url: httpUrl, token }, bin, agents: selection, desktop: !has(parsed, 'no-desktop') })
  out(io, { manifest: manifestPath, mcp: mode, steps }, () =>
    [`registered in ${manifestPath}`, ...steps.filter((step) => step.state !== 'skipped').map((step) => `${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.agent}: ${step.detail}`), '', (config.sites.length === 0 ? 'Next: atl site add https://<name>.atlassian.net --email <you@company.com>' : `Sites: ${config.sites.map((site) => site.name).join(', ')}`), ...(mode === 'http' ? ['Start the shared server with: atl mcp serve'] : [])].join('\n'),
  )
  return steps.some((step) => step.state === 'failed') ? EXIT.failure : EXIT.ok
}

async function uninstallCommand(io: Io): Promise<number> {
  const steps = await uninstallAgents()
  const removed = await unregister()
  out(io, { unregistered: removed, steps }, () => [`registry: ${removed ? 'removed' : 'not registered'}`, ...steps.filter((step) => step.state === 'removed').map((step) => `- ${step.agent}: ${step.detail}`), `Sites and tokens are kept in ${configPath()}; remove them with "atl site rm".`].join('\n'))
  return EXIT.ok
}

export async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json')
  const words: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) break
    words.push(arg)
  }
  const rest = argv.slice(words.length)
  const io: Io = { json, command: words.slice(0, 3).join(' ') || 'help' }
  try {
    if (argv[0] === '--version' || argv[0] === '-v') {
      process.stdout.write(`${VERSION}\n`)
      return EXIT.ok
    }
    if (words.length === 0 || words[0] === 'help') {
      if (words[1]) {
        const match = matchTool(words.slice(1))
        if (match) {
          process.stdout.write(`${toolHelp(match.tool)}\n`)
          return EXIT.ok
        }
      }
      process.stdout.write(`${help()}\n`)
      return EXIT.ok
    }
    const head = words[0]
    if (head === 'capabilities') {
      io.command = 'capabilities'
      out(io, { name: 'atl', version: VERSION, envelope: 1, capabilities: CAPABILITIES, emits: [], tools: TOOLS.map((tool) => tool.name) }, () => CAPABILITIES.join('\n'))
      return EXIT.ok
    }
    if (head === 'setup') return await setupCommand({ ...io, command: 'setup' }, rest)
    if (head === 'uninstall') return await uninstallCommand({ ...io, command: 'uninstall' })
    if (head === 'mcp') return await mcpCommand({ ...io, command: `mcp ${words[1] ?? ''}`.trim() }, words, rest)
    const ctx = new ToolContext(new SiteRegistry())
    if (head === 'site') {
      const handled = await siteCommand({ ...io, command: `site ${words[1] ?? ''}`.trim() }, words, [...words.slice(2), ...rest], ctx)
      if (handled !== null) return handled
    }
    if (head === 'tool') {
      const tool = words[1] ? findTool(words[1]) : undefined
      if (!tool) throw usageError(`Usage: atl tool <name> [--args JSON]. Tools: ${TOOLS.map((item) => item.name).join(', ')}`)
      const parsed = parseArgv(rest)
      const raw = flag(parsed, 'args')
      const args = raw ? (JSON.parse(raw.startsWith('@') ? (await import('node:fs')).readFileSync(raw === '@-' ? 0 : raw.slice(1), 'utf8') : raw) as Record<string, unknown>) : {}
      const site = flag(parsed, 'site')
      out({ ...io, command: `tool ${tool.name}` }, await tool.run(ctx, { ...args, ...(site ? { site } : {}) }))
      return EXIT.ok
    }
    const match = matchTool(words)
    if (!match) throw new AtlError(`Unknown command "${words.join(' ')}".`, { code: 'UNKNOWN_COMMAND', exitCode: EXIT.usage, hint: 'Run "atl help".' })
    io.command = match.tool.cli.path.join(' ')
    return await runTool(io, match.tool, [...match.rest, ...rest], ctx)
  } catch (error) {
    return fail(io, error)
  }
}

function fail(io: Io, error: unknown): number {
  const atl = error instanceof AtlError ? error : null
  const code = atl?.code ?? 'UNEXPECTED'
  const message = error instanceof Error ? error.message : String(error)
  if (io.json) {
    writeJson(errorEnvelope(SCHEMA_VERSION, io.command, { code, message, ...(atl?.hint ? { hint: atl.hint } : {}), ...(atl?.status ? { status: atl.status } : {}) }, atl?.details ?? undefined))
  } else {
    process.stderr.write(`atl: ${message}\n${atl?.hint ? `${atl.hint}\n` : ''}`)
  }
  return atl?.exitCode ?? EXIT.failure
}

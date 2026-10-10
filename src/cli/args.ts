import { readFileSync } from 'node:fs'
import { usageError } from '../errors.ts'
import type { Schema } from '../tools/schema.ts'

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string[]>
  booleans: Set<string>
}

export const GLOBAL_BOOLEANS = new Set(['json', 'help', 'h'])

export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

export function parseArgv(argv: readonly string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  const booleans = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      const name = eq === -1 ? body : body.slice(0, eq)
      if (name.startsWith('no-') && eq === -1 && booleanFlags.has(name.slice(3))) {
        flags.set(name.slice(3), ['false'])
        continue
      }
      if (eq !== -1) {
        flags.set(name, [...(flags.get(name) ?? []), body.slice(eq + 1)])
      } else if (booleanFlags.has(name) || GLOBAL_BOOLEANS.has(name)) {
        booleans.add(name)
      } else {
        const next = argv[index + 1]
        if (next === undefined || (next.startsWith('--') && next.length > 2)) booleans.add(name)
        else {
          flags.set(name, [...(flags.get(name) ?? []), next])
          index += 1
        }
      }
      continue
    }
    if (arg === '-h') {
      booleans.add('help')
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags, booleans }
}

let stdinCache: string | null = null

export function readValueSource(value: string): string {
  if (value === '@-') {
    stdinCache ??= readFileSync(0, 'utf8')
    return stdinCache
  }
  if (value.startsWith('@@')) return value.slice(1)
  if (value.startsWith('@') && value.length > 1) return readFileSync(value.slice(1), 'utf8')
  return value
}

function coerce(name: string, raw: string, schema: Schema | undefined): unknown {
  const type = schema?.['type']
  if (type === 'integer' || type === 'number') {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw usageError(`--${kebab(name)} expects a number, got "${raw}".`)
    return value
  }
  if (type === 'boolean') return raw !== 'false' && raw !== '0' && raw !== 'no'
  if (type === 'object' || (schema && !type && schema['properties'])) {
    const text = readValueSource(raw)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw usageError(`--${kebab(name)} expects JSON (inline, @file or @- for stdin).`)
    }
  }
  if (type === 'array') {
    const text = readValueSource(raw)
    if (text.trim().startsWith('[')) {
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw usageError(`--${kebab(name)} expects a JSON array or comma-separated values.`)
      }
    }
    return text.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  }
  return readValueSource(raw)
}

export function argsFromSchema(parsed: ParsedArgs, properties: Record<string, Schema>, positionalNames: readonly string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const byFlag = new Map(Object.keys(properties).map((name) => [kebab(name), name]))
  positionalNames.forEach((name, index) => {
    const value = parsed.positionals[index]
    if (value !== undefined) args[name] = coerce(name, value, properties[name])
  })
  if (parsed.positionals.length > positionalNames.length) {
    throw usageError(`Unexpected argument "${parsed.positionals[positionalNames.length]}".`)
  }
  for (const [flag, values] of parsed.flags) {
    if (GLOBAL_BOOLEANS.has(flag)) continue
    const name = byFlag.get(flag) ?? (flag in properties ? flag : undefined)
    if (!name) throw usageError(`Unknown option --${flag}.`)
    const schema = properties[name]
    if (schema?.['type'] === 'array' && values.length > 1) args[name] = values.flatMap((value) => coerce(name, value, schema) as unknown[])
    else args[name] = coerce(name, values[values.length - 1] ?? '', schema)
  }
  for (const flag of parsed.booleans) {
    if (GLOBAL_BOOLEANS.has(flag)) continue
    const name = byFlag.get(flag) ?? (flag in properties ? flag : undefined)
    if (!name) throw usageError(`Unknown option --${flag}.`)
    if (properties[name]?.['type'] !== 'boolean') throw usageError(`--${flag} needs a value.`)
    args[name] = true
  }
  return args
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  conflict: 4,
  auth: 5,
  http: 6,
} as const

export class AtlError extends Error {
  readonly code: string
  readonly hint: string | undefined
  readonly exitCode: number
  readonly status: number | undefined
  readonly details: unknown

  constructor(message: string, options: { code: string; hint?: string; exitCode?: number; status?: number; details?: unknown }) {
    super(message)
    this.name = 'AtlError'
    this.code = options.code
    this.hint = options.hint
    this.exitCode = options.exitCode ?? EXIT.failure
    this.status = options.status
    this.details = options.details
  }
}

export function usageError(message: string, hint?: string): AtlError {
  return new AtlError(message, { code: 'USAGE', exitCode: EXIT.usage, ...(hint ? { hint } : {}) })
}

export function notFound(message: string, code = 'NOT_FOUND', hint?: string): AtlError {
  return new AtlError(message, { code, exitCode: EXIT.notFound, ...(hint ? { hint } : {}) })
}

export function conflict(message: string, code = 'CONFLICT', hint?: string): AtlError {
  return new AtlError(message, { code, exitCode: EXIT.conflict, ...(hint ? { hint } : {}) })
}

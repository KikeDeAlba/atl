export type Schema = Record<string, unknown>

export const s = {
  string: (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra }),
  number: (description: string, extra: Schema = {}): Schema => ({ type: 'number', description, ...extra }),
  integer: (description: string, extra: Schema = {}): Schema => ({ type: 'integer', description, ...extra }),
  boolean: (description: string, extra: Schema = {}): Schema => ({ type: 'boolean', description, ...extra }),
  strings: (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description }),
  object: (description: string, extra: Schema = {}): Schema => ({ type: 'object', description, additionalProperties: true, ...extra }),
  enum: (description: string, values: readonly string[]): Schema => ({ type: 'string', enum: values, description }),
}

export function objectSchema(properties: Record<string, Schema>, required: readonly string[] = []): Schema {
  return { type: 'object', properties, ...(required.length > 0 ? { required: [...required] } : {}), additionalProperties: false }
}

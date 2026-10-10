import { cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await cp(path.join(root, 'src', 'api', 'catalog'), path.join(root, 'dist', 'api', 'catalog'), { recursive: true })

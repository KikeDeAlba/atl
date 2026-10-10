import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

export async function readSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim()
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  const output = rl as unknown as { _writeToOutput?: (text: string) => void; output: NodeJS.WriteStream }
  let muted = false
  output._writeToOutput = (text: string) => {
    if (!muted) process.stderr.write(text)
  }
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      process.stderr.write('\n')
      resolve(answer.trim())
    })
    muted = true
  })
}

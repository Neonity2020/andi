import { createInterface } from 'node:readline/promises'
import type { ToolConfirmationHandler } from '../tools/types.ts'

export function createCliConfirmationHandler(): ToolConfirmationHandler {
  return async request => {
    if (!process.stdin.isTTY) {
      return false
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      process.stdout.write(
        [
          'Dangerous tool action requires confirmation.',
          `Tool: ${request.toolName}`,
          `Reason: ${request.reason}`,
          `CWD: ${request.cwd ?? '.'}`,
          `Command: ${request.command}`,
          'Type yes to continue: ',
        ].join('\n'),
      )
      const answer = (await rl.question('')).trim().toLowerCase()
      return answer === 'yes'
    } finally {
      rl.close()
    }
  }
}

import { describe, expect, test } from 'bun:test'
import { createMarkdownOutput, renderMarkdownForTerminal } from '../src/cli/markdown.ts'

describe('terminal markdown rendering', () => {
  test('renders common markdown syntax into terminal-friendly text', () => {
    const rendered = renderMarkdownForTerminal(
      [
        '# Result',
        '',
        '- **Changed** `src/cli.ts`',
        '',
        '```ts',
        'const ok = true',
        '```',
      ].join('\n'),
    )

    expect(rendered).toContain('Result')
    expect(rendered).toContain('- Changed src/cli.ts')
    expect(rendered).toContain('--- code: ts ---')
    expect(rendered).toContain('  const ok = true')
  })

  test('buffers streamed chunks and flushes rendered markdown once', () => {
    let output = ''
    const markdownOutput = createMarkdownOutput({
      write(text) {
        output += text
      },
    })

    markdownOutput.write('## Hello')
    markdownOutput.write('\n\n**world**')
    expect(output).toBe('')

    markdownOutput.flush()
    expect(output).toContain('Hello')
    expect(output).toContain('world')
  })
})

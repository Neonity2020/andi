export type WritableOutput = {
  write(text: string): void
}

export type FlushableOutput = WritableOutput & {
  flush(): void
}

export type MarkdownRenderOptions = {
  colors?: boolean
}

export function createMarkdownOutput(
  target: WritableOutput,
  options: MarkdownRenderOptions = {},
): FlushableOutput {
  let buffer = ''
  return {
    write(text: string) {
      buffer += text
    },
    flush() {
      if (!buffer) {
        return
      }
      target.write(renderMarkdownForTerminal(buffer, options))
      buffer = ''
    },
  }
}

export function renderMarkdownForTerminal(
  markdown: string,
  { colors = false }: MarkdownRenderOptions = {},
): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const rendered: string[] = []
  let inCodeBlock = false
  let codeLanguage = ''

  for (const line of lines) {
    const fence = line.match(/^```([\w-]*)\s*$/)
    if (fence) {
      inCodeBlock = !inCodeBlock
      codeLanguage = inCodeBlock ? fence[1] ?? '' : ''
      rendered.push(inCodeBlock ? style(`--- code${codeLanguage ? `: ${codeLanguage}` : ''} ---`, 'dim', colors) : style('---', 'dim', colors))
      continue
    }

    if (inCodeBlock) {
      rendered.push(style(`  ${line}`, 'dim', colors))
      continue
    }

    rendered.push(renderMarkdownLine(line, colors))
  }

  return `${rendered.join('\n').replace(/\n{3,}/g, '\n\n')}${markdown.endsWith('\n') ? '' : '\n'}`
}

function renderMarkdownLine(line: string, colors: boolean): string {
  const heading = line.match(/^(#{1,6})\s+(.+)$/)
  if (heading) {
    return style(renderInlineMarkdown(heading[2] ?? '', colors), 'bold', colors)
  }

  const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/)
  if (bullet) {
    return `${bullet[1] ?? ''}- ${renderInlineMarkdown(bullet[2] ?? '', colors)}`
  }

  const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/)
  if (ordered) {
    return `${ordered[1] ?? ''}- ${renderInlineMarkdown(ordered[2] ?? '', colors)}`
  }

  const quote = line.match(/^>\s?(.*)$/)
  if (quote) {
    return style(`| ${renderInlineMarkdown(quote[1] ?? '', colors)}`, 'dim', colors)
  }

  return renderInlineMarkdown(line, colors)
}

function renderInlineMarkdown(text: string, colors: boolean): string {
  return text
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, (_match, label: string, url: string) => `${label} (${url})`)
    .replace(/`([^`]+)`/g, (_match, code: string) => style(code, 'cyan', colors))
    .replace(/\*\*([^*]+)\*\*/g, (_match, value: string) => style(value, 'bold', colors))
    .replace(/__([^_]+)__/g, (_match, value: string) => style(value, 'bold', colors))
    .replace(/\*([^*]+)\*/g, (_match, value: string) => style(value, 'italic', colors))
    .replace(/_([^_]+)_/g, (_match, value: string) => style(value, 'italic', colors))
}

function style(text: string, styleName: 'bold' | 'italic' | 'cyan' | 'dim', colors: boolean): string {
  if (!colors) {
    return text
  }
  const codes = {
    bold: ['\x1b[1m', '\x1b[22m'],
    italic: ['\x1b[3m', '\x1b[23m'],
    cyan: ['\x1b[36m', '\x1b[39m'],
    dim: ['\x1b[2m', '\x1b[22m'],
  } satisfies Record<typeof styleName, [string, string]>
  const [open, close] = codes[styleName]
  return `${open}${text}${close}`
}

import { describe, expect, test } from 'bun:test'
import {
  compactConversationForContext,
  compactMessageForContext,
  compactTextForContext,
} from '../src/context/truncation.ts'

describe('context truncation', () => {
  test('truncates large assistant code blocks before injection', () => {
    const text = buildLargeCodeBlock(160)
    const compacted = compactTextForContext(text, {
      charLimit: 3_000,
      lineLimit: 999,
      maxCodeFenceLines: 40,
      codeFenceHeadLines: 4,
      codeFenceTailLines: 4,
      plainHeadLines: 8,
      plainTailLines: 8,
    })

    expect(compacted.length).toBeLessThan(text.length)
    expect(compacted).toContain('[context truncated:')
    expect(compacted).toContain('generated line 001')
    expect(compacted).toContain('generated line 160')
    expect(compacted).not.toContain('generated line 080')
  })

  test('preserves user instructions while compacting assistant payloads', () => {
    const userMessage = compactMessageForContext(
      {
        role: 'user',
        content: 'Please keep this instruction intact.',
      },
      { maxUserChars: 4_000 },
    )

    const assistantMessage = compactMessageForContext(
      {
        role: 'assistant',
        content: buildLargeCodeBlock(120),
      },
      {
        maxCharsPerAssistantMessage: 2_000,
        maxLinesPerMessage: 999,
        maxCodeFenceLines: 40,
        codeFenceHeadLines: 3,
        codeFenceTailLines: 3,
      },
    )

    expect(userMessage.content).toBe('Please keep this instruction intact.')
    expect(assistantMessage.content).toContain('[context truncated:')
    expect(assistantMessage.contextTruncated).toBe(true)
  })

  test('keeps only the most recent context messages', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index + 1}`,
    }))

    const bundle = compactConversationForContext(messages, { maxMessages: 10 })

    expect(bundle.droppedMessages).toBe(2)
    expect(bundle.messages).toHaveLength(10)
    expect(bundle.messages[0].content).toBe('message 3')
    expect(bundle.messages.at(-1)?.content).toBe('message 12')
  })
})

function buildLargeCodeBlock(linesCount: number): string {
  const lines = ['```ts', 'export function demo() {']
  for (let i = 0; i < linesCount; i += 1) {
    lines.push(`  return ${i}`)
    lines.push(`  // generated line ${String(i + 1).padStart(3, '0')}`)
  }
  lines.push('}')
  lines.push('```')
  return lines.join('\n')
}

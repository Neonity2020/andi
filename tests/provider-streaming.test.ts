import { describe, expect, test } from 'bun:test'
import { parseAnthropicStreamToken } from '../src/providers/anthropic.ts'
import { parseOpenAIStreamToken } from '../src/providers/openai.ts'
import { loadSettings } from '../src/config/settings.ts'
import { createProviderClient } from '../src/providers/index.ts'
import { createOpenAICompatibleClient } from '../src/providers/openai-compatible.ts'
import { parseSSE } from '../src/providers/sse.ts'

describe('provider streaming', () => {
  test('parses SSE data events across chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"a":'))
        controller.enqueue(new TextEncoder().encode('1}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream)
    const events: string[] = []

    for await (const event of parseSSE(response)) {
      events.push(event)
    }

    expect(events).toEqual(['{"a":1}', '[DONE]'])
  })

  test('extracts OpenAI streaming deltas', () => {
    const token = parseOpenAIStreamToken(
      JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
    )

    expect(token).toBe('hello')
  })

  test('extracts Anthropic content_block_delta text', () => {
    const token = parseAnthropicStreamToken(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'world' },
      }),
    )

    expect(token).toBe('world')
  })

  test('ignores non-token Anthropic events', () => {
    expect(parseAnthropicStreamToken(JSON.stringify({ type: 'message_start' }))).toBe('')
  })

  test('creates zhipu coding client from settings', () => {
    const settings = loadSettings({
      env: { ZHIPU_CODING_API_KEY: 'test-zhipu-key' },
    })

    const client = createProviderClient('zhipu-coding', settings)

    expect(client.name).toBe('zhipu-coding')
    expect(client.defaultModel).toBe('glm-4.7')
  })

  test('zhipu coding client calls OpenAI-compatible chat completions endpoint', async () => {
    let requestUrl = ''
    let authorization = ''
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url)
      authorization = String((init?.headers as Record<string, string>).authorization)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
            ),
          )
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream)
    }

    const settings = loadSettings({
      env: { ZHIPU_CODING_API_KEY: 'test-zhipu-key' },
    })
    settings.providers['zhipu-coding'].baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4'
    const { createZhipuCodingClient } = await import('../src/providers/zhipu-coding.ts')
    const mockClient = createZhipuCodingClient({
      apiKey: 'test-zhipu-key',
      baseUrl: settings.providers['zhipu-coding'].baseUrl,
      defaultModel: 'glm-4.7',
      fetchImpl: fetchImpl as typeof fetch,
    })
    const tokens: string[] = []

    for await (const event of mockClient.stream({
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      if (event.type === 'token') {
        tokens.push(event.text)
      }
    }

    expect(requestUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
    expect(authorization).toBe('Bearer test-zhipu-key')
    expect(tokens).toEqual(['ok'])
  })

  test('OpenAI-compatible client streams tool calls and sends tool schemas', async () => {
    let requestBody: Record<string, unknown> = {}
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'read_file', arguments: '{"path":' },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
            ),
          )
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: '"README.md"}' },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
            ),
          )
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream)
    }

    const client = createOpenAICompatibleClient({
      name: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.example/v1',
      defaultModel: 'gpt-test',
      missingKeyName: 'OPENAI_API_KEY',
      fetchImpl: fetchImpl as typeof fetch,
    })
    const events = []

    for await (const event of client.stream({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'read' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'read',
            parameters: { type: 'object' },
          },
        },
      ],
    })) {
      events.push(event)
    }

    expect((requestBody.tools as unknown[])).toHaveLength(1)
    expect(events).toContainEqual({
      type: 'tool_call',
      toolCall: {
        id: 'call_1',
        name: 'read_file',
        input: { path: 'README.md' },
      },
    })
  })
})

export async function* parseSSE(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error('Provider response did not include a body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const dataLines = part
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trimStart())

      if (dataLines.length > 0) {
        yield dataLines.join('\n')
      }
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) {
    const dataLines = buffer
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())

    if (dataLines.length > 0) {
      yield dataLines.join('\n')
    }
  }
}

export async function assertProviderResponseOk(response: Response): Promise<void> {
  if (response.ok) {
    return
  }

  const body = await response.text().catch(() => '')
  const suffix = body ? `: ${body.slice(0, 800)}` : ''
  throw new Error(`Provider request failed with ${response.status} ${response.statusText}${suffix}`)
}

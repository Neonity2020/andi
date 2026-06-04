export type ToolCall = {
  id: string
  name: string
  input: unknown
}

export type ToolResult = {
  toolCallId: string
  content: string
  isError?: boolean
}

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: unknown
  execute(input: unknown): Promise<ToolResult>
}

export type ToolRegistry = {
  list(): ToolDefinition[]
  get(name: string): ToolDefinition | null
}

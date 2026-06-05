export type ToolCall = {
  id: string
  name: string
  input: unknown
}

export type ToolResult = {
  toolCallId: string
  toolName: string
  content: string
  isError?: boolean
}

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: unknown
  execute(input: unknown, context?: ToolExecutionContext): Promise<string>
}

export type ToolExecutionContext = {
  confirm?: ToolConfirmationHandler
}

export type ToolConfirmationHandler = (request: ToolConfirmationRequest) => Promise<boolean>

export type ToolConfirmationRequest = {
  toolName: string
  command: string
  reason: string
  cwd?: string
}

export type ToolRegistry = {
  list(): ToolDefinition[]
  get(name: string): ToolDefinition | null
}

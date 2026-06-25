export interface ToolArgDef {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  args: Record<string, ToolArgDef>;
  execute(args: Record<string, string>): Promise<string>;
}

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export interface ToolResult {
  name: string;
  args: Record<string, string>;
  output: string;
  error?: string;
}

/** Soyut model kademesi kimlikleri (sağlayıcıdan bağımsız). */
export type ModelId = 'sonnet' | 'haiku' | 'opus' | 'gemini-flash' | 'deepseek';

export interface CompletionOptions {
  model?: ModelId;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  text: string;
  tokensUsed: { input: number; output: number };
  costUsd: number;
  model: string;
}

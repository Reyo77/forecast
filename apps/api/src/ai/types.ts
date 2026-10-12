export type AiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface AiMessage {
  role: 'user' | 'model';
  parts: AiPart[];
}

export interface AiToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema describing the arguments object. */
  parameters: Record<string, unknown>;
}

export interface AiGenerateRequest {
  system?: string;
  messages: AiMessage[];
  /** Ask for a JSON-only response. */
  json?: boolean;
  tools?: AiToolDeclaration[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AiGenerateResponse {
  text: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
}

/** The only thing the app depends on; Gemini implements it, tests use a fake. */
export interface AiClient {
  generate(req: AiGenerateRequest): Promise<AiGenerateResponse>;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super('AI is not configured');
  }
}

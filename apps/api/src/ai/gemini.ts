import { GoogleGenAI } from '@google/genai';
import type { AiClient, AiGenerateRequest, AiGenerateResponse, AiPart } from './types';

const toPart = (p: AiPart) =>
  'text' in p
    ? { text: p.text }
    : 'functionCall' in p
      ? { functionCall: p.functionCall }
      : { functionResponse: p.functionResponse };

/** Real Gemini implementation. Server-side only; the key never leaves this process. */
export class GeminiClient implements AiClient {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResponse> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: req.messages.map((m) => ({ role: m.role, parts: m.parts.map(toPart) })),
      config: {
        systemInstruction: req.system,
        ...(req.json && !req.tools && { responseMimeType: 'application/json' }),
        ...(req.tools && {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        }),
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxOutputTokens ?? 2048,
        abortSignal: req.signal,
      },
    });
    return {
      text: response.text ?? '',
      functionCalls: (response.functionCalls ?? []).map((c) => ({
        name: c.name ?? '',
        args: (c.args ?? {}) as Record<string, unknown>,
      })),
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

/** Used when no real key is configured: every call fails with a clear, friendly error. */
export class UnconfiguredAiClient implements AiClient {
  async generate(): Promise<AiGenerateResponse> {
    const { AiNotConfiguredError } = await import('./types');
    throw new AiNotConfiguredError();
  }
}

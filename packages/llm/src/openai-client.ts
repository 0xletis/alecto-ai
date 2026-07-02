export interface OpenAIClientOptions {
  apiKey?: string;
}

export class OpenAIClient {
  private readonly apiKey?: string;

  constructor(options: OpenAIClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async respond(): Promise<never> {
    throw new Error("OpenAI client wrapper is a placeholder.");
  }
}


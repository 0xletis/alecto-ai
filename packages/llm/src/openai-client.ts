import OpenAI from "openai";

export interface OpenAIClientOptions {
  apiKey?: string;
}

export function createOpenAIClient(options: OpenAIClientOptions = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to create the OpenAI client.");
  }

  return new OpenAI({ apiKey });
}

export class OpenAIClient {
  private readonly apiKey?: string;

  constructor(options: OpenAIClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  create() {
    return createOpenAIClient({ apiKey: this.apiKey });
  }
}

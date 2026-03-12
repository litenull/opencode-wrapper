export interface ConfigOptions {
  host: string;
  port: number;
  tmuxSession: string;
  tmuxWindow: string;
  claudeCmd: string;
  paneHistoryLines: number;
  pollIntervalSec: number;
  idleTimeoutSec: number;
  startTimeoutSec: number;
  hardTimeoutSec: number;
  promptMode: "last_user" | "full";
  debug: boolean;
  debugLogBodyMax: number;
}

export interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

export interface ContentPart {
  type?: string;
  text?: string;
}

export interface ChatCompletionRequest {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
}

export interface ChatCompletionChoice {
  index: number;
  message?: { role: string; content: string };
  delta?: { role?: string; content?: string };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: "list";
  data: Model[];
}

export type HttpMethod = "GET" | "POST";

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

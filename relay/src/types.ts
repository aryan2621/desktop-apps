export type Json = unknown;
export interface Server {
  id: string;
  name: string;
  transport: "stdio" | "http";
  url: string;
  command: string;
  args: string[];
  cwd: string;
  headers: string[];
  env: string[];
}
export interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type?: string;
    properties?: Record<
      string,
      { type?: string; description?: string; default?: unknown }
    >;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
}
export interface Connection {
  info: {
    serverInfo?: { name: string; version: string };
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
  };
  tools: Tool[];
  /** Connected with a saved sign-in (OAuth). */
  signedIn?: boolean;
}
export interface Provider {
  id: string;
  model: string;
  baseUrl: string;
}
export interface TestCase {
  id: string;
  name: string;
  serverId: string;
  tool: string;
  arguments: unknown;
  contains: string;
}
export interface Workspace {
  servers: Server[];
  providers: Provider[];
  tests: TestCase[];
}
export interface Trace {
  id: string;
  time: string;
  server: string;
  name: string;
  arguments: unknown;
  result: unknown;
  duration: number;
  error: boolean;
}
export interface Call {
  id: string;
  name: string;
  arguments: unknown;
}
export interface Step {
  text: string;
  calls: Call[];
  history: unknown[];
  usage: unknown;
}
export interface ToolOutput {
  id: string;
  content: string;
}
export const providers = [
  { id: "claude", name: "Claude", detail: "Anthropic" },
  { id: "openai", name: "OpenAI", detail: "GPT models" },
  { id: "gemini", name: "Gemini", detail: "Google" },
];
export interface LocalModel {
  id: string;
  name: string;
  note: string;
  sizeMb: number;
  minRamGb: number;
  repo: string;
  installed: boolean;
}
export interface Catalog {
  ramGb: number;
  recommended: string;
  models: LocalModel[];
}
export const emptyServer = (): Server => ({
  id: "",
  name: "",
  transport: "http",
  url: "",
  command: "",
  args: [],
  cwd: "",
  headers: [],
  env: [],
});
export const pretty = (v: unknown) => JSON.stringify(v, null, 2) ?? "";
export function parseObject(s: string): Record<string, unknown> {
  const v: unknown = JSON.parse(s);
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error('Enter a JSON object, for example {"name": "world"}.');
  return v as Record<string, unknown>;
}

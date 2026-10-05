// =============================================================================
// 测试工具:假节点进程管理、端口、MCP 客户端辅助
// =============================================================================

import type { RecordedRequest } from "./fake_upstream.ts";

const TEST_DIR = import.meta.dirname ?? "";
export const PROJECT_ROOT = TEST_DIR.replace(/[\\/]test$/, "");
const SEP = PROJECT_ROOT.includes("\\") ? "\\" : "/";
export const FAKE_NODE_PATH = `${PROJECT_ROOT}${SEP}test${SEP}fake_node.ts`;

/** 本地测试专用凭据(与任何真实密钥无关)。 */
export const TEST_PROXY_KEY = "ctx7-proxy-test-key-0001";
export const TEST_UPSTREAM_KEY = "ctx7-upstream-test-key-0001";

export interface NodeHandle {
  label: string;
  port: number;
  child: Deno.ChildProcess;
}

/** 分配一个空闲本地端口。 */
export function freePort(): Promise<number> {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return Promise.resolve(port);
}

/** 启动一个假 Supabase 节点(独立子进程,加载生产入口)。 */
export async function startNode(opts: {
  label: string;
  port: number;
  env?: Record<string, string>;
  upstreamBase?: string;
}): Promise<NodeHandle> {
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  if (opts.upstreamBase) env.FAKE_UPSTREAM_BASE = opts.upstreamBase;

  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", FAKE_NODE_PATH, String(opts.port)],
    cwd: PROJECT_ROOT,
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  pipeWithPrefix(child.stdout, `[${opts.label}]`);
  pipeWithPrefix(child.stderr, `[${opts.label}!]`);

  await waitForNode(opts.port, opts.label);
  return { label: opts.label, port: opts.port, child };
}

/** 轮询等待节点就绪(OPTIONS 预检无需凭据,不触达上游)。 */
async function waitForNode(port: number, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(mcpEndpoint(port), { method: "OPTIONS" });
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // 尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`节点 ${label} 未在 20 秒内就绪(端口 ${port})`);
}

/** 读取子进程输出并加前缀转发到测试日志(密钥一律脱敏)。 */
function pipeWithPrefix(stream: ReadableStream<Uint8Array>, prefix: string): void {
  (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) console.log(`${prefix} ${redact(line)}`);
      }
    }
    if (buffer.trim()) console.log(`${prefix} ${redact(buffer)}`);
  })().catch(() => {});
}

function redact(line: string): string {
  return line
    .replaceAll(TEST_PROXY_KEY, "[redacted]")
    .replaceAll(TEST_UPSTREAM_KEY, "[redacted]");
}

export function mcpEndpoint(port: number, search = ""): string {
  return `http://127.0.0.1:${port}/functions/v1/context7-proxy${search}`;
}

export interface McpResponse {
  res: Response;
  text: string;
  events: unknown[];
}

/** 以 MCP 客户端身份发起 JSON-RPC POST 请求。 */
export async function mcpPost(
  port: number,
  payload: unknown,
  opts: { headers?: Record<string, string>; search?: string } = {},
): Promise<McpResponse> {
  const res = await fetch(mcpEndpoint(port, opts.search ?? ""), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { res, text, events: sseEvents(text) };
}

/** 解析 SSE 文本中的全部 data 事件(JSON)。 */
export function sseEvents(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"));
    if (!dataLines.length) continue;
    const data = dataLines.map((line) => line.slice("data:".length).trim()).join("\n");
    try {
      out.push(JSON.parse(data));
    } catch {
      // 忽略非 JSON 数据行
    }
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

export function headerValue(record: RecordedRequest, name: string): string | undefined {
  const target = name.toLowerCase();
  return record.headers.find(([n]) => n.toLowerCase() === target)?.[1];
}

export async function stopNodes(nodes: NodeHandle[]): Promise<void> {
  for (const node of nodes) {
    try {
      node.child.kill("SIGKILL");
      await node.child.status;
    } catch {
      // 忽略已退出的进程
    }
  }
}

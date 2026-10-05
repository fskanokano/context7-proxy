// =============================================================================
// 假的 Context7 MCP 上游服务(仅用于本地全链路测试)
// =============================================================================
//
// 行为按线上实测结果模仿:SSE 响应、CORS 头、202/405 语义、JSON-RPC 错误结构;
// 并支持按测试场景切换行为(流式分块、大响应、gzip、错误),同时记录收到的全部请求,
// 以便断言代理的“全参数透传”。

export interface RecordedRequest {
  method: string;
  /** pathname + search */
  path: string;
  headers: [string, string][];
  bodyText: string;
}

export type UpstreamBehavior =
  | "normal"
  | "delayed-sse"
  | "big"
  | "gzip"
  | "error-500";

export interface FakeUpstream {
  /** 形如 http://127.0.0.1:PORT */
  readonly url: string;
  readonly requests: RecordedRequest[];
  setBehavior(behavior: UpstreamBehavior): void;
  /** 期望收到的上游凭据(如 "Bearer <key>");null 表示不校验。 */
  setAuthExpectation(value: string | null): void;
  reset(): void;
  stop(): Promise<void>;
}

/** 与 Context7 线上一致的 CORS 头。 */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS,DELETE",
  "access-control-allow-headers":
    "Content-Type, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Context7-API-Key, Context7-API-Key, X-API-Key, Authorization",
};

/** 与 Context7 线上一致的 SSE 响应头。 */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

/** initialize 结果(结构模仿线上真实响应)。 */
const INITIALIZE_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: {
    tools: { listChanged: false },
    prompts: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
  },
  serverInfo: {
    name: "Context7",
    version: "4.1.1",
    websiteUrl: "https://context7.com",
    description:
      "Context7 provides up-to-date documentation and code examples for libraries and frameworks.",
  },
};

/** tools/list 结果(工具与线上一致)。 */
const TOOLS_LIST_RESULT = {
  tools: [
    {
      name: "resolve-library-id",
      title: "Resolve Context7 Library ID",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          libraryName: { type: "string" },
        },
        required: ["query", "libraryName"],
      },
    },
    {
      name: "query-docs",
      title: "Query Documentation",
      inputSchema: {
        type: "object",
        properties: {
          libraryId: { type: "string" },
          query: { type: "string" },
        },
        required: ["libraryId", "query"],
      },
    },
  ],
};

export function startFakeUpstream(): FakeUpstream {
  const requests: RecordedRequest[] = [];
  let behavior: UpstreamBehavior = "normal";
  let authExpectation: string | null = null;

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    const bodyText = req.body ? await req.text() : "";
    requests.push({
      method: req.method,
      path: url.pathname + url.search,
      headers: [...req.headers],
      bodyText,
    });

    if (req.method === "OPTIONS") {
      return new Response("OK", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
      });
    }

    // 与线上一致:非 POST 方法返回 405 + JSON-RPC 错误
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
        { status: 405, headers: { "content-type": "application/json", ...CORS } },
      );
    }

    if (authExpectation !== null && req.headers.get("authorization") !== authExpectation) {
      return new Response(
        JSON.stringify({ error: "invalid upstream credential (fake upstream)" }),
        {
          status: 401,
          headers: { "content-type": "application/json", ...CORS, "x-fake-upstream": "bad-auth" },
        },
      );
    }

    if (behavior === "error-500") {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json", ...CORS, "x-fake-upstream": "error-500" },
      });
    }

    let message: Record<string, unknown> | null = null;
    if (bodyText) {
      try {
        message = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        message = null;
      }
    }
    const id = message?.id ?? null;

    // 通知类消息(id 缺省)-> 202 Accepted,与线上一致
    if (message && !("id" in message)) {
      return new Response(null, {
        status: 202,
        headers: { ...CORS, "x-fake-upstream": "accepted" },
      });
    }

    if (behavior === "delayed-sse") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 1; i <= 3; i++) {
            const event = `event: message\ndata: ${
              JSON.stringify({
                result: { content: [{ type: "text", text: `chunk-${i}` }] },
                jsonrpc: "2.0",
                id,
              })
            }\n\n`;
            controller.enqueue(encoder.encode(event));
            if (i < 3) await new Promise((resolve) => setTimeout(resolve, 150));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { ...SSE_HEADERS, ...CORS, "x-fake-upstream": "delayed-sse" },
      });
    }

    if (behavior === "big") {
      const bigText = "BIG_PAYLOAD_MARKER_" + "x".repeat(1024 * 1024);
      return sseResponse(
        { result: { content: [{ type: "text", text: bigText }] }, jsonrpc: "2.0", id },
        { ...CORS, "x-fake-upstream": "big" },
      );
    }

    if (behavior === "gzip") {
      const text = `event: message\ndata: ${
        JSON.stringify({
          result: { content: [{ type: "text", text: "gzip-ok" }] },
          jsonrpc: "2.0",
          id,
        })
      }\n\n`;
      const compressed = new Uint8Array(
        await new Response(
          new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
      return new Response(compressed, {
        status: 200,
        headers: {
          ...SSE_HEADERS,
          ...CORS,
          "content-encoding": "gzip",
          "x-fake-upstream": "gzip",
        },
      });
    }

    const result = resultFor(message);
    if (result === null) {
      return sseResponse(
        { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id },
        CORS,
      );
    }
    return sseResponse({ result, jsonrpc: "2.0", id }, { ...CORS, "x-fake-upstream": "normal" });
  });

  const { port } = server.addr as Deno.NetAddr;

  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    setBehavior(value) {
      behavior = value;
    },
    setAuthExpectation(value) {
      authExpectation = value;
    },
    reset() {
      requests.length = 0;
    },
    async stop() {
      await server.shutdown();
    },
  };
}

function sseResponse(payload: unknown, headers: Record<string, string>): Response {
  const text = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(text, {
    status: 200,
    headers: { ...SSE_HEADERS, ...headers },
  });
}

function resultFor(message: Record<string, unknown> | null): unknown | null {
  const method = message?.method;
  if (method === "initialize") return INITIALIZE_RESULT;
  if (method === "tools/list") return TOOLS_LIST_RESULT;
  if (method === "ping") return {};
  if (method === "tools/call") {
    const params = message?.params as
      | { name?: string; arguments?: Record<string, unknown> }
      | undefined;
    if (params?.name === "resolve-library-id") {
      return {
        content: [{
          type: "text",
          text: `Fake library result for ${params?.arguments?.libraryName ?? ""}`,
        }],
      };
    }
    if (params?.name === "query-docs") {
      return {
        content: [{
          type: "text",
          text: `Fake docs for ${params?.arguments?.libraryId ?? ""}`,
        }],
      };
    }
    return null;
  }
  return null;
}

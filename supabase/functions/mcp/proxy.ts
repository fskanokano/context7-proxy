// =============================================================================
// Context7 远程 MCP 兼容代理 —— 核心实现(无状态透传)
// =============================================================================
//
// 请求链路:
//   MCP 客户端 ──(PROXY_API_KEY)──▶ 本代理 ──(CONTEXT7_API_KEY)──▶ https://mcp.context7.com/mcp
//
// 设计要点:
//   * 对外行为与真正的 Context7 远程 MCP 服务一致:JSON-RPC over HTTP、SSE 流式响应、
//     CORS 预检、202/405 语义、错误结构;所有请求参数(方法、路径、查询串、请求头、
//     请求体)与响应(状态码、响应头、流式响应体)全部透传。
//   * 唯一区别:访问本服务需要 PROXY_API_KEY;调用上游使用 CONTEXT7_API_KEY。
//   * 无状态:节点不保存任何会话数据,任意节点可处理任意请求,可水平扩展于负载均衡之后。
//   * 安全:任何密钥都不会被记录或回显;上游密钥仅以 `Authorization: Bearer` 形式转发。

/** 上游 Context7 远程 MCP 服务地址(固定)。 */
export const UPSTREAM_ORIGIN = "https://mcp.context7.com";

/** Supabase Edge Functions 网关为函数分配的挂载路径。 */
export const FUNCTION_MOUNT_PATH = "/functions/v1/mcp";

/** Context7 的 MCP 端点路径。 */
export const UPSTREAM_PATH = "/mcp";

/** 与 Context7 线上实测完全一致的 CORS 响应头。 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS,DELETE",
  "access-control-allow-headers":
    "Content-Type, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Context7-API-Key, Context7-API-Key, X-API-Key, Authorization",
};

/** 客户端可能携带访问密钥的请求头名称(转发时全部移除,统一替换为上游凭据)。 */
export const INBOUND_AUTH_HEADERS: readonly string[] = [
  "authorization",
  "context7_api_key",
  "x-context7-api-key",
  "context7-api-key",
  "x-api-key",
];

/** 不转发给上游的请求头:凭据、逐跳头、由运行时重算的头。 */
const REQUEST_HEADER_DENYLIST: ReadonlySet<string> = new Set([
  ...INBOUND_AUTH_HEADERS,
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // 压缩由运行时与上游协商;响应侧会统一还原为明文(见 RESPONSE_HEADER_DENYLIST)
  "accept-encoding",
]);

/** 不返回给客户端的响应头:逐跳头、以及因运行时自动解压而失效的长度/压缩头。 */
const RESPONSE_HEADER_DENYLIST: ReadonlySet<string> = new Set([
  "content-length",
  // Deno fetch 会自动解压响应体,原始压缩头必须移除,否则客户端会收到不一致的响应
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

/** 代理运行所需的配置(由入口注入,值一律来自环境变量)。 */
export interface ProxyConfig {
  /** 读取本服务的访问密钥(PROXY_API_KEY)。 */
  getProxyApiKey: () => string | undefined;
  /** 读取上游 Context7 的密钥(CONTEXT7_API_KEY)。 */
  getContext7ApiKey: () => string | undefined;
}

/**
 * 创建代理请求处理器。
 *
 * 返回的函数可以直接作为 Edge Runtime 的 fetch 入口使用(见 index.ts)。
 */
export function createHandler(
  config: ProxyConfig,
): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const startedAt = performance.now();
    const requestUrl = new URL(req.url);

    const respond = (res: Response): Response => {
      // 只记录方法与路径;绝不记录查询串(可能包含凭据)、请求头或请求体。
      console.log(
        `${req.method} ${requestUrl.pathname} -> ${res.status} (${
          Math.round(performance.now() - startedAt)
        }ms)`,
      );
      return res;
    };

    // -------------------------------------------------------------------------
    // 1) CORS 预检:与上游一致 —— 200 + "OK",不校验凭据
    // -------------------------------------------------------------------------
    if (req.method === "OPTIONS") {
      return respond(
        new Response("OK", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
        }),
      );
    }

    // -------------------------------------------------------------------------
    // 2) 校验访问凭据(PROXY_API_KEY)
    // -------------------------------------------------------------------------
    const proxyApiKey = config.getProxyApiKey();
    if (!proxyApiKey) {
      return respond(
        jsonRpcServiceError(
          500,
          "Server configuration error: access key is not configured.",
        ),
      );
    }
    const candidates = extractClientKeys(req, requestUrl);
    if (!candidates.some((candidate) => timingSafeEqual(candidate, proxyApiKey))) {
      return respond(unauthorizedResponse());
    }

    // -------------------------------------------------------------------------
    // 3) 读取上游凭据(CONTEXT7_API_KEY)
    // -------------------------------------------------------------------------
    const context7ApiKey = config.getContext7ApiKey();
    if (!context7ApiKey) {
      return respond(
        jsonRpcServiceError(
          500,
          "Server configuration error: upstream key is not configured.",
        ),
      );
    }

    // -------------------------------------------------------------------------
    // 4) 组装上游请求:除凭据外一切透传
    // -------------------------------------------------------------------------
    const upstreamUrl = buildUpstreamUrl(requestUrl);
    const upstreamHeaders = buildUpstreamHeaders(req.headers, context7ApiKey);

    // 注意:这里故意不把 req.signal 传给上游 fetch。
    // Deno 的 legacy abort 语义会在“响应成功完成”时 abort request.signal(而非仅在客户端断开时),
    // 若透传给上游,流式响应(SSE)在传输末尾可能被提前中断;Supabase Edge Runtime 也无法通过
    // --unstable-no-legacy-abort 切换语义。客户端真正断开时,运行时取消响应体会沿流传播,
    // 仍然会中止对上游的读取。
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: req.body,
        redirect: "manual",
      });
    } catch (error) {
      // 失败信息不含凭据;仅记录消息本身,便于运维排查。
      console.error(
        "upstream request failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      return respond(jsonRpcServiceError(502, "Upstream request failed."));
    }

    // -------------------------------------------------------------------------
    // 5) 透传响应:状态码、响应头、流式响应体(SSE 不缓冲)
    // -------------------------------------------------------------------------
    const responseHeaders = new Headers();
    for (const [name, value] of upstreamResponse.headers) {
      if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) {
        responseHeaders.set(name, value);
      }
    }
    return respond(
      new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      }),
    );
  };
}

// -----------------------------------------------------------------------------
// 凭据提取与校验
// -----------------------------------------------------------------------------

/**
 * 提取客户端提供的全部候选密钥。
 *
 * 与真正的 Context7 服务保持一致的“宽进”策略,支持以下位置:
 *   - `Authorization: Bearer <key>`(官方文档推荐)
 *   - `CONTEXT7_API_KEY: <key>` 请求头(部分客户端配置方式)
 *   - `X-Context7-API-Key` / `Context7-API-Key` / `X-API-Key` 请求头
 *   - 查询串 `?CONTEXT7_API_KEY=...`
 */
export function extractClientKeys(req: Request, url: URL): string[] {
  const keys: string[] = [];

  const authorization = req.headers.get("authorization");
  if (authorization) {
    keys.push(stripBearer(authorization));
  }

  for (
    const name of [
      "context7_api_key",
      "x-context7-api-key",
      "context7-api-key",
      "x-api-key",
    ]
  ) {
    const value = req.headers.get(name);
    if (value) keys.push(stripBearer(value));
  }

  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === "context7_api_key") {
      keys.push((url.searchParams.get(key) ?? "").trim());
    }
  }

  return keys.filter((value) => value.length > 0);
}

function stripBearer(value: string): string {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return (match ? match[1] : value).trim();
}

/** 恒定时间字符串比较,避免时序侧信道。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

// -----------------------------------------------------------------------------
// 上游 URL 与请求头
// -----------------------------------------------------------------------------

/** 把网关挂载路径映射为上游 Context7 的端点路径。 */
export function mapPathToUpstream(pathname: string): string {
  if (pathname === FUNCTION_MOUNT_PATH) return UPSTREAM_PATH;
  if (pathname.startsWith(FUNCTION_MOUNT_PATH + "/")) {
    // 保留子路径(例如 /functions/v1/mcp/oauth -> /mcp/oauth),保证透传语义
    return UPSTREAM_PATH + pathname.slice(FUNCTION_MOUNT_PATH.length);
  }
  // 允许自定义域/重写场景直接以 /mcp 形式访问
  if (pathname === UPSTREAM_PATH || pathname.startsWith(UPSTREAM_PATH + "/")) {
    return pathname;
  }
  return UPSTREAM_PATH;
}

/**
 * 构造上游 URL:替换路径,透传其余查询参数。
 * 客户端若通过查询串携带访问密钥,该参数不会转发给上游(避免密钥二次传递)。
 */
export function buildUpstreamUrl(requestUrl: URL): string {
  const path = mapPathToUpstream(requestUrl.pathname);
  const params = new URLSearchParams(requestUrl.searchParams);
  for (const key of [...params.keys()]) {
    if (key.toLowerCase() === "context7_api_key") {
      params.delete(key);
    }
  }
  const search = params.toString();
  return `${UPSTREAM_ORIGIN}${path}${search ? `?${search}` : ""}`;
}

/** 复制客户端请求头(剔除凭据与逐跳头),并注入上游凭据。 */
export function buildUpstreamHeaders(inbound: Headers, context7ApiKey: string): Headers {
  const out = new Headers();
  for (const [name, value] of inbound) {
    if (!REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) {
      out.set(name, value);
    }
  }
  out.set("authorization", `Bearer ${context7ApiKey}`);
  return out;
}

// -----------------------------------------------------------------------------
// 本地生成的响应(仅用于异常场景;正常流量全部透传自上游)
// -----------------------------------------------------------------------------

/** 未授权(缺失或无效的 PROXY_API_KEY)。 */
export function unauthorizedResponse(): Response {
  return new Response(
    jsonRpcErrorBody(-32001, "Unauthorized: invalid or missing API key."),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
        ...CORS_HEADERS,
      },
    },
  );
}

/** 服务端错误(配置缺失、上游不可达等)。 */
export function jsonRpcServiceError(status: number, message: string): Response {
  return new Response(jsonRpcErrorBody(-32000, message), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function jsonRpcErrorBody(code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

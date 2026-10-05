// =============================================================================
// 假的 Supabase Edge Functions 节点(仅用于本地全链路测试)
// =============================================================================
//
// 模拟内容:
//   1. Edge Runtime 加载生产入口 supabase/functions/mcp/index.ts(export default { fetch });
//   2. secret 由测试显式注入(PROXY_API_KEY / CONTEXT7_API_KEY);
//   3. 可选:把发往 https://mcp.context7.com 的出站请求重定向到本地假上游
//      (FAKE_UPSTREAM_BASE,形如 http://127.0.0.1:9000);未设置时直连真实上游。
//
// 用法:
//   deno run -A test/fake_node.ts <port>
//
// 环境变量:
//   PROXY_API_KEY        本服务访问密钥(测试注入)
//   CONTEXT7_API_KEY     上游密钥(可选;缺失可验证 500 行为)
//   FAKE_UPSTREAM_BASE   设置后启用出站重定向

const port = Number(Deno.args[0] ?? "0");

const upstreamBase = Deno.env.get("FAKE_UPSTREAM_BASE");
if (upstreamBase) {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (
      raw === "https://mcp.context7.com/mcp" ||
      raw.startsWith("https://mcp.context7.com/mcp?")
    ) {
      // 生产入口只访问上游端点;测试时重定向到本地假上游(请求路径/头/体原样保留)
      const rewritten = upstreamBase + raw.slice("https://mcp.context7.com".length);
      return realFetch(rewritten, init);
    }
    // 出现其他出站地址即视为测试失败(生产代码不应访问任何其他主机)
    throw new Error(`FAKE_NODE_FORBIDDEN_FETCH: ${raw.slice(0, 200)}`);
  }) as typeof fetch;
}

// 加载生产入口(与部署到 Supabase 时完全相同的文件)
const worker = (await import("../supabase/functions/mcp/index.ts")).default;

Deno.serve(
  {
    port,
    hostname: "127.0.0.1",
    onListen: ({ port: actualPort }) => {
      console.log(`FAKE_NODE_READY port=${actualPort}`);
    },
  },
  (req) => worker.fetch(req),
);

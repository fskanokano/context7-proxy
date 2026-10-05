// =============================================================================
// 全链路端到端测试(确定性、无需外网)
// =============================================================================
//
//   测试进程(MCP 客户端)
//        │  HTTP
//        ▼
//   假 Supabase Edge Functions 节点 ×3(独立子进程,加载生产入口 index.ts)
//        │  HTTP(出站重定向)
//        ▼
//   假 Context7 上游(本进程内,记录全部收到的请求)
//
// 覆盖:凭据认证、全参数透传、SSE 流式不缓冲、大响应、gzip、错误透传、
//       方法语义(GET/DELETE 405)、CORS 预检、多节点分布式、并发、故障迁移、
//       自带探活(GET /health)、配置缺失(500)、密钥不泄漏。

import { assert, assertEquals, assertStringIncludes } from "./asserts.ts";
import type { RecordedRequest } from "./fake_upstream.ts";
import { startFakeUpstream } from "./fake_upstream.ts";
import {
  asRecord,
  freePort,
  headerValue,
  mcpEndpoint,
  mcpPost,
  type NodeHandle,
  sseEvents,
  startNode,
  stopNodes,
  TEST_PROXY_KEY,
  TEST_UPSTREAM_KEY,
} from "./harness.ts";

function initPayload(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "context7-proxy-e2e", version: "0.0.1" },
    },
  };
}

const AUTH = { authorization: `Bearer ${TEST_PROXY_KEY}` };

Deno.test({
  name: "E2E:Context7 MCP 兼容代理全链路(认证/透传/流式/多节点/安全)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  console.log(
    "开始全链路测试:假上游 + 3 个假 Supabase 节点(均为独立进程)\n",
  );
  const upstream = startFakeUpstream();
  upstream.setAuthExpectation(`Bearer ${TEST_UPSTREAM_KEY}`);
  const nodes: NodeHandle[] = [];

  const spawn = async (label: string, extraEnv: Record<string, string> = {}) => {
    const node = await startNode({
      label,
      port: await freePort(),
      upstreamBase: upstream.url,
      env: {
        PROXY_API_KEY: TEST_PROXY_KEY,
        CONTEXT7_API_KEY: TEST_UPSTREAM_KEY,
        ...extraEnv,
      },
    });
    nodes.push(node);
    return node;
  };

  try {
    // -------------------------------------------------------------------------
    await t.step("① 启动 3 个节点(模拟分布式部署)", async () => {
      await spawn("node1");
      await spawn("node2");
      await spawn("node3");
      assertEquals(nodes.length, 3, "3 个节点应全部就绪");
    });

    // -------------------------------------------------------------------------
    await t.step("② CORS 预检:无需凭据,行为与上游一致", async () => {
      const res = await fetch(mcpEndpoint(nodes[0].port), { method: "OPTIONS" });
      assertEquals(res.status, 200, "预检状态码");
      assertEquals(res.headers.get("access-control-allow-origin"), "*", "CORS origin");
      assertEquals(
        res.headers.get("access-control-allow-methods"),
        "GET,POST,OPTIONS,DELETE",
        "CORS 方法列表",
      );
      assertStringIncludes(
        res.headers.get("access-control-allow-headers") ?? "",
        "MCP-Protocol-Version",
        "CORS 头列表",
      );
      assertEquals(await res.text(), "OK", "预检响应体");
    });

    // -------------------------------------------------------------------------
    await t.step("③ 缺少/错误凭据:返回 401,且不触达上游", async () => {
      upstream.reset();
      const missing = await mcpPost(nodes[0].port, initPayload(1));
      assertEquals(missing.res.status, 401, "缺少凭据应 401");
      assertStringIncludes(missing.text, "Unauthorized", "401 错误信息");
      assertEquals(upstream.requests.length, 0, "未授权请求不得触达上游");

      const wrong = await mcpPost(nodes[1].port, initPayload(1), {
        headers: { authorization: "Bearer wrong-key" },
      });
      assertEquals(wrong.res.status, 401, "错误凭据应 401");
      assertEquals(upstream.requests.length, 0, "未授权请求不得触达上游");
    });

    // -------------------------------------------------------------------------
    await t.step("④ initialize 全链路(Authorization: Bearer)", async () => {
      upstream.reset();
      const init = await mcpPost(nodes[0].port, initPayload(2), {
        headers: { ...AUTH, "mcp-protocol-version": "2025-06-18" },
      });
      assertEquals(init.res.status, 200, "initialize 状态码");
      assertEquals(
        init.res.headers.get("content-type"),
        "text/event-stream",
        "SSE 内容类型透传",
      );
      assertStringIncludes(
        init.res.headers.get("cache-control") ?? "",
        "no-cache",
        "cache-control 透传",
      );
      assertEquals(init.res.headers.get("x-accel-buffering"), "no", "x-accel-buffering 透传");
      assertEquals(init.res.headers.get("x-fake-upstream"), "normal", "上游自定义响应头透传");

      const result = asRecord(asRecord(init.events[0]).result);
      assertEquals(asRecord(result.serverInfo).name, "Context7", "serverInfo 透传");
      assertEquals(result.protocolVersion, "2025-06-18", "协议版本透传");
    });

    // -------------------------------------------------------------------------
    await t.step("⑤ 透传保真:上游收到的请求与客户端完全一致(凭据除外)", () => {
      const seen = upstream.requests.at(-1);
      assert(seen, "上游应已收到请求");
      assertEquals(seen.method, "POST", "请求方法");
      assertEquals(seen.path, "/mcp", "上游端点路径");
      assertEquals(
        headerValue(seen, "authorization"),
        `Bearer ${TEST_UPSTREAM_KEY}`,
        "上游凭据必须替换为 CONTEXT7_API_KEY",
      );
      assertEquals(
        headerValue(seen, "mcp-protocol-version"),
        "2025-06-18",
        "MCP-Protocol-Version 透传",
      );
      assertEquals(
        headerValue(seen, "accept"),
        "application/json, text/event-stream",
        "Accept 透传",
      );
      assertEquals(headerValue(seen, "content-type"), "application/json", "Content-Type 透传");
      assert(
        !seen.headers.some(([, value]) => value.includes(TEST_PROXY_KEY)),
        "严禁把访问密钥转发给上游",
      );
      assert(!seen.bodyText.includes(TEST_PROXY_KEY), "请求体不应包含访问密钥");
      assertEquals(
        JSON.parse(seen.bodyText).method,
        "initialize",
        "请求体字节级透传",
      );
    });

    // -------------------------------------------------------------------------
    await t.step("⑥ notifications/initialized -> 202(与上游一致)", async () => {
      const note = await mcpPost(
        nodes[1].port,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { headers: AUTH },
      );
      assertEquals(note.res.status, 202, "通知消息状态码");
      assertEquals(note.text, "", "通知消息响应体应为空");
    });

    // -------------------------------------------------------------------------
    await t.step("⑦ tools/list(CONTEXT7_API_KEY 请求头认证,节点 2)", async () => {
      upstream.reset();
      const list = await mcpPost(
        nodes[1].port,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        { headers: { CONTEXT7_API_KEY: TEST_PROXY_KEY } },
      );
      assertEquals(list.res.status, 200, "tools/list 状态码");
      const tools = (asRecord(asRecord(list.events[0]).result).tools as Array<{ name: string }>)
        .map((tool) => tool.name);
      assertEquals(tools, ["resolve-library-id", "query-docs"], "工具列表与 Context7 一致");
    });

    // -------------------------------------------------------------------------
    await t.step("⑧ tools/call resolve-library-id(参数透传)", async () => {
      const call = await mcpPost(
        nodes[0].port,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "resolve-library-id",
            arguments: { libraryName: "Next.js", query: "middleware" },
          },
        },
        { headers: AUTH },
      );
      assertEquals(call.res.status, 200, "tools/call 状态码");
      const content = (asRecord(asRecord(call.events[0]).result).content as Array<
        Record<string, unknown>
      >)[0];
      assertStringIncludes(String(content?.text ?? ""), "Next.js", "工具调用结果");

      const seen = upstream.requests.at(-1)!;
      const seenBody = JSON.parse(seen.bodyText);
      assertEquals(seenBody.params.arguments.libraryName, "Next.js", "工具参数透传");
      assertEquals(seenBody.params.name, "resolve-library-id", "工具名称透传");
    });

    // -------------------------------------------------------------------------
    await t.step("⑨ 查询串凭据认证 + 参数剥离(节点 3)", async () => {
      upstream.reset();
      const viaQuery = await mcpPost(
        nodes[2].port,
        { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
        { search: `?CONTEXT7_API_KEY=${encodeURIComponent(TEST_PROXY_KEY)}&foo=bar` },
      );
      assertEquals(viaQuery.res.status, 200, "查询串凭据认证");
      const seen = upstream.requests.at(-1)!;
      assert(seen.path.includes("foo=bar"), "其他查询参数必须透传");
      assert(!seen.path.includes("CONTEXT7_API_KEY"), "访问密钥参数不得转发给上游");
    });

    // -------------------------------------------------------------------------
    await t.step("⑩ X-API-Key / X-Context7-API-Key 请求头认证", async () => {
      const viaXApiKey = await mcpPost(
        nodes[0].port,
        { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
        { headers: { "x-api-key": TEST_PROXY_KEY } },
      );
      assertEquals(viaXApiKey.res.status, 200, "X-API-Key 认证");

      const viaXContext7 = await mcpPost(
        nodes[0].port,
        { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
        { headers: { "x-context7-api-key": TEST_PROXY_KEY } },
      );
      assertEquals(viaXContext7.res.status, 200, "X-Context7-API-Key 认证");
    });

    // -------------------------------------------------------------------------
    await t.step("⑪ SSE 流式透传:分块到达,代理不缓冲", async () => {
      upstream.setBehavior("delayed-sse");
      const res = await fetch(mcpEndpoint(nodes[1].port), {
        method: "POST",
        headers: {
          ...AUTH,
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "query-docs", arguments: { libraryId: "/demo/lib", query: "q" } },
        }),
      });
      assertEquals(res.status, 200, "流式响应状态码");

      const chunks: { text: string; at: number }[] = [];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const startedAt = performance.now();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push({ text: decoder.decode(value), at: performance.now() - startedAt });
      }
      upstream.setBehavior("normal");

      const received = chunks.map((chunk) => chunk.text).join("");
      const events = sseEvents(received);
      assertEquals(events.length, 3, "应收到 3 个 SSE 事件");
      const span = chunks[chunks.length - 1].at - chunks[0].at;
      assert(
        span >= 200,
        `事件应分块到达(实测跨度 ${span.toFixed(0)}ms,期望 ≥200ms),证明代理未缓冲`,
      );
      assert(received.indexOf("chunk-1") < received.indexOf("chunk-2"), "事件顺序 1→2");
      assert(received.indexOf("chunk-2") < received.indexOf("chunk-3"), "事件顺序 2→3");
    });

    // -------------------------------------------------------------------------
    await t.step("⑫ 大响应体(1MB+)完整透传", async () => {
      upstream.setBehavior("big");
      const big = await mcpPost(
        nodes[2].port,
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "query-docs", arguments: { libraryId: "/big/lib", query: "q" } },
        },
        { headers: AUTH },
      );
      upstream.setBehavior("normal");
      assertEquals(big.res.status, 200, "大响应状态码");
      const content = (asRecord(asRecord(big.events[0]).result).content as Array<
        Record<string, unknown>
      >)[0];
      const text = String(content.text ?? "");
      assert(text.length > 1024 * 1024, `1MB 负载完整到达(实际 ${text.length} 字符)`);
      assertStringIncludes(text, "BIG_PAYLOAD_MARKER", "负载标记完整");
    });

    // -------------------------------------------------------------------------
    await t.step("⑬ 上游 gzip 压缩响应:客户端收到正确明文", async () => {
      upstream.setBehavior("gzip");
      const gz = await mcpPost(
        nodes[0].port,
        { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
        { headers: AUTH },
      );
      upstream.setBehavior("normal");
      assertEquals(gz.res.status, 200, "gzip 响应状态码");
      assertEquals(gz.res.headers.get("content-encoding"), null, "解压后不应保留 content-encoding");
      assertStringIncludes(gz.text, "gzip-ok", "gzip 响应体正确解压");
    });

    // -------------------------------------------------------------------------
    await t.step("⑭ 上游错误(500)状态码、响应体与响应头透传", async () => {
      upstream.setBehavior("error-500");
      const err = await mcpPost(
        nodes[1].port,
        { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
        { headers: AUTH },
      );
      upstream.setBehavior("normal");
      assertEquals(err.res.status, 500, "上游错误状态码透传");
      assertStringIncludes(err.text, "boom", "上游错误响应体透传");
      assertEquals(err.res.headers.get("x-fake-upstream"), "error-500", "错误响应头透传");
    });

    // -------------------------------------------------------------------------
    await t.step("⑮ 方法语义:GET/DELETE 透传 405;无凭据一律 401", async () => {
      const getAuthed = await fetch(mcpEndpoint(nodes[0].port), {
        method: "GET",
        headers: AUTH,
      });
      assertEquals(getAuthed.status, 405, "GET 应透传上游 405");
      const getBody = await getAuthed.text();
      assertStringIncludes(getBody, "Method not allowed", "405 错误体透传");
      assertStringIncludes(getBody, "-32000", "JSON-RPC 错误码透传");

      const delAuthed = await fetch(mcpEndpoint(nodes[0].port), {
        method: "DELETE",
        headers: AUTH,
      });
      assertEquals(delAuthed.status, 405, "DELETE 应透传上游 405");
      await delAuthed.text();

      const getAnon = await fetch(mcpEndpoint(nodes[0].port), { method: "GET" });
      assertEquals(getAnon.status, 401, "无凭据的 GET 必须 401");
      const anonBody = await getAnon.text();
      assert(!anonBody.includes(TEST_PROXY_KEY), "错误响应不得回显访问密钥");
      assert(!anonBody.includes(TEST_UPSTREAM_KEY), "错误响应不得回显上游密钥");
    });

    // -------------------------------------------------------------------------
    await t.step("⑯ 分布式:跨 3 个节点交替完成多轮请求", async () => {
      upstream.reset();
      const r1 = await mcpPost(nodes[0].port, initPayload(21), { headers: AUTH });
      const r2 = await mcpPost(
        nodes[1].port,
        { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} },
        { headers: AUTH },
      );
      const r3 = await mcpPost(
        nodes[2].port,
        {
          jsonrpc: "2.0",
          id: 23,
          method: "tools/call",
          params: { name: "resolve-library-id", arguments: { libraryName: "Vue", query: "q" } },
        },
        { headers: AUTH },
      );
      assertEquals(r1.res.status, 200, "节点 1");
      assertEquals(r2.res.status, 200, "节点 2");
      assertEquals(r3.res.status, 200, "节点 3");
      assertEquals(upstream.requests.length, 3, "3 个节点各自独立访问上游");
    });

    // -------------------------------------------------------------------------
    await t.step("⑰ 并发 30 请求跨节点全部成功", async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          mcpPost(
            nodes[index % nodes.length].port,
            { jsonrpc: "2.0", id: 100 + index, method: "tools/list", params: {} },
            { headers: AUTH },
          )),
      );
      assert(
        results.every((result) => result.res.status === 200),
        "全部并发请求成功",
      );
      assert(
        results.every((result) => result.events.length === 1),
        "每个响应均为完整 SSE 事件",
      );
    });

    // -------------------------------------------------------------------------
    await t.step("⑱ 节点故障迁移:杀掉一个节点后其余节点继续服务", async () => {
      const victim = nodes.pop()!;
      victim.child.kill("SIGKILL");
      await victim.child.status;

      const r1 = await mcpPost(nodes[0].port, initPayload(31), { headers: AUTH });
      const r2 = await mcpPost(nodes[1].port, initPayload(32), { headers: AUTH });
      assertEquals(r1.res.status, 200, "剩余节点 1 服务正常");
      assertEquals(r2.res.status, 200, "剩余节点 2 服务正常");
    });

    // -------------------------------------------------------------------------
    await t.step("⑲ 未配置 CONTEXT7_API_KEY 的节点返回 500(不回显密钥)", async () => {
      const badNode = await startNode({
        label: "node-nokey",
        port: await freePort(),
        upstreamBase: upstream.url,
        env: { PROXY_API_KEY: TEST_PROXY_KEY, CONTEXT7_API_KEY: "" },
      });
      nodes.push(badNode);

      const res = await mcpPost(badNode.port, initPayload(41), { headers: AUTH });
      assertEquals(res.res.status, 500, "配置缺失应 fail closed");
      assertStringIncludes(res.text, "not configured", "配置错误提示");
      assert(!res.text.includes(TEST_PROXY_KEY), "不得回显访问密钥");
      assert(!res.text.includes(TEST_UPSTREAM_KEY), "不得回显上游密钥");
    });

    // -------------------------------------------------------------------------
    await t.step("⑳ 自带探活 GET /health:带凭据 200 + ok,不触达上游", async () => {
      const before = upstream.requests.length;
      assert(before > 0, "探活前上游应已收到过请求");
      const ok = await fetch(mcpEndpoint(nodes[0].port) + "/health", {
        method: "GET",
        headers: AUTH,
      });
      assertEquals(ok.status, 200, "探活状态码");
      const body = await ok.text();
      assertStringIncludes(body, '"ok":true', "探活响应体");
      assertStringIncludes(body, "context7-proxy", "探活服务名");
      assertEquals(upstream.requests.length, before, "探活不得触达上游");

      const anon = await fetch(mcpEndpoint(nodes[0].port) + "/health", {
        method: "GET",
      });
      assertEquals(anon.status, 401, "无凭据探活必须 401");
      await anon.text();
      assertEquals(upstream.requests.length, before, "未授权探活不得触达上游");
    });

    // -------------------------------------------------------------------------
    await t.step("⑳之一 路径兼容:剥离前缀/尾斜杠形态同样识别探活与透传", async () => {
      // 直接调用生产 handler(不经假节点 HTTP 层),模拟 Edge Runtime 已剥离函数前缀的形态。
      const { createHandler } = await import("../supabase/functions/context7-proxy/proxy.ts");
      const handler = createHandler({
        getProxyApiKey: () => TEST_PROXY_KEY,
        getContext7ApiKey: () => TEST_UPSTREAM_KEY,
      });
      const withAuth = { authorization: `Bearer ${TEST_PROXY_KEY}` };

      // 剥离前缀后的 /health 应直接 200(不触达上游)。
      const before = upstream.requests.length;
      const stripped = await handler(
        new Request("http://localhost/health", { method: "GET", headers: withAuth }),
      );
      assertEquals(stripped.status, 200, "剥离前缀 /health 应 200");
      assertStringIncludes(await stripped.text(), '"ok":true', "剥离前缀探活响应体");
      assertEquals(upstream.requests.length, before, "剥离前缀探活不得触达上游");

      // 尾斜杠形态同样识别。
      const trailing = await handler(
        new Request("http://localhost/functions/v1/context7-proxy/health/", {
          method: "GET",
          headers: withAuth,
        }),
      );
      assertEquals(trailing.status, 200, "尾斜杠探活应 200");
      await trailing.text();

      // 路径映射:剥离前缀的根路径应落到上游 /mcp(透传语义不变)。
      const { mapPathToUpstream } = await import(
        "../supabase/functions/context7-proxy/proxy.ts"
      );
      assertEquals(mapPathToUpstream("/"), "/mcp", "剥离前缀根路径映射");
      assertEquals(
        mapPathToUpstream("/functions/v1/context7-proxy"),
        "/mcp",
        "全路径根映射",
      );
      assertEquals(mapPathToUpstream("/health"), "/mcp", "探活路径不转发上游");
      assertEquals(
        mapPathToUpstream("/v1/functions/context7-proxy/health"),
        "/mcp",
        "未知网关前缀后缀兜底",
      );
    });

    // -------------------------------------------------------------------------
    await t.step("㉑ 安全汇总:上游收到的全部请求中均无访问密钥", () => {
      assert(upstream.requests.length > 0, "上游应收到过请求");
      for (const record of upstream.requests) {
        assert(
          !record.path.includes(TEST_PROXY_KEY),
          `请求路径不得包含访问密钥: ${record.path}`,
        );
        assert(
          !record.bodyText.includes(TEST_PROXY_KEY),
          "请求体不得包含访问密钥",
        );
        assert(
          !record.headers.some(([, value]) => value.includes(TEST_PROXY_KEY)),
          "请求头不得包含访问密钥",
        );
      }
    });
  } finally {
    await stopNodes(nodes);
    await upstream.stop();
  }
});

/** 供人工排查:打印上游收到的请求概览(已脱敏)。 */
export function summarize(records: RecordedRequest[]): string[] {
  return records.map((record) =>
    `${record.method} ${record.path} (${
      record.headers.find(([name]) => name.toLowerCase() === "authorization")
        ? "authorization=present"
        : "authorization=none"
    })`
  );
}

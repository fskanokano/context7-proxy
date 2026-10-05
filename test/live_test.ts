// =============================================================================
// 真实上游联调测试(会访问网络:https://mcp.context7.com/mcp)
// =============================================================================
//
// 运行方式(推荐,自动从用户环境变量注入 CONTEXT7_API_KEY,值不会被打印):
//   powershell -NoProfile -ExecutionPolicy Bypass -File test/run_live.ps1
// 或本 shell 已设置 CONTEXT7_API_KEY 时:
//   deno test -A --no-check test/live_test.ts
//
// 说明:
//   - CONTEXT7_API_KEY 缺失时使用占位值运行;真实上游对无效/缺失密钥会降级为匿名
//     (较低速率限制),因此仍可验证“客户端 → 本代理 → 真实 Context7 → 真实数据”全链路。
//   - 本测试只读取该环境变量的“是否存在”,从不打印其值。

import { assert, assertEquals, assertStringIncludes } from "./asserts.ts";
import {
  asRecord,
  freePort,
  mcpEndpoint,
  mcpPost,
  type NodeHandle,
  startNode,
  stopNodes,
} from "./harness.ts";

const LIVE_PROXY_KEY = "ctx7-proxy-live-test-key-0002";
const UPSTREAM_ENDPOINT = "https://mcp.context7.com/mcp";
const HAS_REAL_KEY = Boolean(Deno.env.get("CONTEXT7_API_KEY"));
const UPSTREAM_KEY = Deno.env.get("CONTEXT7_API_KEY") ??
  "ctx7-placeholder-key-for-anonymous-live-test";

const AUTH = { authorization: `Bearer ${LIVE_PROXY_KEY}` };

function initPayload(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "context7-proxy-live", version: "0.0.1" },
    },
  };
}

async function directUpstreamPost(payload: unknown): Promise<{ res: Response; text: string }> {
  const res = await fetch(UPSTREAM_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  return { res, text: await res.text() };
}

Deno.test({
  name: "LIVE:通过本代理访问真实 Context7 上游(全链路联调)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  console.log(
    `开始真实上游联调(CONTEXT7_API_KEY 使用真实值:${HAS_REAL_KEY ? "是" : "否,将降级匿名"})\n`,
  );

  const nodes: NodeHandle[] = [];
  const spawn = async (label: string) => {
    const node = await startNode({
      label,
      port: await freePort(),
      // 不设置 FAKE_UPSTREAM_BASE:节点直连真实上游
      env: {
        PROXY_API_KEY: LIVE_PROXY_KEY,
        CONTEXT7_API_KEY: UPSTREAM_KEY,
      },
    });
    nodes.push(node);
    return node;
  };

  try {
    await t.step("① 启动 2 个节点(模拟分布式部署)", async () => {
      await spawn("live-node1");
      await spawn("live-node2");
      assertEquals(nodes.length, 2, "节点就绪");
    });

    await t.step("② 通过代理 initialize:返回真实 Context7 服务信息", async () => {
      const init = await mcpPost(nodes[0].port, initPayload(1), { headers: AUTH });
      assertEquals(init.res.status, 200, "initialize 状态码");
      const result = asRecord(asRecord(init.events[0]).result);
      assertEquals(asRecord(result.serverInfo).name, "Context7", "serverInfo.name");
      assert(
        typeof result.protocolVersion === "string" && result.protocolVersion.length > 0,
        "应返回协议版本",
      );
    });

    await t.step("③ 通过代理 tools/list:真实工具清单(节点 2)", async () => {
      const list = await mcpPost(
        nodes[1].port,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { headers: AUTH },
      );
      assertEquals(list.res.status, 200, "tools/list 状态码");
      const tools = (asRecord(asRecord(list.events[0]).result).tools as Array<{ name: string }>)
        .map((tool) => tool.name);
      assert(tools.includes("resolve-library-id"), "应包含 resolve-library-id 工具");
      assert(tools.includes("query-docs"), "应包含 query-docs 工具");
    });

    await t.step("④ 通过代理调用真实工具 resolve-library-id 并取得真实数据", async () => {
      const call = await mcpPost(
        nodes[0].port,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "resolve-library-id",
            arguments: { libraryName: "Next.js", query: "middleware authentication" },
          },
        },
        { headers: AUTH },
      );
      assertEquals(call.res.status, 200, "tools/call 状态码");
      const content = (asRecord(asRecord(call.events[0]).result).content as Array<
        Record<string, unknown>
      >)[0];
      const text = String(content?.text ?? "");
      assertStringIncludes(text, "/vercel/next.js", "应返回真实的 Context7 库 ID");
    });

    await t.step("⑤ 一致性对比:直接访问上游与经代理访问结果一致", async () => {
      // 直连上游(匿名)与经代理(替换为 CONTEXT7_API_KEY)的响应对比
      const direct = await directUpstreamPost(initPayload(4));
      const directResult = asRecord(
        JSON.parse(
          direct.text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim() ??
            "{}",
        ).result,
      );
      const directServerName = asRecord(directResult.serverInfo).name;
      const directProtocol = directResult.protocolVersion;

      const viaProxy = await mcpPost(nodes[0].port, initPayload(5), { headers: AUTH });
      const proxyResult = asRecord(asRecord(viaProxy.events[0]).result);

      assertEquals(
        asRecord(proxyResult.serverInfo).name,
        directServerName,
        "serverInfo.name 应与直连一致",
      );
      assertEquals(proxyResult.protocolVersion, directProtocol, "协议版本应与直连一致");
    });

    await t.step("⑥ 分布式:同一轮交互跨节点交替请求", async () => {
      const r1 = await mcpPost(nodes[0].port, initPayload(6), { headers: AUTH });
      const r2 = await mcpPost(
        nodes[1].port,
        { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
        { headers: AUTH },
      );
      const r3 = await mcpPost(
        nodes[0].port,
        { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} },
        { headers: AUTH },
      );
      assertEquals(r1.res.status, 200, "节点 1 initialize");
      assertEquals(r2.res.status, 200, "节点 2 tools/list");
      assertEquals(r3.res.status, 200, "节点 1 tools/list");
    });

    await t.step("⑦ 访问控制:本代理要求 PROXY_API_KEY(与直连上游的差异)", async () => {
      const noKey = await mcpPost(nodes[0].port, initPayload(9));
      assertEquals(noKey.res.status, 401, "无凭据必须 401");
    });

    await t.step("⑧ 自带探活 GET /health:带凭据 200 + ok(不耗上游配额)", async () => {
      const ok = await fetch(mcpEndpoint(nodes[0].port) + "/health", {
        method: "GET",
        headers: AUTH,
      });
      assertEquals(ok.status, 200, "探活状态码");
      const body = await ok.text();
      assertStringIncludes(body, '"ok":true', "探活响应体");
      assertStringIncludes(body, "context7-proxy", "探活服务名");

      const anon = await fetch(mcpEndpoint(nodes[0].port) + "/health", {
        method: "GET",
      });
      assertEquals(anon.status, 401, "无凭据探活必须 401");
      await anon.text();
    });

    await t.step("⑨ 上游密钥有效性:直调官方 REST 接口(401=无效,200=有效)", async () => {
      // MCP 透传无法区分上游密钥真假(initialize 对匿名也 200),因此用官方
      // REST 接口 `GET /api/v2/libs/search` 验证:有效=200,无效=401 invalid_api_key。
      // 详见 README“探活与密钥验证”一节。
      const res = await fetch(
        "https://context7.com/api/v2/libs/search?libraryName=react&query=state",
        {
          method: "GET",
          headers: { authorization: `Bearer ${UPSTREAM_KEY}` },
          signal: AbortSignal.timeout(60_000),
        },
      );
      const text = await res.text();
      if (HAS_REAL_KEY) {
        assertEquals(res.status, 200, "真实上游密钥应有效(200)");
      } else {
        assert(
          res.status === 200 || res.status === 401,
          `占位密钥只允许 200(匿名)或 401(无效),实际 ${res.status}: ${text.slice(0, 200)}`,
        );
        console.log(`占位密钥 REST 验证结果:HTTP=${res.status}(详见响应体,值已脱敏)`);
      }
    });
  } finally {
    await stopNodes(nodes);
  }
});

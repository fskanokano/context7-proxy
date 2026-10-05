# Context7 MCP 兼容代理(Supabase Edge Functions)

把一个 Supabase Edge Function **伪装成 Context7 远程 MCP 服务**(<https://github.com/upstash/context7>)。

对 MCP 客户端而言,它的行为与 `https://mcp.context7.com/mcp` **完全一致**:相同的 JSON-RPC 方法、SSE 流式响应、CORS 语义、错误结构与状态码,所有请求参数与响应**全部透传**。

唯一的区别是**访问本服务需要 `PROXY_API_KEY`**,而调用上游 Context7 所使用的 `CONTEXT7_API_KEY` 完全由服务端注入,客户端永远接触不到上游密钥。

```
MCP 客户端 ──(Authorization: Bearer <PROXY_API_KEY>)──▶ 本代理 ──(Authorization: Bearer <CONTEXT7_API_KEY>)──▶ https://mcp.context7.com/mcp
```

| secret 名称          | 用途                                     | 谁能看到                     |
| -------------------- | ---------------------------------------- | ---------------------------- |
| `PROXY_API_KEY`      | 客户端访问**本服务**时使用的密钥         | 你自己 / 你的客户端          |
| `CONTEXT7_API_KEY`   | 本服务访问**上游 Context7** 时使用的密钥 | 仅服务端(`Deno.env.get`)    |

两个值都只存在于环境变量/secret 中,仓库内不含任何明文,日志与响应也永不回显。

---

## 一、行为对齐清单(与真实 Context7 的实测比对)

以下行为均以真实上游 `https://mcp.context7.com/mcp` 实测为准,代理逐一复刻:

| 场景                        | 真实 Context7                                | 本代理                                             |
| --------------------------- | -------------------------------------------- | -------------------------------------------------- |
| `POST` JSON-RPC 请求        | `200`,`text/event-stream`(SSE)               | 完全透传(状态码、响应头、流式响应体)               |
| `initialize` 返回           | `serverInfo.name = "Context7"`               | 原样返回(与直连逐字段一致)                         |
| `tools/list` 工具清单       | `resolve-library-id`、`query-docs`           | 原样返回(与直连一致)                               |
| 通知(JSON-RPC 无 `id`)     | `202` 空响应体                               | 完全透传                                           |
| `OPTIONS` 预检              | `200` + `OK`                                 | 一致(不校验凭据)                                   |
| `GET` / `DELETE`            | `405` + JSON-RPC `-32000` 错误               | 完全透传                                           |
| CORS 头                     | `*` / `GET,POST,OPTIONS,DELETE` / 固定列表    | 与上游完全一致的响应头                             |
| 凭据位置(宽进)             | `Authorization`、`X-Context7-API-Key`、`X-API-Key`、`CONTEXT7_API_KEY`、查询串 | 同上(全部支持)                    |
| 无凭据 / 无效凭据           | 降级匿名(仍可 `initialize`/`tools/list`)     | **改为 `401`**(唯一有意的差异,见下)               |

**唯一的差异**:访问本服务必须携带正确的 `PROXY_API_KEY`,否则返回:

```json
{ "jsonrpc": "2.0", "error": { "code": -32001, "message": "Unauthorized: invalid or missing API key." }, "id": null }
```

除此之外,请求与响应的一切(方法、子路径、查询参数、请求头、请求体、状态码、响应头、响应体、SSE 分块节奏)均原样透传。

## 二、目录结构

```
supabase/
  config.toml                    # [functions.mcp] verify_jwt=false;本地 secret 引用
  functions/mcp/
    index.ts                     # Edge Function 入口(export default { fetch })
    proxy.ts                     # 代理核心:认证、透传、CORS、错误、头剥离
    deno.json                    # 零第三方依赖
test/
  e2e_test.ts                    # 20 步确定性全链路测试(离线,3 节点 + 假上游)
  live_test.ts                   # 7 步真实上游联调测试(访问网络)
  fake_node.ts                   # 假的 Supabase Edge Functions 节点(加载生产入口)
  fake_upstream.ts               # 假的 Context7 上游(SSE/大响应/gzip/错误/请求记录)
  harness.ts                     # 测试工具(子进程、端口、SSE 解析)
  run_live.ps1                   # Windows:从环境变量注入 CONTEXT7_API_KEY 后跑联调(不打印值)
  diag_env.ps1                   # 环境变量存在性诊断(只打印作用域与长度,绝不打印值)
deno.json                        # deno task:test / test:live / check / fmt / lint
```

## 三、部署(使用 supabase CLI)

### 1. 前置条件

- 已安装 Supabase CLI(本项目在 `2.114.0` 下开发与验证)。
- 已 `supabase login`(或设置 `SUPABASE_ACCESS_TOKEN`)。

### 2. 关联项目

```bash
supabase link --project-ref <PROJECT_REF>
```

### 3. 写入两个 secret

```bash
supabase secrets set PROXY_API_KEY=<你自己设定的访问密钥> CONTEXT7_API_KEY=<你的 Context7 API Key>
```

或从未提交的 `.env` 文件批量导入(该文件已被 `.gitignore` 拦截):

```bash
supabase secrets set --env-file .env
```

> 说明:CLI 只能**覆盖**secret,无法读回已设置的值;`supabase secrets list` 仅显示摘要哈希。

### 4. 部署函数

```bash
supabase functions deploy mcp --use-api
```

- `--use-api` 表示**服务端打包,不需要本机 Docker**(本机未运行 Docker 时可用)。
- 本仓库 `supabase/config.toml` 中已声明 `[functions.mcp] verify_jwt = false`:函数是公开端点,由代理自己校验 `PROXY_API_KEY`。因此**无需** `--no-verify-jwt`。
- 若本机 Docker 可用,也可直接 `supabase functions deploy mcp`。

部署完成后端点为:

```
https://<PROJECT_REF>.supabase.co/functions/v1/mcp
```

## 四、配置 MCP 客户端

把客户端指向上面的 URL,并携带 `PROXY_API_KEY`。以下三种写法等价:

1. 请求头 `Authorization: Bearer <PROXY_API_KEY>`(推荐)
2. 请求头 `X-API-Key: <PROXY_API_KEY>` 或 `X-Context7-API-Key: <PROXY_API_KEY>`(兼容只支持自定义头的客户端)
3. 查询串 `?CONTEXT7_API_KEY=<PROXY_API_KEY>`(该参数不会转发给上游)

通用 JSON(例如 Cursor / Claude Desktop 风格的 `mcpServers`):

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://<PROJECT_REF>.supabase.co/functions/v1/mcp",
      "headers": { "Authorization": "Bearer <PROXY_API_KEY>" }
    }
  }
}
```

> 客户端配置字段名因客户端而异,以各客户端官方文档为准;本服务对上述三种凭据传递方式均支持。

## 五、本地开发

### 方式 A:本仓库自带的等价全链路测试(不需要 Docker)

本仓库内置了一个「假的 Supabase Edge Functions 节点」(`test/fake_node.ts`):它以独立进程加载**与部署完全相同的生产入口** `supabase/functions/mcp/index.ts`,并注入测试 secret;`test/fake_upstream.ts` 则扮演假的 Context7 上游。

```bash
deno task test        # 20 步确定性全链路测试(离线,约 2 秒)
deno task test:live   # 7 步真实上游联调测试(需网络;shell 已设 CONTEXT7_API_KEY 时可用)
deno task serve:fake  # 手动起一个假节点:deno run -A test/fake_node.ts 18080
```

Windows 下推荐用包装脚本注入密钥(值不会被打印):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test/run_live.ps1
```

> `test/run_live.ps1` 会依次从 **进程 → 用户(HKCU) → 机器(HKLM)** 作用域查找 `CONTEXT7_API_KEY`,找到即注入;若均不存在,则提示并以占位值运行(上游会降级匿名)。

手动验证示例:

```bash
deno task serve:fake                     # 需要先设置 PROXY_API_KEY / CONTEXT7_API_KEY 环境变量
curl -i -X POST http://127.0.0.1:18080/functions/v1/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer <PROXY_API_KEY>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

### 方式 B:真实本地栈(需要 Docker)

```bash
supabase start
supabase functions serve mcp
```

`supabase/config.toml` 的 `[edge_runtime.secrets]` 已配置为直接引用本机环境变量:

```toml
[edge_runtime.secrets]
PROXY_API_KEY = "env(PROXY_API_KEY)"
CONTEXT7_API_KEY = "env(CONTEXT7_API_KEY)"
```

因此只要当前 shell 里存在这两个变量,本地函数就能取到(也可用 `supabase functions serve mcp --env-file .env` 显式指定)。

### 类型检查与格式

```bash
deno task check   # deno check 生产代码 + 测试
deno task fmt     # deno fmt
deno task lint    # deno lint
```

## 六、分布式 / 多节点部署

本服务**完全无状态**:

- 不在任何节点保存会话、缓存或计数器;MCP 的 `MCP-Session-Id`、`MCP-Protocol-Version` 等协议头**原样透传**给上游;
- 因此负载均衡**不需要粘性会话**,任意请求落到任意节点结果都相同;
- 每个节点只需配置相同的两个 secret 即可,无需任何节点间通信。

多节点时,把负载均衡器(或 DNS 轮询、多项目/多区域部署)指向各节点:
`https://<每个部署>.supabase.co/functions/v1/mcp`。

## 七、安全性

- **密钥不落日志**:访问日志只记录 `方法 / 路径 / 状态码 / 耗时`,路径不含查询串(查询串可能携带凭据);异常日志只记录错误消息本身;
- **密钥不回显**:所有本地生成的错误响应均为固定文案,不含任何 secret 内容;
- **恒定时间比较**:`PROXY_API_KEY` 校验使用逐字节定时安全比较,避免时序侧信道;
- **凭据剥离**:客户端携带的 `Authorization`、`X-API-Key`、`X-Context7-API-Key` 等头在转发前一律移除,统一替换为服务端的 `CONTEXT7_API_KEY`;`PROXY_API_KEY` **绝不会**流向上游;
- **fail-closed**:任一 secret 缺失时直接返回 `500`(提示配置错误),不会以匿名身份访问上游;
- `.gitignore` 已拦截 `.env`、`supabase/functions/.env` 等一切可能承载密钥的文件。

## 八、端点契约(简要)

| 方法      | 行为                                                             |
| --------- | ---------------------------------------------------------------- |
| `OPTIONS` | `200` + `OK` + CORS 头(不校验凭据)                               |
| `POST`    | 校验 `PROXY_API_KEY` → 透传上游;通知返回 `202`;正文与头部全部透传 |
| `GET` / `DELETE` | 校验凭据后透传上游(上游返回 `405` JSON-RPC 错误)          |
| 其他任何方法 | 同上游语义透传                                                |

路由映射:网关路径 `/functions/v1/mcp` → 上游 `/mcp`;`/functions/v1/mcp/<子路径>` → `/mcp/<子路径>`(保留未来扩展路径)。

## 九、验证情况与已知限制

**已验证(本机实测)**

- `deno task test`:20 步确定性全链路测试全部通过,覆盖:3 节点分布式、CORS 预检、凭据校验(缺/错凭据 401 且不触达上游)、initialize/tools/list/tools/call、请求头与请求体透传保真、通知 202、查询串凭据与参数剥离、多凭据位置、SSE 分块到达(跨度 ≥200ms,证明不缓冲)、1MB 大响应、gzip 正确解压、上游 500 透传、GET/DELETE 405、跨节点交替请求、30 并发、节点故障迁移、缺 secret 时 fail-closed、安全汇总(上游收到的全部请求中均无访问密钥)。
- `deno task test:live`:7 步真实上游联调全部通过,覆盖:真实 `initialize`(serverInfo 为 Context7)、真实工具清单、通过代理调用真实工具并取得真实数据(`resolve-library-id` → `/vercel/next.js`)、与直连上游结果一致性对比、跨节点、无凭据 401。
- `deno check`、`deno lint`、`deno fmt` 全部干净。

**已知限制 / 未验证项**

- 本仓库**尚未 `link` 到真实 Supabase 项目**,因此真实云端部署与 `--use-api` 服务端打包流程未实测;部署命令与配置均按 Supabase CLI `2.114.0` 的 `--help` 与官方文档编写。
- 本机 Docker 未运行,`supabase start` / `supabase functions serve` 真栈未实测;已用「假节点加载同一生产入口」的方式做等价全链路验证。
- 代理向上游发起的 `fetch` **刻意不传递 `request.signal`**:Deno 的 legacy abort 语义会在「响应成功完成」时 abort `request.signal`(而 Supabase Edge Runtime 不支持 `--unstable-no-legacy-abort` 切换),若透传该信号,流式响应在收尾时可能被提前中断。客户端真实断开时,响应体的取消仍会沿流传播并中止上游读取。

## 十、参考

- Context7 仓库:<https://github.com/upstash/context7>
- Context7 远程 MCP 端点:`https://mcp.context7.com/mcp`
- Supabase Edge Functions 文档:<https://supabase.com/docs/guides/functions>
- Supabase 本地开发配置:<https://supabase.com/docs/guides/local-development/cli/config>

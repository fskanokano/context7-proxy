// =============================================================================
// Supabase Edge Function 入口(mcp)
// =============================================================================
//
// 形态与官方最新模板一致(`export default { fetch }`),由 Supabase Edge Runtime 调用。
//
// 部署所需的两个 secret(通过 `supabase secrets set` 设置):
//   - PROXY_API_KEY    访问本服务的 API Key(客户端凭此调用本服务)
//   - CONTEXT7_API_KEY 本服务调用上游 Context7 时使用的 API Key
//
// 代码中仅通过 `Deno.env.get` 引用上述变量,仓库内不存在任何密钥明文,
// 也不会将密钥写入日志或响应。

import { createHandler } from "./proxy.ts";

export default {
  fetch: createHandler({
    getProxyApiKey: () => Deno.env.get("PROXY_API_KEY"),
    getContext7ApiKey: () => Deno.env.get("CONTEXT7_API_KEY"),
  }),
};

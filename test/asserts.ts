// =============================================================================
// 轻量断言工具(仅用于测试;避免对外部依赖)
// =============================================================================

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`断言失败: ${message}`);
  }
}

export function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`断言失败: ${message}\n  实际: ${a}\n  期望: ${e}`);
  }
}

export function assertStringIncludes(
  haystack: string,
  needle: string,
  message = "",
): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `断言失败: ${message}\n  未找到: ${needle}\n  实际内容(前 400 字符): ${
        haystack.slice(0, 400)
      }`,
    );
  }
}

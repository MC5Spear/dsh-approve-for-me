import { rmSync } from 'node:fs';

/**
 * 递归删除测试临时目录；Windows 删除竞态（ENOTEMPTY/EPERM/EBUSY）时同步退避重试。
 * 收尾清理常与防病毒/索引器竞速——同目录刚写入的文件被短暂占用，单次失败不代表真删不掉；
 * 重试仍失败时最后一次不再捕获，让测试按真实失败变红。
 * @param {string} dir - 目标目录。
 * @returns {void}
 */
export function rmTree(dir) {
  const RETRYABLE = new Set(['ENOTEMPTY', 'EPERM', 'EBUSY']);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE.has(error?.code)) throw error;
      // 同步退避（Atomics.wait）：测试收尾处无异步上下文可用。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

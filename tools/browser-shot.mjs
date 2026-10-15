/**
 * dsh-approve-for-me — 真实浏览器截图/交互探针（Edge headless + CDP）。
 *
 * 为什么需要它：设置卡片、composer 下拉、审批卡片的实际渲染（宽度、换行、遮挡、折叠形态）
 * 靠读代码看不出来，必须看真实页面。本工具用系统自带 Edge 的 DevTools 协议驱动，
 * 不下载浏览器、不装依赖（Node 24 自带全局 WebSocket 与 fetch）。
 *
 * 用法（都在仓库根目录跑；--url/--token-file/--out 省略时取本机配置，见 tools/local-config.example.mjs）：
 *   node tools/browser-shot.mjs --dump                     # 只导出现有页面的文本与可点击元素
 *   node tools/browser-shot.mjs ... --script steps.json        # 按脚本执行点击与截图
 *
 * 步骤脚本是一组动作（与下方分派实现逐一对齐；**`click` 传纯字符串**——
 * 它被原样交给 `clickText(text)` 做文本比较，写成 `{"click":{"text":"…"}}` 对象形式
 * 会永远匹配失败返回 not found）：
 * `{"click":"插件"}`（按可见文本精确匹配，取最近的 button/a/li/[role] 祖先点击）、
 * `{"clickSelector":".dsafm_helpbtn"}`、`{"send":"文本"}`（写入 composer）、
 * `{"enter":true}`（composer 派发回车）、`{"clickSend":true}`（点发送按钮）、
 * `{"scroll":".dialog-scroll"}`（选择器最内层可滚动祖先滚到底）、
 * `{"shot":"card-collapsed"}`、`{"shotClip":"选择器"}`（元素级裁切截图）、
 * `{"wait":800}`、`{"dump":true}`、`{"eval":"document.title"}`。
 * 每步失败只记录不中断，最后打印一份结果表。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserPath, instance, missingNotice, outputDir } from './local-config.mjs';

/**
 * CDP 端口：spawn 模式下随机取（固定端口会被上一次没杀干净的 headless Edge 占住，
 * 于是 CDP 连到旧浏览器、`Page.navigate` 挂死）；--cdp 附加模式下改写为指定端口。
 */
let PORT = 9333 + Math.floor(Math.random() * 200);

/**
 * 解析命令行参数（默认值经本机配置加载器取：显式传参 > 配置 > 文档化跳过）。
 * @returns {Promise<object>} 选项。
 */
async function options() {
  const argv = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  const flags = new Set(argv.filter((value) => value.startsWith('--') && !value.includes('=')));
  const target = await instance();
  return {
    url: read('--url', target?.url ?? ''),
    tokenFile: read('--token-file', target?.tokenFile ?? ''),
    out: read('--out', (await outputDir()) ?? 'shots'),
    script: read('--script', ''),
    width: Number(read('--width', '1280')),
    height: Number(read('--height', '1600')),
    budget: Number(read('--budget', '150000')),
    dump: flags.has('--dump'),
    keep: flags.has('--keep'),
    result: read('--result', ''),
    cdp: read('--cdp', ''),
  };
}

/** 读启动 token；没有 token 文件时返回空串（实例已在 cookie 里时不需要）。 */
function launchToken(file) {
  if (!existsSync(file)) return '';
  const match = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(file, 'utf8'));
  return match === null ? '' : match[1];
}

/** 等待若干毫秒。 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 轮询 `GET /json/version` 直到 CDP 端口可用。 */
async function waitForCdp(budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // 还没起来。
    }
    await sleep(200);
  }
  throw new Error('CDP 端口未在预算内就绪');
}

/**
 * 极简 CDP 会话：Node 自带 WebSocket，不需要 puppeteer。
 */
class Session {
  /** @param {string} url - 页面 target 的 webSocketDebuggerUrl。 */
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    /**
     * 页面控制台与未捕获异常（`Runtime.consoleAPICalled` / `Runtime.exceptionThrown`）。
     * 存在理由：客户端插件装载失败时页面静默，只有控制台里有原因。
     */
    this.logs = [];
    this.socket = new WebSocket(url);
    this.ready = new Promise((done, fail) => {
      this.socket.addEventListener('open', () => done());
      this.socket.addEventListener('error', (event) => fail(new Error(`CDP 连接失败：${event?.message ?? 'error'}`)));
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {
        if (message.method === 'Runtime.consoleAPICalled') {
          const text = (message.params?.args ?? [])
            .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
            .join(' ')
            // 插件聚合 URL（/plugins/??a,b,c…）动辄上千字符，会把后面的调用栈帧挤出版面——折叠成标记。
            .replace(/https?:\/\/[^)\s]+\/plugins\/\?\?[^)\s]+/gu, '<plugins-bundle>');
          this.logs.push({ kind: message.params?.type ?? 'log', text: String(text) });
        } else if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params?.exceptionDetails;
          const text = details?.exception?.description ?? details?.text ?? 'unknown exception';
          this.logs.push({ kind: 'exception', text: String(text) });
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.fail(new Error(`${entry.method}: ${message.error.message}`));
      else entry.done(message.result);
    });
  }

  /**
   * 调一个 CDP 方法。
   * @param {string} method - 方法名。
   * @param {object} [params] - 参数。
   * @param {number} [timeoutMs] - 超时；默认 30 s，避免某一步挂死整个探针。
   * @returns {Promise<object>} 结果。
   */
  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return await promise;
  }

  /**
   * 在页面里求值。
   * @param {string} expression - 表达式（可含 await 需自己包 async IIFE）。
   * @returns {Promise<unknown>} 值。
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面求值异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  /** 关闭连接。 */
  close() {
    try {
      this.socket.close();
    } catch {
      // 忽略。
    }
  }
}

/** 页面里执行的辅助函数：文本匹配点击、元素清单。 */
const HELPERS = `
globalThis.__dsafm = {
  byText(text, tag) {
    const nodes = [...document.querySelectorAll(tag || "*")];
    return nodes.filter((node) => (node.textContent || "").trim() === text);
  },
  clickText(text) {
    const exact = this.byText(text);
    const target = exact.find((node) => node.children.length === 0) || exact[0]
      || [...document.querySelectorAll("button,a,li,div,span")].find((node) => (node.textContent || "").includes(text));
    if (!target) return { ok: false, reason: "not found" };
    const clickable = target.closest("button,a,li,[role=menuitem],[role=button]") || target;
    clickable.click();
    return { ok: true, tag: clickable.tagName, cls: clickable.className || "", text: (clickable.textContent || "").slice(0, 60) };
  },
  outline() {
    const rows = [];
    for (const node of document.querySelectorAll("button,a,li,[role=menuitem],[role=button],summary")) {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      rows.push({ tag: node.tagName, cls: String(node.className || "").slice(0, 40), text: text.slice(0, 60) });
    }
    return rows.slice(0, 200);
  },
};
"ok";
`;

/**
 * 主流程。
 * @returns {Promise<void>} 无返回。
 */
async function run() {
  const opts = await options();
  // --cdp <port>：附加模式——沙箱会拦 node 直接 spawn Edge，
  // 由 pwsh 侧先把 headless Edge 拉起来，本工具只连接现成 CDP 端口（不建 profile）。
  let child = null;
  let profile = '';
  const edge = await browserPath();
  if (opts.url === '') {
    process.stdout.write(missingNotice('instance', '真实页面探针需要一个可访问的实例') + '\n');
    return;
  }
  if (opts.cdp !== '') {
    PORT = Number(opts.cdp);
  } else {
    if (edge === undefined) {
      process.stdout.write(missingNotice('browserPath', 'spawn 模式需要真实浏览器可执行文件（--cdp 附加模式不需要）') + '\n');
      return;
    }
    profile = join(tmpdir(), `dsafm-edge-${Date.now()}`);
    mkdirSync(profile, { recursive: true });
    if (!existsSync(edge)) throw new Error(`找不到浏览器：${edge}`);

    child = spawn(
      edge,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-features=msEdgeSidebarV2',
        `--window-size=${opts.width},${opts.height}`,
        'about:blank',
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
  }

  let session;
  try {
    const version = await waitForCdp(20000);
    process.stdout.write(`[browser] Edge ${version.Browser} 已就绪（CDP ${PORT}）\n`);

    const targetResponse = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetResponse.json();
    session = new Session(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // 认证：带 token 访问一次换 cookie，再回到根路径。
    const token = launchToken(opts.tokenFile);
    if (token.length > 0) {
      await session.send('Page.navigate', { url: `${opts.url}/?token=${token}` });
      await sleep(2500);
    }
    await session.send('Page.navigate', { url: `${opts.url}/` });
    await sleep(4000);
    await session.evaluate(HELPERS);

    const outDir = resolve(opts.out);
    mkdirSync(outDir, { recursive: true });
    process.stdout.write(`[browser] 输出目录 ${outDir}\n`);
    const steps = opts.script.length > 0 ? JSON.parse(readFileSync(opts.script, 'utf8').replace(/^\uFEFF/u, '')) : [];
    if (opts.dump) steps.unshift({ dump: true });

    const results = [];
    for (const [index, step] of steps.entries()) {
      process.stdout.write(`[browser] 步骤 ${index}：${JSON.stringify(step).slice(0, 80)}\n`);
      try {
        if (step.wait !== undefined) {
          await sleep(step.wait);
          results.push({ index, step: 'wait', ok: true });
          continue;
        }
        if (step.eval !== undefined) {
          // 直接求值表达式本身；不要 JSON.stringify（那会把源码变成一个字符串字面量）。
          const value = await session.evaluate(`${HELPERS}\n${step.eval}`);
          results.push({ index, step: 'eval', ok: true, value });
          continue;
        }
        if (step.click !== undefined) {
          const value = await session.evaluate(HELPERS + `\nglobalThis.__dsafm.clickText(${JSON.stringify(step.click)})`);
          results.push({ index, step: `click ${step.click}`, ok: value?.ok === true, value });
          continue;
        }
        if (step.clickSelector !== undefined) {
          const value = await session.evaluate(
            `(() => { const node = document.querySelector(${JSON.stringify(step.clickSelector)}); if (!node) return { ok: false }; node.click(); return { ok: true }; })()`,
          );
          results.push({ index, step: `clickSelector ${step.clickSelector}`, ok: value?.ok === true });
          continue;
        }
        if (step.scroll !== undefined) {
          // 把最内层可滚动祖先滚到底（设置对话框自己带滚动容器，滚 window 无效）。
          const value = await session.evaluate(`(() => {
            const start = document.querySelector(${JSON.stringify(step.scroll)}) || document.body;
            let node = start;
            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 8) {
                node.scrollTop = node.scrollHeight;
                return { ok: true, tag: node.tagName, cls: String(node.className || "").slice(0, 60), top: node.scrollTop };
              }
              node = node.parentElement;
            }
            return { ok: false, reason: "no scrollable ancestor" };
          })()`);
          results.push({ index, step: `scroll ${step.scroll}`, ok: value?.ok === true, value });
          continue;
        }
        if (step.dump !== undefined) {
          const outline = await session.evaluate(HELPERS + '\nglobalThis.__dsafm.outline()');
          const text = await session.evaluate('document.body.innerText.slice(0, 3000)');
          process.stdout.write(`[browser] 可点击元素：\n${JSON.stringify(outline, null, 1)}\n`);
          process.stdout.write(`[browser] 页面文本：\n${text}\n`);
          results.push({ index, step: 'dump', ok: true });
          continue;
        }
        if (step.html !== undefined) {
          const html = await session.evaluate('document.body.innerHTML');
          const file = join(outDir, `${step.html}.html`);
          writeFileSync(file, String(html));
          const text = await session.evaluate('document.body.innerText');
          writeFileSync(join(outDir, `${step.html}.txt`), String(text));
          process.stdout.write(`[browser] DOM ${file}（${String(html).length} 字符）／文本 ${join(outDir, `${step.html}.txt`)}\n`);
          results.push({ index, step: `html ${step.html}`, ok: true, file });
          continue;
        }
        if (step.send !== undefined) {
          // 往 composer 里发一条消息：优先 contenteditable（React 受控输入要用原生 setter 触发 input 事件）。
          const value = await session.evaluate(`(() => {
            const text = ${JSON.stringify(step.send)};
            const editor = document.querySelector('[contenteditable="true"]')
              || document.querySelector('textarea');
            if (!editor) return { ok: false, reason: 'no composer' };
            editor.focus();
            if (editor.tagName === 'TEXTAREA') {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              setter.call(editor, text);
              editor.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              editor.textContent = '';
              const range = document.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              const ok = document.execCommand('insertText', false, text);
              if (!ok) {
                editor.textContent = text;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
              }
            }
            return { ok: true, tag: editor.tagName, text: (editor.textContent || editor.value || '').slice(0, 80) };
          })()`);
          results.push({ index, step: `send ${String(step.send).slice(0, 30)}`, ok: value?.ok === true, value });
          continue;
        }
        if (step.enter !== undefined) {
          const value = await session.evaluate(`(() => {
            const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
            if (!editor) return { ok: false, reason: 'no composer' };
            const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            editor.dispatchEvent(new KeyboardEvent('keydown', options));
            editor.dispatchEvent(new KeyboardEvent('keypress', options));
            editor.dispatchEvent(new KeyboardEvent('keyup', options));
            return { ok: true };
          })()`);
          results.push({ index, step: 'enter', ok: value?.ok === true, value });
          continue;
        }
        if (step.clickSend !== undefined) {
          const value = await session.evaluate(`(() => {
            const buttons = [...document.querySelectorAll('button')];
            const hit = buttons.reverse().find((b) => (b.getAttribute('aria-label') || '').includes('发送')
              || (b.getAttribute('title') || '').includes('发送')
              || (b.className || '').toLowerCase().includes('send'));
            if (!hit) return { ok: false, reason: 'no send button' };
            hit.click();
            return { ok: true, cls: String(hit.className).slice(0, 40) };
          })()`);
          results.push({ index, step: 'clickSend', ok: value?.ok === true, value });
          continue;
        }
        if (step.shot !== undefined) {
          const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          const file = join(outDir, `${step.shot}.png`);
          writeFileSync(file, Buffer.from(shot.data, 'base64'));
          process.stdout.write(`[browser] 截图 ${file}\n`);
          results.push({ index, step: `shot ${step.shot}`, ok: true, file });
          continue;
        }
        if (step.shotClip !== undefined) {
          /**
           * 元素级裁切截图 + 可见性探针。
           * 存在理由：`Page.captureScreenshot` 带 `captureBeyondViewport` 时**不绘制固定定位覆盖层**
           * （实测：审批卡在 DOM 里、读数正常，全页截图却拍不到卡片），
           * 因此判"卡片是否真的渲染"必须同时量 rect / 计算样式，并按 rect 裁切抓图。
           */
          const spec = typeof step.shotClip === 'string'
            ? { selector: step.shotClip, name: step.shotClip }
            : step.shotClip;
          const info = await session.evaluate(`(() => {
            const node = document.querySelector(${JSON.stringify(spec.selector)});
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const cx = Math.min(Math.max(rect.x + rect.width / 2, 1), window.innerWidth - 1);
            const cy = Math.min(Math.max(rect.y + rect.height / 2, 1), window.innerHeight - 1);
            const at = document.elementFromPoint(cx, cy);
            return {
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              offsetParent: Boolean(node.offsetParent),
              clientRects: node.getClientRects().length,
              display: style.display, visibility: style.visibility, opacity: style.opacity,
              position: style.position,
              inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
              atCenter: at ? String(at.className || at.tagName).slice(0, 70) : 'none',
              selfAtCenter: at === node || (at !== null && node.contains(at)),
              text: (node.innerText || '').trim().split('\\n').join(' ').slice(0, 160),
            };
          })()`);
          if (info === null) {
            results.push({ index, step: `shotClip ${spec.name}`, ok: false, reason: 'selector not found' });
            continue;
          }
          process.stdout.write(`[browser] 可见性探针 ${spec.name}：${JSON.stringify(info)}\n`);
          const clip = {
            x: Math.max(info.x, 0),
            y: Math.max(info.y, 0),
            width: Math.max(info.width, 1),
            height: Math.max(info.height, 1),
            scale: 1,
          };
          const clipped = await session.send('Page.captureScreenshot', { format: 'png', clip });
          const clipFile = join(outDir, `${spec.name}.png`);
          writeFileSync(clipFile, Buffer.from(clipped.data, 'base64'));
          process.stdout.write(`[browser] 裁切截图 ${clipFile}\n`);
          results.push({ index, step: `shotClip ${spec.name}`, ok: true, file: clipFile, info });
          continue;
        }
        results.push({ index, step: JSON.stringify(step).slice(0, 60), ok: false, reason: '未知动作' });
      } catch (error) {
        results.push({ index, step: JSON.stringify(step).slice(0, 60), ok: false, reason: String(error.message ?? error) });
      }
    }

    process.stdout.write(`[browser] 结果：${JSON.stringify(results, null, 1)}\n`);
    const interesting = (session?.logs ?? []).filter((entry) => entry.kind === 'exception' || entry.kind === 'error' || entry.kind === 'warning');
    if (interesting.length > 0) {
      process.stdout.write(`[browser] 控制台异常/警告 ${interesting.length} 条：\n`);
      for (const entry of interesting.slice(0, 20)) {
        process.stdout.write(`  [${entry.kind}] ${entry.text.replace(/\s+/gu, ' ').slice(0, 600)}\n`);
      }
    } else {
      process.stdout.write('[browser] 控制台异常/警告：0 条\n');
    }
    const failed = results.filter((entry) => entry.ok !== true);
    // --result <path>：把步骤结果 JSON 落盘，供 tools/build-dom-dump.mjs 生成证据档。
    if (opts.result !== '') writeFileSync(opts.result, JSON.stringify(results, null, 2), 'utf8');
    process.stdout.write(failed.length === 0 ? 'RESULT: PASS — 全部步骤成功\n' : `RESULT: PARTIAL — ${failed.length} 步失败\n`);
  } finally {
    // 先请浏览器自己退出（CDP Browser.close 会带走整棵进程树），再做回退清理：
    // 只 kill 根进程在 Windows 上会留下一堆 renderer/gpu 孤儿（实测）。
    try {
      await session?.send('Browser.close', {}, 5000);
    } catch {
      // 连接可能已断；继续回退清理。
    }
    session?.close();
    await sleep(1200);
    if (child !== null) {
      try {
        process.kill(-child.pid);
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略。
        }
      }
    }
    if (profile !== '' && !opts.keep) {
      await sleep(500);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // Edge 可能还占着文件；留着无害。
      }
    }
  }
}

await main();

/**
 * 主流程加看护计时：CDP 或页面任何一步挂死都必须退出，绝不留住 headless Edge。
 * @returns {Promise<void>} 无返回。
 */
async function main() {
  const budget = Number((await options()).budget);
  const watchdog = setTimeout(() => {
    process.stderr.write(`[browser] 看门狗触发（${budget} ms），强制退出\n`);
    process.exit(1);
  }, budget);
  watchdog.unref?.();
  try {
    await run();
  } finally {
    clearTimeout(watchdog);
  }
  process.exit(0);
}

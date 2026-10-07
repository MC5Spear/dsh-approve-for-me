/**
 * 真实浏览器取证：headless Edge + CDP 打开一个 DSH 实例，进会话、点「轨迹」页签，
 * 读宿主自己的 DOM 判定 composer 与页签正文区的结构关系。
 *
 * 只查宿主 DOM（`[data-composer-seat]` / `.wSkVaW_viewArea`），不依赖插件是否存在。
 * 用法：node tools/probe-composer-dom.mjs [url] [token-file]（省略时取本机配置的默认实例）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPath, instance, missingNotice, outputDir } from './local-config.mjs';

// 接入信息与浏览器路径经本机配置加载器取（显式传参 > 配置 > 文档化跳过）。
const target = await instance();
const BASE = process.argv[2] ?? target?.url ?? '';
const TOKEN_FILE = process.argv[3] ?? target?.tokenFile ?? '';
if (BASE === '') {
  console.log(missingNotice('instance', '真实页面取证需要一个可访问的实例'));
  process.exit(0);
}
const EDGE = await browserPath();
if (EDGE === undefined) {
  console.log(missingNotice('browserPath', '本探针用真实浏览器取证'));
  process.exit(0);
}
const PORT = 9500 + Math.floor(Math.random() * 300);
const profileDir = join(tmpdir(), `dsafm-probe-${PORT}`);
mkdirSync(profileDir, { recursive: true });

const token = existsSync(TOKEN_FILE)
  ? (/token=([A-Za-z0-9_-]+)/u.exec(readFileSync(TOKEN_FILE, 'utf8'))?.[1] ?? '')
  : '';
const url = token === '' ? BASE : `${BASE}/?token=${token}`;
console.log(`# url=${url}  token=${token === '' ? 'none' : 'ok'}`);

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,1400',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** 等 CDP 就绪，返回页面 target 的 ws 地址。 */
async function cdpTarget() {
  for (let i = 0; i < 75; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('CDP not ready');
}

const ws = new WebSocket(await cdpTarget());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (entry === undefined) return;
  pending.delete(message.id);
  entry(message);
};
/** 发一条 CDP 命令。 */
function send(method, params = {}) {
  const id = (seq += 1);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
/** 页面内求值。 */
async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.result?.exceptionDetails !== undefined) return { error: reply.result.exceptionDetails.text };
  return reply.result?.result?.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(7000);

  // 先把折叠的会话列表展开，否则目标会话不在 DOM 里。
  const expanded = await evaluate(`(() => {
    const target = [...document.querySelectorAll('button, [role=button], div, span')]
      .filter((n) => /展开其余|展开剩余/.test((n.textContent || '').trim()) && (n.textContent || '').trim().length < 20)
      .pop();
    if (target === undefined) return false;
    target.click();
    return true;
  })()`);
  console.log('# expanded sidebar:', expanded);
  await sleep(1500);

  const picked = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('span[class*=title]')]
      .filter((n) => { const t = (n.textContent || '').trim(); return t.length > 4 && !/展开|未分组|设置|预览版|探索未至之境/.test(t); });
    const titles = rows.map((n) => (n.textContent || '').trim());
    if (rows.length === 0) return { clicked: false, sample: (document.body.innerText || '').slice(0, 120) };
    const wanted = ${JSON.stringify(process.env.PROBE_SESSION ?? '')};
    const idx = wanted === '' ? 0 : Math.max(0, titles.findIndex((t) => t.includes(wanted)));
    const target = rows[idx];
    let node = target;
    for (let i = 0; i < 5 && node !== null; i += 1) {
      node.click();
      node = node.parentElement;
    }
    return { clicked: true, label: titles[idx], titles: titles.slice(0, 10) };
  })()`);
  console.log('# session:', JSON.stringify(picked));
  await sleep(6000);

  const tabs = await evaluate(`(() => {
    const roleTabs = [...document.querySelectorAll('[role=tab]')].map((n) => (n.textContent || '').trim());
    const classTabs = [...document.querySelectorAll('[class*=tab]')].map((n) => (n.textContent || '').trim()).filter((s) => s.length > 0 && s.length < 12);
    return { roleTabs, classTabs: [...new Set(classTabs)].slice(0, 12), bodyHead: (document.body.innerText || '').slice(0, 200) };
  })()`);
  console.log('# tabs:', JSON.stringify(tabs));

  const clickedTrajectory = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[role=tab], button, [class*=tab]')];
    const target = nodes.find((n) => (n.textContent || '').trim() === '轨迹');
    if (target === undefined) return false;
    target.click();
    return true;
  })()`);
  console.log('# clicked 轨迹:', clickedTrajectory);
  await sleep(3500);

  const layout = await evaluate(`(() => {
    const seat = document.querySelector('[data-composer-seat]');
    const area = document.querySelector('.wSkVaW_viewArea');
    const rect = seat === null ? null : seat.getBoundingClientRect();
    const chain = (node) => { const out = []; let cur = node; while (cur && out.length < 6) { out.push(String(cur.className || cur.tagName).slice(0, 60)); cur = cur.parentElement; } return out; };
    return {
      composerSeatExists: seat !== null,
      composerSeatVisible: rect === null ? null : rect.width > 0 && rect.height > 0,
      composerSeatRect: rect === null ? null : { top: Math.round(rect.top), height: Math.round(rect.height) },
      viewAreaExists: area !== null,
      composerInsideViewArea: seat !== null && area !== null && area.contains(seat),
      composerCardInsideSeat: seat === null ? null : seat.querySelector('[data-composer-card]') !== null,
      seatParentClass: seat === null ? null : seat.parentElement.className,
      seatPrevSiblingClass: seat === null ? null : (seat.previousElementSibling === null ? 'none' : seat.previousElementSibling.className),
      seatAncestors: seat === null ? null : chain(seat),
      viewAreaAncestors: area === null ? null : chain(area),
      pluginSeatPresent: document.querySelector('.dsafm_seat') !== null,
      pluginReviewTabPresent: [...document.querySelectorAll('[role=tab], button')].some((n) => (n.textContent || '').trim() === '审查记录'),
      activeTabText: [...document.querySelectorAll('[role=tab]')].filter((n) => n.getAttribute('aria-selected') === 'true').map((n) => (n.textContent || '').trim()),
    };
  })()`);
  console.log('LAYOUT ' + JSON.stringify(layout));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data !== undefined) {
    // 截图落点：PROBE_SHOT 显式指定 > 配置的 outputDir > 回退相对目录 shots。
    const out = process.env.PROBE_SHOT ?? join((await outputDir()) ?? 'shots', 'probe-composer-dom.png');
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`# screenshot -> ${out}`);
  }
} finally {
  try {
    ws.close();
  } catch {
    // 关不上也无所谓，进程会被杀掉。
  }
  edge.kill();
  await sleep(700);
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Edge 还在收尾时目录会短暂被占用；临时目录留着不影响结论。
  }
}

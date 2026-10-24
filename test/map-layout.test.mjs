import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 映射表布局矩阵（design §7.2 验收判据 1–4 / §10.2 A4）：在隔离无头浏览器里用插件自身样式
 * 渲染五种形态（任意范围＋自定义模型、待确认只读、指定范围＋provider 手输、字段行文本框、
 * 默认审查模型行两下拉），按行网格与整页两口径测量——
 *   判据 1：控件矩形两两不相交（含网格外共用 `.dsafm_input` 的控件）；
 *   判据 2：五列帧相邻两列控件水平间距不小于 7px（8px 列间距减 1px 容差；仅网格内，`.dsafm_ctl` 6px 合法）；
 *   判据 3：`.dsafm_input` 高 34px（±1px）、圆角 8px；
 *   判据 4：不新增横向滚动（行与容器 scrollWidth 不超过 clientWidth）。
 * 帧形：宽视口（960px 容器五列＋340px 窄容器五列压缩）与窄视口（≤520px 媒体查询收单列，判据 2 无对象）。
 * 驱动方式＝Edge headless＋DevTools 协议取回测量值。环境未安装浏览器时显式跳过；
 * 已安装但驱动失败按失败处理（不静默跳过）。
 */
const SOURCE_PATH = new URL('../client.js', import.meta.url);
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 找已安装的 Microsoft Edge；返回路径或 null。 */
function findEdge() {
  return EDGE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** 从 client.js 抽出插件注入的完整 CSS 文本（style 标签 textContent）。 */
function pluginCss() {
  let definition;
  let css = '';
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (node) => { css = node.textContent; } },
  };
  new Function('window', 'document', readFileSync(SOURCE_PATH, 'utf8'))(
    { __ModuleLoader__: { load: (value) => { definition = value; } } },
    documentStub,
  );
  definition.factory(() => ({}));
  assert.ok(css.includes('.dsafm_input{'), '应能从 client.js 抽出插件样式');
  return css;
}

/** 静态夹具：五种形态的行/控件（类名与 client.js 输出一致，仅静态骨架）。 */
const FIXTURE_ROWS = `
<div class="dsafm_map_row" data-frame="any-custom">
  <select class="dsafm_input dsafm_map_scope_mode"><option>任意 provider</option></select>
  <div class="dsafm_map_custom"><input class="dsafm_input dsafm_map_parent" value="future/model"><button type="button" class="dsafm_button dsafm_map_back">返回列表选择</button></div>
  <select class="dsafm_input dsafm_model"><option>未设置</option></select>
  <select class="dsafm_input"><option>自动选择</option></select>
  <button type="button" class="dsafm_button dsafm_map_del">删除</button>
</div>
<div class="dsafm_map_row" data-frame="pending-readonly">
  <select class="dsafm_input dsafm_map_scope_mode"><option>任意 provider</option></select>
  <input class="dsafm_input dsafm_map_parent" value="deepseek/deepseek-chat" readonly>
  <select class="dsafm_input dsafm_model"><option>未设置</option></select>
  <select class="dsafm_input"><option>自动选择</option></select>
  <button type="button" class="dsafm_button dsafm_map_del">删除</button>
</div>
<div class="dsafm_map_row" data-frame="named-provider-custom">
  <div class="dsafm_map_scope"><select class="dsafm_input dsafm_map_scope_mode"><option>指定 provider</option></select><div class="dsafm_map_custom"><input class="dsafm_input dsafm_map_provider" value="custom-prov"><button type="button" class="dsafm_button dsafm_map_back">返回列表选择</button></div></div>
  <select class="dsafm_input dsafm_map_parent"><option>zai/glm-5.3</option></select>
  <select class="dsafm_input dsafm_model"><option>未设置</option></select>
  <select class="dsafm_input"><option>自动选择</option></select>
  <button type="button" class="dsafm_button dsafm_map_del">删除</button>
</div>
<div class="dsafm_field" data-frame="field-input"><div class="dsafm_ctl" style="display:flex"><input class="dsafm_input" value="文本字段"><button type="button" class="dsafm_button">操作</button></div></div>
<div class="dsafm_ctl" data-frame="ctl-row" style="display:flex;gap:6px"><select class="dsafm_input dsafm_model"><option>未设置</option></select><select class="dsafm_input"><option>自动选择</option></select></div>`;

/** 测量表达式：页面就绪前返回 PENDING；就绪后按判据 1–4 算违例清单并返回 JSON 文本。 */
const MEASURE_EXPRESSION = `(() => {
  if (document.readyState !== 'complete' || document.querySelector('.dsafm_input') === null) return 'PENDING';
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const rect = (node) => node.getBoundingClientRect();
  const controls = [...document.querySelectorAll('.dsafm_input, .dsafm_button')];
  const violations = { intersect: [], gap: [], size: [], scroll: [] };
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      if (overlap(rect(controls[i]), rect(controls[j]))) violations.intersect.push([controls[i].className, controls[j].className]);
    }
  }
  for (const row of document.querySelectorAll('.dsafm_map_row')) {
    const columns = getComputedStyle(row).gridTemplateColumns.split(' ').filter((value) => value.trim() !== '').length;
    const items = [...row.children].map((child) => ({ node: child, box: rect(child) }));
    if (columns >= 2) {
      const sorted = [...items].sort((a, b) => a.box.left - b.box.left);
      for (let i = 0; i + 1 < sorted.length; i += 1) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (Math.abs(a.box.top - b.box.top) > 1) continue;
        if (b.box.left - a.box.right < 7 - 0.01) violations.gap.push([row.dataset.frame, b.box.left - a.box.right]);
      }
    }
  }
  for (const node of document.querySelectorAll('.dsafm_input')) {
    const height = rect(node).height;
    if (Math.abs(height - 34) > 1) violations.size.push([node.className, 'height', height]);
  }
  // 圆角随 .dsafm_input 规则整体判定：取证用的 Edge 155（本机 headless）计算样式读不出
  // border-radius（borderTopRadius 为 undefined、getPropertyValue 返回空串），改判样式表规则原文。
  const inputRule = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((rule) => rule.selectorText === '.dsafm_input');
  if (inputRule === undefined || inputRule.style.borderRadius !== '8px') {
    violations.size.push(['.dsafm_input rule', 'radius', inputRule === undefined ? 'missing' : inputRule.style.borderRadius]);
  }
  for (const node of [document.documentElement, ...document.querySelectorAll('[data-frame]')]) {
    if (node.scrollWidth - node.clientWidth > 0.5) violations.scroll.push([node.className || node.tagName, node.scrollWidth, node.clientWidth]);
  }
  return JSON.stringify(violations);
})()`;

/** 生成夹具 HTML：wide＝960px 五列容器＋340px 窄容器；narrow＝自适应容器（触发 ≤520px 单列）。 */
function fixtureHtml(css, mode) {
  const body =
    mode === 'wide'
      ? `<div style="box-sizing:border-box;width:960px;padding:8px;border:1px solid #999">${FIXTURE_ROWS}</div><div style="box-sizing:border-box;width:340px;padding:8px;border:1px solid #999">${FIXTURE_ROWS}</div>`
      : `<div style="box-sizing:border-box;width:100%;padding:8px;border:1px solid #999">${FIXTURE_ROWS}</div>`;
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><style>body{margin:0}</style>${body}`;
}

/** 无头 Edge 渲染并经 DevTools 协议取回测量 JSON（Edge 已知可用，驱动失败视为测试失败）。 */
async function measureInEdge(edge, html, width, height) {
  const file = join(tmpdir(), `dsafm-map-layout-${width}-${process.pid}.html`);
  const profile = join(tmpdir(), `dsafm-map-layout-profile-${width}-${process.pid}`);
  const url = `file:///${file.replace(/\\/gu, '/')}`;
  const port = 9400 + Math.floor(Math.random() * 400);
  writeFileSync(file, html, 'utf8');
  const child = spawn(
    edge,
    [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  try {
    // 等 DevTools 端点起来并出现页面目标，再等页面解析完成并取回测量结果。
    let target = null;
    for (let attempt = 0; attempt < 50 && target === null; attempt += 1) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((entry) => entry.type === 'page' && entry.url.startsWith('file:///')) ?? null;
      } catch {
        // 端点未就绪，继续等。
      }
    }
    assert.ok(target !== null, '应能在 DevTools 端点找到页面目标（Edge 启动失败或被环境拦截）');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      socket.addEventListener('open', () => done());
      socket.addEventListener('error', () => fail(new Error('DevTools WebSocket 连接失败')));
    });
    let payload = null;
    for (let attempt = 0; attempt < 40 && payload === null; attempt += 1) {
      const reply = await new Promise((done) => {
        const onMessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === attempt + 1) {
            socket.removeEventListener('message', onMessage);
            done(data);
          }
        };
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({
          id: attempt + 1,
          method: 'Runtime.evaluate',
          params: { expression: MEASURE_EXPRESSION, returnByValue: true },
        }));
      });
      const text = reply?.result?.result?.value;
      if (typeof text === 'string' && text !== 'PENDING') {
        payload = text;
        break;
      }
      await sleep(250);
    }
    socket.close();
    assert.ok(payload !== null, '应能取回页面测量结果（页面未就绪或脚本失败）');
    return JSON.parse(payload);
  } finally {
    child.kill();
    // 夹具 HTML 即时清理；Edge profile 目录尽力清理——进程刚 kill 时句柄可能尚未释放，
    // 删不掉就留待系统临时目录清理（惰性残留无害，且 pid 后缀避免重跑冲突）。
    try { unlinkSync(file); } catch { /* 句柄未释放，留待系统清理。 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 同上。 */ }
  }
}

test('映射表布局矩阵（design §7.2）：宽/窄/窄容器三帧判据 1–4 全过', async (t) => {
  // 本矩阵经 CDP（WebSocket）驱动无头 Edge；全局 WebSocket 自 Node 22 起内置，
  // 更早版本按文档化跳过处理（engines 声明 node>=20，布局验收另有真实例巡检承载）。
  if (typeof WebSocket === 'undefined') {
    t.skip('运行时无全局 WebSocket（Node <22），隔离布局矩阵未执行（布局验收由真实例巡检承载）');
    return;
  }
  const edge = findEdge();
  if (edge === null) {
    t.skip('未安装 Microsoft Edge，隔离布局矩阵未执行（布局验收由真实例巡检承载）');
    return;
  }
  const css = pluginCss();
  for (const [label, mode, width, height, withGap] of [
    ['宽视口（960px 五列＋340px 窄容器压缩）', 'wide', 1280, 900, true],
    ['窄视口（≤520px 单列，判据 2 无对象）', 'narrow', 480, 900, false],
  ]) {
    const violations = await measureInEdge(edge, fixtureHtml(css, mode), width, height);
    assert.deepEqual(violations.intersect, [], `${label}：控件矩形应两两不相交（判据 1）`);
    assert.deepEqual(violations.size, [], `${label}：.dsafm_input 应高 34px、圆角 8px（判据 3）`);
    assert.deepEqual(violations.scroll, [], `${label}：不应新增横向滚动（判据 4）`);
    if (withGap) assert.deepEqual(violations.gap, [], `${label}：相邻列控件水平间距应不小于 7px（判据 2）`);
  }
});

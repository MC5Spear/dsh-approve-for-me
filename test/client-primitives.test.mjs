/**
 * 客户端半边对宿主 `@deepseek-ai/dsh-client-ui-primitives` 的引用核验。
 *
 * 存在的理由：宿主（基线 dsh 0.2.1-rc.2，requirements §1.3）的图标用尺寸变体命名
 * （`IconXxxOutline` + `Regular`/`Medium`/`Artwork`），带像素后缀的旧式名（如
 * `IconXxxOutline14`）在宿主里不存在；`jsx(undefined)` 触发 React #130
 * 「Element type is invalid」，槽条目**整条崩溃且页面静默空白**（宿主 renderer 的
 * 报错模板：`slot entry crashed in '<slotKey>'`），使用该基元的挂点因此完全不渲染
 * （primitives 只用于设置卡片 `plugins.bundle.config`；composer、审批卡片与记录
 * 视图不引 primitives，不受此影响）。
 *
 * 本测试把「我们引用的每个 primitives 名字都必须真的存在于宿主制品里」变成一条
 * **能失败**的断言：解析 `primitives.<Name>` → 在宿主包的实现与类型声明里逐个查名。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'client.js');

/** 去掉块注释与行注释，避免把说明文字当成真实引用。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** 客户端源码里真实用到的 `primitives.<Name>` 名字（去重、保序）。 */
function usedPrimitives(source) {
  const names = new Set();
  for (const match of stripComments(source).matchAll(/primitives\.([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  return [...names];
}

/** 宿主 primitives 包的目录（经 `--import ./tools/_host-hooks.mjs` 的解析钩子锚定）。 */
function hostPrimitivesDir() {
  const resolved = import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json');
  return dirname(fileURLToPath(resolved));
}

/**
 * 宿主包缺失时跳过本用例（与 `index.test.mjs` 的 loadHost 同一纪律：只吞宿主解析不到）。
 * @param {object} t - 测试上下文。
 * @returns {string | undefined} 宿主制品全文；离线环境跳过用例后返回 `undefined`。
 */
function hostArtifactOrSkip(t) {
  let dir;
  try {
    dir = hostPrimitivesDir();
  } catch (error) {
    const message = String(error?.message ?? error);
    const hostPackageMissing = error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/');
    if (hostPackageMissing) {
      t.skip('宿主 primitives 包不可解析（离线环境）');
      return undefined;
    }
    throw error;
  }
  return hostArtifactText(dir);
}

/** 宿主制品全文：实现入口与类型声明（两者合起来代表「对外提供的名字」）。 */
function hostArtifactText(dir) {
  const files = ['lib/index.js', 'lib/types/index.d.ts'];
  return files
    .map((file) => {
      try {
        return readFileSync(join(dir, file), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

test('client.js 引用的每个 primitives 名字都存在于宿主制品里', (t) => {
  const used = usedPrimitives(readFileSync(CLIENT, 'utf8'));
  assert.ok(used.length > 0, 'client.js 应当通过 primitives 使用宿主组件（否则本测试失去对象）');
  const artifact = hostArtifactOrSkip(t);
  if (artifact === undefined) return;
  assert.ok(artifact.length > 0, '宿主 primitives 制品为空，无法核验');
  const missing = used.filter((name) => !new RegExp(`\\b${name}\\b`, 'u').test(artifact));
  assert.deepEqual(missing, [], `以下 primitives 名字在宿主里不存在（会触发 React #130）：${missing.join(', ')}`);
});

test('核验器本身能失败：旧式像素后缀名在宿主里确实不存在', (t) => {
  const artifact = hostArtifactOrSkip(t);
  if (artifact === undefined) return;
  // 反面对照：旧式像素后缀名正是崩溃元凶，必须查不到——
  // 若某天它们又出现了，说明断言对象变了，本用例会先红，提醒重估。
  assert.equal(/\bIconChevronDownOutline14\b/u.test(artifact), false);
  assert.equal(/\bIconQuestionOutline14\b/u.test(artifact), false);
  // 并确认真实使用的名字能查到（证明核验路径有效，不是恒假）。
  for (const name of usedPrimitives(readFileSync(CLIENT, 'utf8'))) {
    assert.equal(new RegExp(`\\b${name}\\b`, 'u').test(artifact), true, `${name} 应当能在宿主制品里查到`);
  }
});

test('client.js 图标引用收敛：设置界面帮助/警告图标走宿主基元，其余内联', () => {
  const source = stripComments(readFileSync(CLIENT, 'utf8'));
  // 字段帮助按钮统一用官方 IconInfoOutlineRegular（12px），分置醒目提示行用官方
  // IconWarningOutlineRegular（12px，design §7.2.0 宿主连接指示器同款配对），不自造图标；
  // 多选触发器的下箭头仍内联 SVG（宿主图标名无像素后缀变体，引用即崩溃）。
  const iconRefs = [...source.matchAll(/primitives\.(Icon\w*)/gu)].map((match) => match[1]);
  assert.deepEqual(iconRefs, ['IconWarningOutlineRegular', 'IconInfoOutlineRegular'], `图标引用应只有警告/信息两个官方图标（按源内首现顺序），实际：${iconRefs.join(', ')}`);
  assert.equal(/const ChevronDownIcon = /u.test(source), true, '内联下箭头组件缺失');
  assert.equal(/const QuestionIcon = /u.test(source), false, '源码不得定义自造问号图标（QuestionIcon 零定义）');
});

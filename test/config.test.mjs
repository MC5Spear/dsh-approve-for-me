import assert from 'node:assert/strict';
import test from 'node:test';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { readFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { Config, normalizeConfig } from '../lib/config.js';

// ── R37：数值边界（毫秒上界与 temperature 有限性） ────────────────────────

/** 五个进 setTimeout 域的毫秒字段（设计 §22.7）：上界必须是 2^31-1。 */
const MS_FIELDS = [
  ['reviewer', 'timeoutMs'],
  ['reviewer', 'toolTimeoutMs'],
  ['human', 'timeoutMs'],
  ['concurrency', 'queueTimeoutMs'],
  ['breaker', 'cooldownMs'],
];

test('R37① 毫秒字段上界：2147483647 通过、2147483648 拒绝（加载失败而非静默钳制）', () => {
  for (const [section, field] of MS_FIELDS) {
    assert.doesNotThrow(() => Config({ [section]: { [field]: 2147483647 } }), `${section}.${field} 上界值必须通过`);
    assert.throws(() => Config({ [section]: { [field]: 2147483648 } }), `${section}.${field} 超界必须拒绝（进 setTimeout 会溢出为 1ms）`);
    assert.throws(() => Config({ [section]: { [field]: -1 } }), `${section}.${field} 负值必须拒绝`);
  }
});

test('R37② 毫秒字段 0 是合法值（各字段 0 语义：不设超时/立即拒绝/不限）', () => {
  for (const [section, field] of MS_FIELDS) {
    // Config 解析产物里 volatile 字段是引用，读值过 normalizeConfig。
    const merged = normalizeConfig(Config({ [section]: { [field]: 0 } }));
    assert.equal(merged[section][field], 0, `${section}.${field} 的 0 必须原样保留`);
  }
});

test('R37③ temperature：0 与 2 通过、-0.1 与 2.1 与 NaN 与 Infinity 拒绝（装载路径，ISS-1 移位）', () => {
  for (const good of [0, 2, 1.5]) {
    assert.equal(normalizeConfig(Config({ reviewer: { temperature: good } })).reviewer.temperature, good, `${good} 应通过`);
  }
  // ISS-1 修复口径：transform 已从 Config 树移除（客户端设置通道无法序列化往返），
  // 拒止分两层——界外仍由 schema 拒（Config 直调，加载即失败）；NaN/Infinity 能骗过
  // schemastery 的 min/max 比较（比较恒 false，R37 立项依据），有限性在装载路径
  // normalizeConfig 显式拒止。
  for (const bound of [-0.1, 2.1]) {
    assert.throws(() => Config({ reviewer: { temperature: bound } }), `${bound} 必须被 schema 界限拒绝`);
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => normalizeConfig({ reviewer: { temperature: bad } }), `${bad} 必须在装载时拒绝`);
  }
  // 缺省 0 且 volatile 元数据保留（热改通道不因字段直陈丢失）。
  const raw = Config({});
  assert.equal(isVolatile(raw.reviewer.temperature), true, '缺省仍应是 volatile 引用');
  assert.equal(normalizeConfig(raw).reviewer.temperature, 0);
});

test('R37④ rt.timer 的入参上界注释在位（config 层保证 ≤ 2^31-1）', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /2147483647/u, 'rt.timer 处应注明上界由 config 层保证');
});

// ── R42：normalizeConfig 对 language 分节的合并语义 ───────────────────────

test('R42① language 进逐组合并：部分传入输出完整分节，不再静默换语言', () => {
  const merged = normalizeConfig({ language: { ui: 'zh' } });
  assert.equal(merged.language.agent, 'en', '未提及的子字段补默认（现状 undefined → agentLangOf 静默回落）');
  assert.equal(merged.language.ui, 'zh');
  // 整节缺省同样完整。
  const defaulted = normalizeConfig({});
  assert.equal(defaulted.language.agent, 'en');
  assert.equal(defaulted.language.ui, 'auto');
});

test('R42② 对照组：其余嵌套分节同口径（部分传入补默认）', () => {
  assert.equal(normalizeConfig({ audit: { enabled: true } }).audit.maxLineBytes, 4096);
  assert.equal(normalizeConfig({ human: {} }).human.timeoutMs, 300000);
  assert.equal(normalizeConfig({ concurrency: {} }).concurrency.max, 2);
  assert.equal(normalizeConfig({ reviewer: {} }).reviewer.toolTimeoutMs, 5000);
});

test('R42③ 输出契约显式化：normalizeConfig 的 JSDoc 写明输入/输出契约', () => {
  const source = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
  assert.match(source, /输出契约/u, 'normalizeConfig 注释应含输出契约（分节必完整）');
  assert.match(source, /输入契约|先过 schema|schema/u, '注释应写明输入契约（是否要求先过 schema）');
});

// ── ISS-1：设置界面 decode 往返（客户端设置通道的序列化契约） ────────────────
// 宿主调用链：settings.describe → schema.toJSON() 信封 →（客户端镜像可能再序列化一次）→
// new Schema(信封) 重组 → validate(draft)。transform 节点的 JS 回调在第二次序列化时丢失
// （callback=undefined），重组后校验任何值都抛 `callback is not a function`、decode() 返回
// undefined、表单整片全空——所以 Config 全树禁止 transform（修复口径，design §27）。

test('ISS-1① 信封全树无 transform 节点：一次与二次序列化都不携带回调', () => {
  const json1 = JSON.stringify(Config.toJSON());
  assert.equal((json1.match(/"type":"transform"/gu) ?? []).length, 0, '一次序列化信封不得含 transform 节点');
  assert.equal((json1.match(/"callback"/gu) ?? []).length, 0, '一次序列化信封不得携带回调键');
  const rehydrated = new z(JSON.parse(json1));
  const json2 = JSON.stringify(JSON.parse(JSON.stringify(rehydrated.toJSON())));
  assert.equal((json2.match(/"type":"transform"/gu) ?? []).length, 0, '二次序列化后不得出现 transform 节点');
  assert.equal((json2.match(/"callback"/gu) ?? []).length, 0, '二次序列化后不得出现 callback=undefined 的 transform 节点');
});

test('ISS-1② decode 往返：含空分节的真实 describe 取值在一跳/两跳重组 schema 下校验通过', () => {
  const s1 = new z(JSON.parse(JSON.stringify(Config.toJSON())));
  const s2 = new z(JSON.parse(JSON.stringify(s1.toJSON())));
  // 夹具＝真实部署的 profile patch 的 approve-for-me 用户层逐字（cordis.patch.yml :129-143）：
  // 含 human: {} 空分节与 ui.trace 部分分节——活体 describe 取值的真实形态。
  const realProfile = {
    reviewer: { model: { model: 'zai/glm-5.3-flash', effort: 'high' }, timeoutMs: 300000 },
    human: {},
    ui: { trace: { capture: 'full' } },
    language: { ui: 'zh', agent: 'en' },
  };
  // 宿主 dsh-client-ui-settings 的 validate() 语义＝不抛即有效（client.js:942-949）。
  for (const [hop, schema] of [['one-hop', s1], ['two-hop', s2]]) {
    for (const [label, value] of [
      ['真实取值（含空分节）', realProfile],
      ['无用户层 {}', {}],
      ['单个空分节 human:{}', { human: {} }],
      ['插件材料化生效值', normalizeConfig(realProfile)],
    ]) {
      assert.doesNotThrow(() => schema(value), `${hop} × ${label} 必须校验通过`);
    }
  }
});

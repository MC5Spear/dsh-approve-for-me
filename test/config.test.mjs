import assert from 'node:assert/strict';
import test from 'node:test';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { readFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { Config, normalizeConfig, normalizeRuleProvider, parentModelRuleKey } from '../lib/config.js';

// ── 数值边界（requirements §4.2／§5.2：毫秒上界与 temperature 有限性） ──────

/** 五个进 setTimeout 域的毫秒字段（design §6.1）：上界必须是 2^31-1。 */
const MS_FIELDS = [
  ['reviewer', 'timeoutMs'],
  ['reviewer', 'toolTimeoutMs'],
  ['human', 'timeoutMs'],
  ['concurrency', 'queueTimeoutMs'],
  ['breaker', 'cooldownMs'],
];

test('毫秒字段上界：2147483647 通过、2147483648 拒绝（加载失败而非静默钳制）', () => {
  for (const [section, field] of MS_FIELDS) {
    assert.doesNotThrow(() => Config({ [section]: { [field]: 2147483647 } }), `${section}.${field} 上界值必须通过`);
    assert.throws(() => Config({ [section]: { [field]: 2147483648 } }), `${section}.${field} 超界必须拒绝（进 setTimeout 会溢出为 1ms）`);
    assert.throws(() => Config({ [section]: { [field]: -1 } }), `${section}.${field} 负值必须拒绝`);
  }
});

test('毫秒字段 0 是合法值（各字段 0 语义：不设超时/立即拒绝/不限）', () => {
  for (const [section, field] of MS_FIELDS) {
    // Config 解析产物里 volatile 字段是引用，读值过 normalizeConfig。
    const merged = normalizeConfig(Config({ [section]: { [field]: 0 } }));
    assert.equal(merged[section][field], 0, `${section}.${field} 的 0 必须原样保留`);
  }
});

test('temperature：0 与 2 通过、-0.1 与 2.1 拒绝（schema 界限）；非有限数双层拒绝（design §6.1）', () => {
  for (const good of [0, 2, 1.5]) {
    assert.equal(normalizeConfig(Config({ reviewer: { temperature: good } })).reviewer.temperature, good, `${good} 应通过`);
  }
  // 双层防线（design §6.1）：schema 层区间边界＋退化步长拒非有限数（调用即拒，见下一条用例）；
  // 读取路径 normalizeConfig 的有限性检查保留——volatile 写路径原地更新引用、不过 schema 校验，
  // 程序化写入的非法值仍由读取检查拒绝。
  for (const bound of [-0.1, 2.1]) {
    assert.throws(() => Config({ reviewer: { temperature: bound } }), `${bound} 必须被 schema 界限拒绝`);
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => Config({ reviewer: { temperature: bad } }), `${bad} 必须在 schema 调用即拒`);
    assert.throws(() => normalizeConfig({ reviewer: { temperature: bad } }), `${bad} 必须在装载时拒绝`);
  }
  // 缺省 0 且 volatile 元数据保留（热改通道不因字段直陈丢失）。
  const raw = Config({});
  assert.equal(isVolatile(raw.reviewer.temperature), true, '缺省仍应是 volatile 引用');
  assert.equal(normalizeConfig(raw).reviewer.temperature, 0);
});

test('温度 schema 层退化步长：序列化往返后拦截保留、有限值零损失（design §6.1 序列化契约）', () => {
  // 退化步长 Number.MIN_VALUE＝2^-1074：一切有限双精度数都是它的整数倍，取模恰为 0——
  // 不排除任何有限值，只把取模为 NaN 的非有限数交给整除校验拒绝（±Infinity 另被区间边界拒）。
  const s1 = new z(JSON.parse(JSON.stringify(Config.toJSON())));
  const s2 = new z(JSON.parse(JSON.stringify(s1.toJSON())));
  for (const [hop, schema] of [['one-hop', s1], ['two-hop', s2]]) {
    assert.throws(() => schema({ reviewer: { temperature: Number.NaN } }), `${hop}：往返后 NaN 仍拒`);
    assert.throws(() => schema({ reviewer: { temperature: Number.POSITIVE_INFINITY } }), `${hop}：往返后 +Infinity 仍拒`);
    for (const good of [0, 0.7, 1.5, 1e-300, 2]) {
      assert.doesNotThrow(() => schema({ reviewer: { temperature: good } }), `${hop}：有限值 ${good} 零损失`);
    }
  }
});

test('rt.timer 的入参上界注释在位（config 层保证 ≤ 2^31-1）', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /2147483647/u, 'rt.timer 处应注明上界由 config 层保证');
});

// ── normalizeConfig 对 language 分节的合并语义（design §6.1） ───────────────

test('language 进逐组合并：部分传入输出完整分节，不再静默换语言', () => {
  const merged = normalizeConfig({ language: { ui: 'zh' } });
  assert.equal(merged.language.agent, 'en', '未提及的子字段补默认（现状 undefined → agentLangOf 静默回落）');
  assert.equal(merged.language.ui, 'zh');
  // 整节缺省同样完整。
  const defaulted = normalizeConfig({});
  assert.equal(defaulted.language.agent, 'en');
  assert.equal(defaulted.language.ui, 'auto');
});

test('对照组：其余嵌套分节同口径（部分传入补默认）', () => {
  assert.equal(normalizeConfig({ audit: { enabled: true } }).audit.maxLineBytes, 4096);
  assert.equal(normalizeConfig({ human: {} }).human.timeoutMs, 300000);
  assert.equal(normalizeConfig({ concurrency: {} }).concurrency.max, 2);
  assert.equal(normalizeConfig({ reviewer: {} }).reviewer.toolTimeoutMs, 5000);
});

test('输出契约显式化：normalizeConfig 的 JSDoc 写明输入/输出契约', () => {
  const source = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
  assert.match(source, /输出契约/u, 'normalizeConfig 注释应含输出契约（分节必完整）');
  assert.match(source, /输入契约|先过 schema|schema/u, '注释应写明输入契约（是否要求先过 schema）');
});

// ── 设置界面 decode 往返（design §6.1：客户端设置通道的序列化契约） ──────────
// 宿主调用链：settings.describe → schema.toJSON() 信封 →（客户端镜像可能再序列化一次）→
// new Schema(信封) 重组 → validate(draft)。transform 节点的 JS 回调在第二次序列化时丢失
// （callback=undefined），重组后校验任何值都抛 `callback is not a function`、decode() 返回
// undefined、表单整片全空——所以 Config 全树禁止 transform（design §6.1）。

test('信封全树无 transform 节点：一次与二次序列化都不携带回调', () => {
  const json1 = JSON.stringify(Config.toJSON());
  assert.equal((json1.match(/"type":"transform"/gu) ?? []).length, 0, '一次序列化信封不得含 transform 节点');
  assert.equal((json1.match(/"callback"/gu) ?? []).length, 0, '一次序列化信封不得携带回调键');
  const rehydrated = new z(JSON.parse(json1));
  const json2 = JSON.stringify(JSON.parse(JSON.stringify(rehydrated.toJSON())));
  assert.equal((json2.match(/"type":"transform"/gu) ?? []).length, 0, '二次序列化后不得出现 transform 节点');
  assert.equal((json2.match(/"callback"/gu) ?? []).length, 0, '二次序列化后不得出现 callback=undefined 的 transform 节点');
});

test('decode 往返：含空分节的真实 describe 取值在一跳/两跳重组 schema 下校验通过', () => {
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

// ── 父模型映射规则（design §6.2：新结构、兼容输入、重复条件拒绝、残留键） ────────

/** 一条合法的结构化规则（条件与选择都齐全）。 */
const sampleRule = {
  parent: { provider: 'openrouter', model: 'anthropic/claude-3' },
  choice: { model: 'zai/glm-5.3', effort: 'low' },
};

test('parentModelRules：新结构与旧字典并存装载，默认值为 [] 与 {}（requirements §5.3）', () => {
  const merged = normalizeConfig(
    Config({
      reviewer: {
        parentModelRules: [sampleRule, { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
        byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' },
      },
    }),
  );
  assert.deepEqual(merged.reviewer.parentModelRules[0], sampleRule);
  assert.deepEqual(merged.reviewer.parentModelRules[1], { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } });
  assert.deepEqual(merged.reviewer.byParentModel, { 'deepseek-v4-flash': 'zai/glm-5.3' });
  const empty = normalizeConfig({});
  assert.deepEqual(empty.reviewer.parentModelRules, []);
  assert.deepEqual(empty.reviewer.byParentModel, {});
  // 规则清单是可热更新字段：volatile 元数据保留。
  const raw = Config({});
  assert.equal(isVolatile(raw.reviewer.parentModelRules), true, '规则清单应是 volatile 引用');
});

test('非法条件：provider 非字符串非 null 在 schema 调用即拒（错误可见，不静默改默认）', () => {
  for (const bad of [3, true, {}, []]) {
    assert.throws(
      () => Config({ reviewer: { parentModelRules: [{ parent: { provider: bad, model: 'chat' }, choice: { model: 'zai/glm-5.3' } }] } }),
      /parent\.provider|expected/u,
      `provider=${JSON.stringify(bad)} 必须被 schema 拒绝`,
    );
  }
});

test('非法条件：parent.model 空串由装载阶段显式校验拒绝（design §6.2）', () => {
  for (const bad of ['', '   ']) {
    assert.throws(
      () => normalizeConfig({ reviewer: { parentModelRules: [{ parent: { provider: null, model: bad }, choice: {} }] } }),
      /parent\.model 必须是非空字符串/u,
      `model=${JSON.stringify(bad)} 必须被装载校验拒绝`,
    );
  }
});

test('重复条件：装载路径拒绝、错误信息可见（不按清单顺序选赢家）', () => {
  const duplicated = {
    reviewer: {
      parentModelRules: [
        { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3' } },
        { parent: { provider: null, model: 'chat' }, choice: { model: 'deepseek-official/deepseek-v4-pro' } },
      ],
    },
  };
  // 直传装载：同一比较抛错。
  assert.throws(() => normalizeConfig(duplicated), /重复匹配条件/u);
  // Config 调用产物再装载：同一比较抛错（装载失败、错误可见）。
  assert.throws(() => normalizeConfig(Config(duplicated)), /重复匹配条件/u);
  // 归一口径：空串 provider 与 null 是同一条件（任意 provider）。
  assert.throws(
    () =>
      normalizeConfig({
        reviewer: {
          parentModelRules: [
            { parent: { provider: null, model: 'chat' }, choice: {} },
            { parent: { provider: '', model: 'chat' }, choice: {} },
          ],
        },
      }),
    /重复匹配条件/u,
  );
});

test('重复条件：volatile 写路径由读取路径按同一比较拒绝（design §6.2 拒绝落点）', () => {
  // 模拟宿主对 volatile 字段的原地更新：装载成功的配置对象被替换规则清单后，
  // 读取（normalizeConfig）是程序化写入的最后一层防线。
  const base = normalizeConfig(Config({}));
  const poisoned = { ...base, reviewer: { ...base.reviewer, parentModelRules: [
    { parent: { provider: 'zai', model: 'chat' }, choice: { model: 'zai/glm-5.3' } },
    { parent: { provider: 'zai', model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: 'high' } },
  ] } };
  assert.throws(() => normalizeConfig(poisoned), /重复匹配条件/u, '读取路径必须拒绝重复条件');
});

test('规则 schema 随一跳/两跳序列化往返保留：合法规则通过、非法 provider 仍拒', () => {
  const s1 = new z(JSON.parse(JSON.stringify(Config.toJSON())));
  const s2 = new z(JSON.parse(JSON.stringify(s1.toJSON())));
  for (const [hop, schema] of [['one-hop', s1], ['two-hop', s2]]) {
    assert.doesNotThrow(
      () => schema({ reviewer: { parentModelRules: [sampleRule, { parent: { model: 'chat' }, choice: { model: 'zai/glm-5.3' } }] } }),
      `${hop}：往返后合法规则必须通过`,
    );
    assert.throws(
      () => schema({ reviewer: { parentModelRules: [{ parent: { provider: 3, model: 'chat' }, choice: {} }] } }),
      `${hop}：往返后非法 provider 必须仍拒`,
    );
  }
});

test('followParent 残留键：装载按未声明键处理——不读取、不迁移、不报错', () => {
  // 未声明键经 schema 解析原样保留、校验不报错；行为等同未提供（零值语义由解析层承载）。
  const merged = normalizeConfig(Config({ reviewer: { followParent: false, model: 'zai/glm-5.3' } }));
  assert.equal(merged.reviewer.followParent, false, '残留键原样保留（不迁移）');
  assert.equal(merged.reviewer.model, 'zai/glm-5.3');
  assert.doesNotThrow(() => normalizeConfig({ reviewer: { followParent: true } }), '残留键不触发装载错误');
  const source = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
  assert.match(source, /followParent/u, 'schema 注释应写明残留键的处理口径');
  assert.doesNotThrow(() => Config({}), 'schema 声明不含 followParent，默认装载不受影响');
});

test('normalizeRuleProvider 与 parentModelRuleKey：归一空值与去首尾空白组键的单一实现', () => {
  assert.equal(normalizeRuleProvider(null), null);
  assert.equal(normalizeRuleProvider(undefined), null);
  assert.equal(normalizeRuleProvider(''), null);
  assert.equal(normalizeRuleProvider('  '), null);
  assert.equal(normalizeRuleProvider('openrouter'), 'openrouter');
  assert.equal(normalizeRuleProvider(' openrouter '), 'openrouter', '非空 provider 去首尾空白后返回');
  assert.equal(normalizeRuleProvider(3), undefined, '非字符串非空值返回 undefined 标记非法');
  // 空值归一后同键；model 去首尾空白组键（不切斜杠）。
  assert.equal(parentModelRuleKey(null, 'chat'), parentModelRuleKey('', 'chat'));
  assert.notEqual(parentModelRuleKey(null, 'chat'), parentModelRuleKey('zai', 'chat'));
  assert.notEqual(parentModelRuleKey(null, 'claude-3'), parentModelRuleKey(null, 'anthropic/claude-3'));
  assert.notEqual(parentModelRuleKey('a', 'b/c'), parentModelRuleKey('a/b', 'c'), '条件键不得被斜杠拼接歧义碰撞');
  assert.equal(parentModelRuleKey(' foo ', ' m '), parentModelRuleKey('foo', 'm'), '条件两字段去首尾空白后同键');
});

test('重复条件：首尾空白条件与去空白条件同键，装载路径按同一比较拒绝', () => {
  const pair = {
    reviewer: {
      parentModelRules: [
        { parent: { provider: 'foo', model: 'm' }, choice: { model: 'zai/glm-5.3' } },
        { parent: { provider: ' foo ', model: ' m ' }, choice: { model: 'zai/glm-5.3' } },
      ],
    },
  };
  // 直传装载：同一比较抛错——空白前后缀不构成新条件。
  assert.throws(() => normalizeConfig(pair), /重复匹配条件/u, '直传装载：首尾空白对必须按同键拒绝');
  // Config 调用产物再装载：同一比较抛错（装载失败、错误可见）。
  assert.throws(() => normalizeConfig(Config(pair)), /重复匹配条件/u);
  // 错误信息渲染归一后取值（provider=model=键组成值），按消息可直接定位重复两行。
  assert.throws(() => normalizeConfig(pair), /provider=foo、model=m/u, '错误信息应渲染归一后取值');
});

test('重复条件：volatile 写路径对首尾空白对按同一比较拒绝', () => {
  // 模拟宿主对 volatile 字段的原地更新：装载成功的配置对象被替换为空白对规则后，
  // 读取（normalizeConfig）是程序化写入的最后一层防线，与装载路径同一键口径。
  const base = normalizeConfig(Config({}));
  const poisoned = { ...base, reviewer: { ...base.reviewer, parentModelRules: [
    { parent: { provider: 'foo', model: 'm' }, choice: { model: 'zai/glm-5.3' } },
    { parent: { provider: ' foo ', model: ' m ' }, choice: { model: 'zai/glm-5.3', effort: 'low' } },
  ] } };
  assert.throws(() => normalizeConfig(poisoned), /重复匹配条件/u, '读取路径必须把空白对按同键拒绝');
});

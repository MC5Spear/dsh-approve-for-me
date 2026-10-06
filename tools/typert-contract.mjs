/**
 * rc.1 strict codec 与 invocation 契约的单一判据源（离线、纯对象检查，无外部依赖）。
 *
 * 依据两处宿主源：
 *   - `dsh-typert-loader/lib/index.js:153-212`（注册期校验）：codec 须 `mode:'strict'`、
 *     `typeSymbol` 非空、`create` 是函数；`decode`/`encode` 存在则须为函数；
 *     invocation 的 id/service/namespace/method 非空、receiver 为 direct 或 context、
 *     wire 字段不重复、json 参数不得声明 lookup。
 *   - `dsh-typert-registry/lib/index.js:509-518`（消费约定）：`create()` 的返回值就是 schema，
 *     本仓库约定该返回值必须是 zod v4 实例（判据 `'_zod' in 返回值`）。
 *
 * 消费方：`test/typert-manifest.test.mjs`（套件常驻断言）与 `tools/check-typert-manifest.mjs`
 * （离线检查器）。两处不得再各自维护判据副本——检查器曾按 rc.6 时代的 `codec.schema`
 * 字段名校验，与套件判据漂移出 18 条假红（r33 修正）。
 */

/**
 * 该 codec 是否满足 rc.1 的 strict codec 契约。
 * @param {object} codec - 待检 codec。
 * @returns {string[]} 错误清单（空数组 = 合规）。
 */
export function checkCodec(codec) {
  const problems = [];
  if (typeof codec !== 'object' || codec === null || Array.isArray(codec)) return ['不是对象'];
  if (codec.mode !== 'strict') problems.push(`mode 必须是 'strict'，实际 ${String(codec.mode)}`);
  if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) problems.push('typeSymbol 缺失或为空');
  for (const method of ['decode', 'encode']) {
    if (codec[method] !== undefined && typeof codec[method] !== 'function') problems.push(`${method} 存在但不是函数`);
  }
  if (typeof codec.create !== 'function') problems.push('create 缺失或不是函数（rc.1 要求 create() 工厂）');
  else {
    const value = codec.create();
    if (typeof value !== 'object' || value === null || value._zod === undefined) {
      problems.push('create() 的返回值不是 zod v4 schema（缺 _zod）');
    }
  }
  return problems;
}

/**
 * 逐条核对一份 invocation（复刻 loader 注册期校验的字段集）。
 * @param {object} invocation - 待检 invocation。
 * @returns {object} `问题路径 -> 错误清单`（空对象 = 合规）。
 */
export function checkInvocation(invocation) {
  const found = {};
  for (const key of ['id', 'service', 'namespace', 'method']) {
    if (typeof invocation[key] !== 'string' || invocation[key].length === 0) found[key] = ['缺失或为空'];
  }
  const receiver = invocation.invocation;
  if (typeof receiver !== 'object' || receiver === null) found['invocation'] = ['缺失'];
  else if (receiver.kind !== 'direct' && receiver.kind !== 'context') found['invocation.kind'] = ['必须是 direct 或 context'];
  else if (receiver.kind === 'context') {
    const problems = checkCodec(receiver.codec);
    if (problems.length > 0) found['invocation.codec'] = problems;
  }
  const wires = new Set();
  for (const [index, parameter] of (invocation.parameters ?? []).entries()) {
    const at = `parameters[${index}]`;
    if (typeof parameter.name !== 'string' || parameter.name.length === 0) found[`${at}.name`] = ['缺失或为空'];
    if (typeof parameter.wire !== 'string' || parameter.wire.length === 0) found[`${at}.wire`] = ['缺失或为空'];
    else if (wires.has(parameter.wire)) found[`${at}.wire`] = [`重复的 wire "${parameter.wire}"`];
    else wires.add(parameter.wire);
    if (parameter.source !== 'json' && parameter.source !== 'lookup') found[`${at}.source`] = ["必须是 'json' 或 'lookup'"];
    const problems = checkCodec(parameter.codec);
    if (problems.length > 0) found[`${at}.codec`] = problems;
  }
  const resultProblems = checkCodec(invocation.result);
  if (resultProblems.length > 0) found.result = resultProblems;
  return found;
}

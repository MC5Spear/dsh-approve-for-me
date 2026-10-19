import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DENY_PATTERNS,
  compilePattern,
  extractSubject,
  modeWithinCeiling,
  parseEscalationReason,
  screen,
} from '../lib/policy.js';
import { normalizeConfig } from '../lib/config.js';

/** 默认配置；测试按需覆盖单个字段。 */
const baseConfig = {
  mode: 'rules',
  tools: ['pwsh', 'bash', 'edit', 'write'],
  allowEscalationTo: 'danger-full-access',
  denyPatterns: [...DEFAULT_DENY_PATTERNS],
  unknownSubject: 'reject',
};

/** 构造一次升权请求。 */
const escalation = (mode = 'danger-full-access', justification = '需要写 profile 目录') => ({
  toolName: 'pwsh',
  callId: 'call_00_x:code:1',
  reason: `escalate sandbox to ${mode}: ${justification}`,
});

/** 构造回查结果。 */
const located = (args, cwd = 'C:\\work') => ({ command: args.command, cwd, arguments: args });

test('parseEscalationReason 解析沙箱升权 reason', () => {
  assert.deepEqual(parseEscalationReason('escalate sandbox to workspace-write: need node_modules'), {
    mode: 'workspace-write',
    justification: 'need node_modules',
  });
  assert.equal(parseEscalationReason('tool "bash" requires approval'), undefined);
  assert.equal(parseEscalationReason(undefined), undefined);
});

test('modeWithinCeiling 排序 read-only < workspace-write < danger-full-access', () => {
  assert.equal(modeWithinCeiling('workspace-write', 'workspace-write'), true);
  assert.equal(modeWithinCeiling('read-only', 'workspace-write'), true);
  assert.equal(modeWithinCeiling('danger-full-access', 'workspace-write'), false);
  assert.equal(modeWithinCeiling('danger-full-access', 'danger-full-access'), true);
  assert.equal(modeWithinCeiling('mystery', 'danger-full-access'), false);
});

test('extractSubject 优先 command，其次路径类参数', () => {
  assert.equal(extractSubject({ command: 'ls -la' }), 'ls -la');
  assert.equal(extractSubject({ file_path: 'C:/tmp/x' }), 'C:/tmp/x');
  assert.equal(extractSubject({}), undefined);
  assert.equal(extractSubject(undefined), undefined);
});

test('screen：mode=off 与接管工具名单外一律 skip', () => {
  assert.equal(screen(escalation(), located({ command: 'ls' }), { ...baseConfig, mode: 'off' }).action, 'skip');
  assert.equal(screen(escalation(), located({ command: 'ls' }), { ...baseConfig, tools: ['bash'] }).action, 'skip');
});

test('screen：非升权请求 skip（不接管宿主原有审批通道）', () => {
  const verdict = screen({ toolName: 'pwsh', reason: 'tool requires approval' }, located({ command: 'ls' }), baseConfig);
  assert.equal(verdict.action, 'skip');
  assert.match(verdict.why, /not a sandbox escalation/);
});

test('screen：超过 allowEscalationTo 直接 deny', () => {
  const verdict = screen(
    escalation('danger-full-access'),
    located({ command: 'npm install' }),
    { ...baseConfig, allowEscalationTo: 'workspace-write' },
  );
  assert.equal(verdict.action, 'deny');
  assert.match(verdict.why, /exceeds allowEscalationTo/);
});

test('screen：denyPatterns 命中直接 deny，未命中进 review', () => {
  // 样例用 mkfs：命中出厂规则、不触硬性拦截层（rm -rf 由硬性拦截层先拒，见 hard-block 矩阵）。
  const denied = screen(escalation(), located({ command: 'mkfs /dev/sda1' }), baseConfig);
  assert.equal(denied.action, 'deny');
  assert.match(denied.why, /deny pattern/);
  // 规则直拒带 source=rule：与硬性拦截的 source=hard 同走「规则命中的直接拒绝」通知通道（需求 §4.3）。
  assert.equal(denied.fields.source, 'rule');

  const reviewed = screen(escalation(), located({ command: 'npm install' }), baseConfig);
  assert.equal(reviewed.action, 'review');
  assert.equal(reviewed.fields.action, 'review');
  assert.equal(reviewed.fields.mode, 'danger-full-access');
});

test('screen：日常命令不被规则误判', () => {
  for (const command of ['npm install', 'git status', 'cargo test --all', 'rm ./target/debug/build.log', 'rm -f ./tmp.log', 'Get-ChildItem -Recurse .\\src']) {
    const verdict = screen(escalation(), located({ command }), baseConfig);
    assert.equal(verdict.action, 'review', `期望进入审查：${command}（${verdict.why}）`);
  }
});

test('screen：unknownSubject=reject 拒绝无证据请求，=review 带降级标记继续审查', () => {
  const rejected = screen(escalation(), { cwd: 'C:\\work', degraded: ['command'] }, baseConfig);
  assert.equal(rejected.action, 'deny');
  assert.equal(rejected.fields.degraded, 'command');

  const reviewed = screen(escalation(), { cwd: 'C:\\work', degraded: ['command'] }, { ...baseConfig, unknownSubject: 'review' });
  assert.equal(reviewed.action, 'review');
  assert.equal(reviewed.fields.degraded, 'command');
});

test('compilePattern 接受普通源串、字面量与非法输入', () => {
  assert.equal(compilePattern('rm -rf /').test('RM -RF /'), true);
  assert.equal(compilePattern('/rm -rf/').test('rm -rf'), true);
  assert.equal(compilePattern('['), undefined);
});

// ── deny 锚定放宽与主体全量过检（requirements §3.4／design §3.5） ───────────

test('引号/斜杠包裹的危险词仍命中（前锚＝非字母数字边界）', () => {
  // 反例参照：锚若只认 (^|[;&|\s])，这三例的包裹字符（'、"、/）都不在锚类里 → 放行进审查；现锚统一命中。
  for (const command of ["bash -c 'mkfs /dev/sda1'", 'cmd /c "format c:"', '/sbin/mkfs /dev/sda1']) {
    const verdict = screen(escalation(), located({ command }), baseConfig);
    assert.equal(verdict.action, 'deny', `应拒绝：${command}（${verdict.why}）`);
  }
});

test('主体全量过检：毒在后位键或嵌套键同样 deny 且 reason 写明键路径', () => {
  // 样例用 mkfs：后位键命中出厂规则、不触硬性拦截层（硬性拦截的键路径断言在 hard-block 矩阵）。
  const back = screen(escalation(), located({ command: 'ls', script: 'mkfs /dev/sda2' }), baseConfig);
  assert.equal(back.action, 'deny');
  assert.match(back.why, /key "script"/);
  assert.match(back.reason, /键 "script"/);

  const nested = screen(escalation(), located({ command: 'ls', env: { PAYLOAD: 'shutdown /s' } }), baseConfig);
  assert.equal(nested.action, 'deny', '嵌套对象里的字符串也要过检');
  assert.match(nested.reason, /env\.PAYLOAD/);

  // 规则层真实产物 reason 也须含「命中模式」（design §3.5 与 §8.4）——不只在 gate 侧替身与真机实测。
  assert.match(back.reason, /命中模式/, '规则层 reason 应含模式命中原语');
  assert.match(nested.reason, /命中模式/, '规则层 reason 应含模式命中原语');
});

test('误伤口径钉住：词内命中 deny、更长标识符的真后缀放行', () => {
  assert.equal(screen(escalation(), located({ command: 'grep mkfs readme.md' }), baseConfig).action, 'deny');
  assert.equal(screen(escalation(), located({ command: 'mymkfs --help' }), baseConfig).action, 'review');
});

test('回归：既有命中形态仍拒绝（锚定只收紧不放松）', () => {
  for (const command of ['rm -rf /', 'mkfs.ext4 /dev/sda1', 'shutdown now', 'dd if=/dev/zero of=/dev/sda']) {
    const verdict = screen(escalation(), located({ command }), baseConfig);
    assert.equal(verdict.action, 'deny', `应继续拒绝：${command}（${verdict.why}）`);
  }
});

// ── denyPatterns 默认不装填（requirements §5.3：denyPatterns 是用户可选文本黑名单，
// 出厂只提供参考清单）──
// baseConfig 显式展开 `[...DEFAULT_DENY_PATTERNS]`＝显式配置部署；上面的既有命中用例
// 自带显式清单、与默认值无关，天然构成显式配置行为不变的回归。

test('未配置实例的生效配置 denyPatterns 为空数组；显式写入出厂参考清单后按规则命中 deny', () => {
  assert.deepEqual(normalizeConfig().denyPatterns, []);
  // 正例段（防「删掉 deny 路径」的假实现）：清单显式写入配置 → 命中路径完整可用。
  const restored = screen(escalation(), located({ command: 'rm -rf /' }), { ...baseConfig, denyPatterns: [...DEFAULT_DENY_PATTERNS] });
  assert.equal(restored.action, 'deny');
});

test('场景回归：提交说明含出厂清单样例文本的 git commit 默认进审查', () => {
  // 样例文本用 format c:：随命令走的提交说明命中出厂规则、不触硬性拦截层
  // （说明里含 Remove-Item -Recurse 一类硬性拦截形态时按硬性拦截拒绝，偏多拦口径
  // 见 hard-block 矩阵）。
  const command = 'git commit -m "docs: warn about format c: data loss in guides"';
  // 默认侧走真 normalizeConfig()（未配置实例的生效配置），使「默认改回出厂清单」变异可检出。
  assert.equal(screen(escalation(), located({ command }), normalizeConfig()).action, 'review');
  // 同命令在显式配置清单下按规则强制拒绝（denyPatterns 的命中处理始终在，默认只是不装填清单）。
  assert.equal(screen(escalation(), located({ command }), baseConfig).action, 'deny');
});

test('误伤边界钉住（design §3.5）：默认进审查、显式配置命中 deny', () => {
  for (const command of ["bash -c 'mkfs /dev/sda1'", 'grep mkfs readme.md']) {
    const byDefault = screen(escalation(), located({ command }), normalizeConfig());
    assert.equal(byDefault.action, 'review', `默认配置应进审查：${command}`);
    const explicit = screen(escalation(), located({ command }), baseConfig);
    assert.equal(explicit.action, 'deny', `显式清单应命中 deny：${command}`);
  }
});

// ── 规则扫描次序与 unknownSubject 交叉（design §3.5 可选拒绝规则）───────────
// 前置条件＝回查参数无命令类键（即无法辨认实际操作）：规则扫描先于主体判定执行，
// 其他键的载荷同样过检；命中即直拒（不带 command 降级标记），未命中才按 unknownSubject 处置。

test('design §3.5 交叉表：无命令类键载荷命中规则 → deny 带命中键路径与模式，不带 command 降级标记（两种取值同形）', () => {
  for (const unknownSubject of ['reject', 'review']) {
    const verdict = screen(
      escalation(),
      located({ env: { PAYLOAD: 'rm -rf /' } }),
      { ...baseConfig, unknownSubject },
    );
    assert.equal(verdict.action, 'deny', `unknownSubject=${unknownSubject}：命中即直拒`);
    assert.match(verdict.why, /deny pattern/u);
    assert.match(verdict.reason, /键 "env\.PAYLOAD"/u, '拒绝理由带命中键路径');
    assert.match(verdict.reason, /命中模式/u, '拒绝理由带命中规则');
    assert.equal(verdict.fields.degraded, undefined, '规则命中的拒绝不置 command 降级标记');
  }
});

test('design §3.5 交叉表：无命令类键载荷未命中 → 按 unknownSubject 处置，两分支都带 command 降级标记', () => {
  const rejected = screen(escalation(), located({ env: { PAYLOAD: 'echo hi' } }), baseConfig);
  assert.equal(rejected.action, 'deny');
  assert.equal(rejected.fields.degraded, 'command', 'reject 取值：拒绝且带缺证标记');

  const reviewed = screen(escalation(), located({ env: { PAYLOAD: 'echo hi' } }), { ...baseConfig, unknownSubject: 'review' });
  assert.equal(reviewed.action, 'review');
  assert.equal(reviewed.fields.degraded, 'command', 'review 取值：携缺证标记进入审查');
});

test('design §3.5 回查失败无值可扫：按 unknownSubject 处置，非空规则清单不改变结果', () => {
  const rejected = screen(escalation(), null, baseConfig);
  assert.equal(rejected.action, 'deny');
  assert.equal(rejected.fields.degraded, 'command');

  const reviewed = screen(escalation(), null, { ...baseConfig, unknownSubject: 'review' });
  assert.equal(reviewed.action, 'review');
  assert.equal(reviewed.fields.degraded, 'command');
});

test('design §3.5 次序钉住：升权上限拒绝先于规则扫描（超上限的危险命令按上限拒，不按规则拒）', () => {
  const verdict = screen(
    escalation('danger-full-access'),
    located({ command: 'rm -rf /' }),
    { ...baseConfig, allowEscalationTo: 'workspace-write' },
  );
  assert.equal(verdict.action, 'deny');
  assert.match(verdict.why, /exceeds allowEscalationTo/u, '上限判定优先，不落规则命中');
});

test('design §3.5 次序钉住：mode=off 不运行规则扫描（危险命令仍 skip）', () => {
  assert.equal(screen(escalation(), located({ command: 'rm -rf /' }), { ...baseConfig, mode: 'off' }).action, 'skip');
});

test('design §3.5 键路径形态：嵌套数组下标（点分与下标组合）', () => {
  const verdict = screen(escalation(), located({ command: 'ls', notes: ['shutdown /s'] }), baseConfig);
  assert.equal(verdict.action, 'deny');
  assert.match(verdict.reason, /notes\[0\]/u);
});

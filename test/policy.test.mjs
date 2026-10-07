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
  const denied = screen(escalation(), located({ command: 'rm -rf /' }), baseConfig);
  assert.equal(denied.action, 'deny');
  assert.match(denied.why, /deny pattern/);

  const reviewed = screen(escalation(), located({ command: 'npm install' }), baseConfig);
  assert.equal(reviewed.action, 'review');
  assert.equal(reviewed.fields.action, 'review');
  assert.equal(reviewed.fields.mode, 'danger-full-access');
});

test('screen：日常命令不被规则误判', () => {
  for (const command of ['npm install', 'git status', 'cargo test --all', 'rm -rf ./target/debug', 'rm -f ./tmp.log', 'Get-ChildItem -Recurse .\\src']) {
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

// ── R35：deny 锚定放宽与主体全量过检 ─────────────────────────────────────

test('R35① 引号/斜杠包裹的危险词仍命中（前锚＝非字母数字边界）', () => {
  // 旧锚 (^|[;&|\s]) 下这三例的包裹字符（'、"、/）都不在锚类里 → 放行进审查；放宽后统一命中。
  for (const command of ["bash -c 'mkfs /dev/sda1'", 'cmd /c "format c:"', '/sbin/mkfs /dev/sda1']) {
    const verdict = screen(escalation(), located({ command }), baseConfig);
    assert.equal(verdict.action, 'deny', `应拒止：${command}（${verdict.why}）`);
  }
});

test('R35② 主体全量过检：毒在后位键或嵌套键同样 deny 且 reason 写明键路径', () => {
  const back = screen(escalation(), located({ command: 'ls', script: 'rm -rf /' }), baseConfig);
  assert.equal(back.action, 'deny');
  assert.match(back.why, /key "script"/);
  assert.match(back.reason, /键 "script"/);

  const nested = screen(escalation(), located({ command: 'ls', env: { PAYLOAD: 'shutdown /s' } }), baseConfig);
  assert.equal(nested.action, 'deny', '嵌套对象里的字符串也要过检');
  assert.match(nested.reason, /env\.PAYLOAD/);

  // R52（r49 P3-5）：规则层真实产物 reason 也须含「命中模式」——不止 gate 侧 stub 与真机实测。
  assert.match(back.reason, /命中模式/, '规则层 reason 应含模式命中原语');
  assert.match(nested.reason, /命中模式/, '规则层 reason 应含模式命中原语');
});

test('R35③④ 误伤口径钉住：词内命中 deny、更长标识符的真后缀放行', () => {
  assert.equal(screen(escalation(), located({ command: 'grep mkfs readme.md' }), baseConfig).action, 'deny');
  assert.equal(screen(escalation(), located({ command: 'mymkfs --help' }), baseConfig).action, 'review');
});

test('R35⑤ 回归：既有命中形态仍拒止（锚定只收紧不放松）', () => {
  for (const command of ['rm -rf /', 'mkfs.ext4 /dev/sda1', 'shutdown now', 'dd if=/dev/zero of=/dev/sda']) {
    const verdict = screen(escalation(), located({ command }), baseConfig);
    assert.equal(verdict.action, 'deny', `应继续拒止：${command}（${verdict.why}）`);
  }
});

// ── R51：denyPatterns 出厂默认清空（规则墙降位为用户可选黑名单） ──────────
// baseConfig 显式展开 `[...DEFAULT_DENY_PATTERNS]`＝显式配置部署；上面的既有命中用例
// 在默认值清空后不受影响，天然构成判据④（显式配置行为不变）的回归。

test('R51① 未配置实例的生效配置 denyPatterns 为空数组；显式写入出厂参考清单后命中恢复 deny', () => {
  assert.deepEqual(normalizeConfig().denyPatterns, []);
  // 恢复段（防「删掉 deny 路径」的假实现）：清单显式写入配置 → 命中路径完整可用。
  const restored = screen(escalation(), located({ command: 'rm -rf /' }), { ...baseConfig, denyPatterns: [...DEFAULT_DENY_PATTERNS] });
  assert.equal(restored.action, 'deny');
});

test('R51② 场景回归：提交说明含出厂清单样例文本的 git commit 默认进审查', () => {
  const command = 'git commit -m "docs: warn about Remove-Item -Recurse -Force on C:\\Users\\ dirs"';
  // 默认侧走真 normalizeConfig()（未配置实例的生效配置），使「默认改回出厂清单」变异可检出。
  assert.equal(screen(escalation(), located({ command }), normalizeConfig()).action, 'review');
  // 同命令在显式配置清单下仍被规则强制拒绝（原行为——墙仍在，默认不装填）。
  assert.equal(screen(escalation(), located({ command }), baseConfig).action, 'deny');
});

test('R51③ 误伤范围判据翻转钉住（§22.5 判据③）：默认进审查、显式配置恢复 deny', () => {
  for (const command of ["bash -c 'mkfs /dev/sda1'", 'grep mkfs readme.md']) {
    const byDefault = screen(escalation(), located({ command }), normalizeConfig());
    assert.equal(byDefault.action, 'review', `默认配置应进审查：${command}`);
    const explicit = screen(escalation(), located({ command }), baseConfig);
    assert.equal(explicit.action, 'deny', `显式清单应恢复 deny：${command}`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchHardDeny, screen } from '../lib/policy.js';

/**
 * 硬性危险拦截层矩阵（design §12.1，需求增补 H1/H2/H3）。
 * 全部用例都是无害文本——判定层是纯函数，从不执行命令（需求 §9：危险操作只用无害替身验证）。
 */

/** 直接对一段参数对象跑硬性拦截判定。 */
const hard = (args) => matchHardDeny({ arguments: args });
/** 直接对一条命令字符串跑硬性拦截判定（等价于 `{ command }`）。 */
const hardCmd = (command) => hard({ command });

/** screen 接线：默认配置下送升权请求（工具白名单含 pwsh）。 */
const screened = (args, cfgOverrides = {}) =>
  screen(
    { toolName: 'pwsh', callId: 'call_h:code:1', reason: 'escalate sandbox to danger-full-access: 样本' },
    { cwd: 'C:\\work', arguments: args },
    { mode: 'rules', tools: ['pwsh'], allowEscalationTo: 'danger-full-access', denyPatterns: [], unknownSubject: 'reject', ...cfgOverrides },
  );

test('H1-PowerShell：本名与六别名 × 单标志与组合全部命中', () => {
  const verbs = ['Remove-Item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir'];
  const flagSets = ['-Recurse', '-r', '-Recurse -Force'];
  for (const verb of verbs) {
    for (const flags of flagSets) {
      const hit = hardCmd(`${verb} ${flags} C:\\probe\\sample`);
      assert.ok(hit, `${verb} ${flags} 应命中`);
      assert.equal(hit.code, 'hard-h1-powershell', `${verb} ${flags} 短码`);
    }
  }
});

test('H1-PowerShell：仅 -Force 不命中 H1（枚举边界收窄），按目标字面性分流', () => {
  // 需求 §10 H1 定稿：PS 动词仅带 -Recurse 命中 H1；仅 -Force 的字面目标交审查层，
  // 非字面目标由 H2 仅强制形态拦截。
  assert.equal(hardCmd('Remove-Item -Force C:\\probe\\sample'), undefined);
  assert.equal(hardCmd('Remove-Item -Force $env:TMP\\probe').code, 'hard-h2-target');
  assert.equal(hardCmd('Remove-Item -Force $home').code, 'hard-h2-target');
});

test('H1-PowerShell：-f 歧义绑定失败，不单凭其命中', () => {
  assert.equal(hardCmd('Remove-Item -f C:\\probe\\sample'), undefined);
  assert.equal(hardCmd('rm -f file.txt'), undefined, 'rm -f 字面目标有意不命中（常见清理操作）');
  assert.equal(hardCmd('rm -f $dir/file.tmp').code, 'hard-h2-target', 'rm -f 非字面目标按 H2 仅强制形态');
});

test('H1-PowerShell：大小写不敏感与无歧义缩写', () => {
  assert.equal(hardCmd('remove-item -RECURSE .\\sample').code, 'hard-h1-powershell');
  assert.equal(hardCmd('RM -Rec x').code, 'hard-h1-powershell');
  // 实测可绑定成功的更长无歧义前缀（-zzz 一类无法绑定的串不算）。Recurse 族命中 H1。
  assert.equal(hardCmd('Remove-Item -recu .\\sample').code, 'hard-h1-powershell');
  assert.equal(hardCmd('Remove-Item -recurs .\\sample').code, 'hard-h1-powershell');
  // Force 族前缀仅构成 H2 仅强制形态的字面性分流依据，字面目标不命中 H1。
  assert.equal(hardCmd('Remove-Item -for .\\sample'), undefined);
  assert.equal(hardCmd('Remove-Item -for $env:TMP\\x').code, 'hard-h2-target');
});

test('H1-PowerShell：管道与语句中段的动词同判（误差只偏多拦）', () => {
  assert.equal(hardCmd('Get-ChildItem . | Remove-Item -Recurse').code, 'hard-h1-powershell');
});

test('H1-POSIX：rm 同时带递归与强制（聚合、拆分、长选项）', () => {
  for (const command of [
    'rm -rf /probe/sample',
    'rm -fr /probe',
    'rm -r -f /probe',
    'rm --recursive --force /probe',
    'rm --force --recursive /probe',
    'rm --recursive -f /probe',
    'rm -r --force /probe',
  ]) {
    assert.equal(hardCmd(command)?.code, 'hard-h1-posix', command);
  }
});

test('仅递归不带强制不落 POSIX 分支（rm -r 按 PowerShell 缩写族命中）', () => {
  // rm -r 是 PowerShell 别名＋-Recurse 无歧义缩写（design §12.1 判定序裁定：PS 缩写族先于 H2 判）：
  // 按 H1-PowerShell 命中；rm --recursive 才走 H2 仅递归族。
  assert.equal(hardCmd('rm -r ./sample').code, 'hard-h1-powershell');
});

test('H1-PowerShell：开关绑定写法按绑定真值计（-Recurse:$true）', () => {
  assert.equal(hardCmd('Remove-Item -Recurse:$true C:\\probe').code, 'hard-h1-powershell');
  assert.equal(hardCmd('ri -Recurse:$True $home').code, 'hard-h1-powershell', '绑定真值的 -Recurse 非字面目标仍属 H1（不看目标）');
  assert.equal(hardCmd('rm -Recurse:1 ./sample').code, 'hard-h1-powershell');
  assert.equal(hardCmd('Remove-Item -Recurse:$true -Force:$true C:\\probe').code, 'hard-h1-powershell');
  // 非零数值按 PowerShell 布尔绑定的实际结果计（`:2` 绑定为真）；零值绑定为假不构成旗标。
  assert.equal(hardCmd('Remove-Item -Recurse:2 C:\\probe').code, 'hard-h1-powershell', '非零数值绑定为真');
  assert.equal(hardCmd('Remove-Item -Recurse:0 C:\\probe'), undefined, '数值零绑定为假');
  assert.equal(hardCmd('Remove-Item -Recurse:1.5 C:\\probe').code, 'hard-h1-powershell', '非零小数绑定为真');
  // 绑定报错的串不算开关（经 Get-ChildItem -Force 实测裁定：cmdlet 开关只收布尔字面量与无符号
  // 数值，裸 true/yes/-1/abc 一律报错、命令不执行），token 回落审查层。
  assert.equal(hardCmd('Remove-Item -Recurse:abc C:\\probe'), undefined);
  assert.equal(hardCmd('Remove-Item -Recurse:true C:\\probe'), undefined, '裸 true 是字符串，绑定报错');
  assert.equal(hardCmd('Remove-Item -Recurse:-1 C:\\probe'), undefined, '带符号数值按字符串读，绑定报错');
  assert.equal(hardCmd('Remove-Item -Recurse:$TRUE C:\\probe').code, 'hard-h1-powershell', '布尔字面量任意大小写绑定为真');
  // 仅 -Force 的绑定真值进 H2 仅强制族：非字面命中、字面不命中。
  assert.equal(hardCmd('ri -Force:$True $home').code, 'hard-h2-target');
  assert.equal(hardCmd('ri -Force:2 $home').code, 'hard-h2-target', '非零数值绑定真值同入仅强制族');
  assert.equal(hardCmd('ri -Force:$True C:\\probe\\sample'), undefined);
  // 假值绑定不构成旗标命中。
  assert.equal(hardCmd('Remove-Item -Recurse:$false C:\\probe'), undefined);
  assert.equal(hardCmd('Remove-Item -Force:$false $home'), undefined);
});

test('H1-CMD：del/erase 带 /f、rd/rmdir 带 /s 与 /q（含合并簇与斜杠分隔写法）', () => {
  assert.equal(hardCmd('del /f C:\\probe\\sample').code, 'hard-h1-cmd');
  assert.equal(hardCmd('erase /f C:\\probe').code, 'hard-h1-cmd');
  assert.equal(hardCmd('rd /s /q C:\\probe').code, 'hard-h1-cmd');
  assert.equal(hardCmd('rmdir /S /Q C:\\probe').code, 'hard-h1-cmd');
  // cmd 实测合法的合并写法：/s/q、/sq、/f/q、/f/s/q。
  assert.equal(hardCmd('rd /s/q C:\\probe').code, 'hard-h1-cmd');
  assert.equal(hardCmd('rmdir /sq C:\\probe').code, 'hard-h1-cmd');
  assert.equal(hardCmd('del /f/q C:\\probe').code, 'hard-h1-cmd');
  assert.equal(hardCmd('del /f/s/q C:\\probe').code, 'hard-h1-cmd');
});

test('H2：仅递归族目标非字面命中，字面路径不命中', () => {
  assert.equal(hardCmd('rm --recursive $dir').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive $env:TMP').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive $(pwd)/build').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive ~/docs/cache').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /s %TEMP%\\probe').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /s $env:TEMP\\probe').code, 'hard-h2-target');
  // 无操作数＝目标无从证明字面（宁可误拦）。
  assert.equal(hardCmd('rm --recursive').code, 'hard-h2-target');
});

test('H2：字面目标不命中（正例不受影响）', () => {
  assert.equal(hardCmd('rm --recursive /data/literal-cache'), undefined);
  assert.equal(hardCmd('rm --recursive ./build/dist'), undefined);
  assert.equal(hardCmd('rm --recursive /a'), undefined, 'POSIX 语境单字母根路径是操作数不是旗标');
  assert.equal(hardCmd('rd /s C:\\probe\\literal'), undefined);
  assert.equal(hardCmd('rd /s /data'), undefined, 'CMD 族 4 字母以上斜杠 token 按操作数（短路径不当旗标跳过）');
  assert.equal(hardCmd('del /s C:\\probe\\literal'), undefined);
});

test('H2：del/erase 仅 /s 归仅递归族，目标非字面命中', () => {
  assert.equal(hardCmd('del /s %TEMP%\\probe').code, 'hard-h2-target');
  assert.equal(hardCmd('erase /s $env:TMP\\probe').code, 'hard-h2-target');
});

test('H2：仅强制形态族——目标非字面命中，字面目标交审查层', () => {
  // 需求 §10 H2 定稿：形态口径宽于 H1 枚举，仅强制形态（PS -Force、rm -f、del /f 之外的 CMD 强制位、rd /q）
  // 目标无法从字面确定即命中；字面目标不属任何硬性拦截。
  assert.equal(hardCmd('rm -f $dir/file.tmp').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --force $dir').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /q %TEMP%\\probe').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /q $env:TEMP\\probe').code, 'hard-h2-target');
  assert.equal(hardCmd('rmdir /q %TEMP%\\probe').code, 'hard-h2-target');
  // 字面目标不命中（del/erase /f 例外：属 H1-CMD 枚举，始终硬性拦截）。
  assert.equal(hardCmd('rd /q C:\\probe\\literal'), undefined);
  assert.equal(hardCmd('rm --force ./file.tmp'), undefined);
  assert.equal(hardCmd('Remove-Item -Force C:\\probe\\literal'), undefined);
  // 无操作数＝目标无从证明字面（宁可误拦）。
  assert.equal(hardCmd('rd /q').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --force').code, 'hard-h2-target');
});

test('H2：事故形态重放——脚本内先赋值再引用的强制递归删除', () => {
  // 需求 H2 事故实况的替身重放：$home 是只读自动变量，赋值静默失败、删除指向真实主目录。
  // 按分号拆语句后第二句命中 H1（强制＋递归），不需要变量追踪。
  const hit = hardCmd('$home = "C:\\probe\\t"; Remove-Item -Recurse -Force $home');
  assert.equal(hit?.code, 'hard-h1-powershell');
});

test('H2：未赋值变量引用与命令替换作目标', () => {
  assert.equal(hardCmd('rm --recursive $undeclared').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive `pwd`').code, 'hard-h2-target');
});

test('H3：两个硬性拦截入口正例', () => {
  assert.equal(hardCmd('mshta https://probe.example/sample').code, 'hard-h3-entry');
  assert.equal(hardCmd('mshta.exe http://probe.example').code, 'hard-h3-entry');
  assert.equal(hardCmd('rundll32 url.dll,FileProtocolHandler https://probe.example/x').code, 'hard-h3-entry');
  assert.equal(hardCmd('rundll32 C:\\Windows\\System32\\url.dll,FileProtocolHandler http://probe.example').code, 'hard-h3-entry');
});

test('H3：入口在语句中段同判（与 H1 同取动词任意位置口径）', () => {
  assert.equal(hardCmd('start mshta https://probe.example').code, 'hard-h3-entry');
  assert.equal(hardCmd('Start-Process mshta https://probe.example').code, 'hard-h3-entry');
  assert.equal(hardCmd('npm i && mshta https://probe.example').code, 'hard-h3-entry');
  assert.equal(hardCmd('& mshta https://probe.example').code, 'hard-h3-entry');
  assert.equal(hardCmd('cmd /c start mshta https://probe.example').code, 'hard-h3-entry');
  assert.equal(hardCmd('start rundll32 url.dll,FileProtocolHandler https://probe.example').code, 'hard-h3-entry');
});

test('H3：Start-Process 与 explorer 不做硬性拦截（走 3.3 第 6 条审查）', () => {
  assert.equal(hardCmd('Start-Process https://probe.example'), undefined);
  assert.equal(hardCmd('explorer https://probe.example'), undefined);
  assert.equal(hardCmd('mshta vbscript:msgbox'), undefined, '非 http(s) 形态不在 H3 字面域');
  // screen 级：不触发硬性拦截的同时仍进审查层（3.3 第 6 条触网打开指引），不是放行。
  assert.equal(screened({ command: 'Start-Process https://probe.example' }).action, 'review');
  assert.equal(screened({ command: 'explorer https://probe.example' }).action, 'review');
});

test('命令文本内的引号段按整体过检（不做内容级豁免）', () => {
  // 需求 §10 H1 定稿尾句：写在命令文本内部的内容（如 git commit -m 的引号内说明）不做内容级
  // 识别与豁免，按命令文本整体过检；误命中按 §3.3 改写重送条款消化。
  assert.equal(hardCmd('git commit -m "Remove-Item -Recurse -Force C:\\probe\\a"').code, 'hard-h1-powershell');
  assert.equal(hardCmd('git commit -am "rd /s /q %TEMP%\\probe"').code, 'hard-h1-cmd');
  assert.equal(hardCmd('echo "rm -rf /probe/sample"').code, 'hard-h1-posix', '引号段属命令文本，偏多拦口径');
  assert.equal(hardCmd("& 'Remove-Item' -Force $home").code, 'hard-h2-target', '调用算子引号形态同样过检');
  // 旗标侧同样剥引号：shell 先行去引号后 `rm "-rf"` 等价 `rm -rf`，不剥会留下绕过 H1 的降级缝。
  assert.equal(hardCmd('rm "-rf" /probe/sample').code, 'hard-h1-posix');
  assert.equal(hardCmd("rm '-r' '-f' /probe/sample").code, 'hard-h1-posix');
  assert.equal(hardCmd('rm "-r" "-f" /probe/sample').code, 'hard-h1-posix');
  assert.equal(hardCmd('bash -c \'rm "-rf" /probe/sample\'')?.code, 'hard-h1-posix', '包装剥层后内层旗标同样剥引号');
  // 随之的偏多拦（既定口径，§3.3 改写重送消化）：样例串含枚举形态的搜索/回显类命令同样命中。
  assert.equal(hardCmd('grep -n "rm -rf /probe" notes.md')?.code, 'hard-h1-posix');
  // 反例保持：独立字段（与命令分列的说明键）含相同字样仍不命中；良性引号参数不误拦。
  assert.equal(hard({ command: 'git commit', description: 'Remove-Item -Recurse -Force 样本说明' }), undefined);
  assert.equal(hardCmd('git commit -m "docs: update changelog"'), undefined);
  assert.equal(hardCmd('npm run "build:clean"'), undefined);
});

test('匹配对象：随行文字不命中（三键白名单，字符串与数组值同判）', () => {
  assert.equal(hard({ description: 'rm -rf / --force', commit: 'del /f C:\\x' }), undefined);
  assert.equal(hard({ reason: 'Remove-Item -Recurse -Force 样本说明' }), undefined);
  // 非命令键的数组值同样属随行文字，不因数组形态参与装配。
  assert.equal(hard({ command: 'git commit', message: ['docs: mention rm -rf / in notes'] }), undefined);
  assert.equal(hard({ description: ['Remove-Item -Recurse -Force C:\\probe'] }), undefined);
  assert.equal(hard({ reason: ['escalate: del /f C:\\x'] }), undefined);
  // H3 侧：随行文字含网址与入口名同样不误中。
  assert.equal(hard({ description: '参考 mshta 与 https://probe.example 的文档' }), undefined);
});

test('匹配对象：参数根数组内的对象元素继续探取命令键', () => {
  assert.equal(matchHardDeny({ arguments: [{ command: 'rm -rf /probe' }] })?.code, 'hard-h1-posix');
  assert.equal(matchHardDeny({ arguments: [{ note: 'rm -rf / 文字' }] }), undefined, '非命令键对象元素仍不装配');
  assert.equal(hard({ command: 'npm test', tags: [{ note: 'rm -rf /' }] }), undefined, '非根数组不产出命令段');
});

test('匹配对象：args/argv 拼接后命中（标志拆在数组里）', () => {
  assert.equal(hard({ command: 'rm', args: ['-rf', '/probe/sample'] })?.code, 'hard-h1-posix');
  assert.equal(hard({ cmd: 'rd', argv: ['/s', '/q', 'C:\\probe'] })?.code, 'hard-h1-cmd');
  assert.equal(hard({ script: 'Remove-Item', args: ['-Recurse', 'C:\\probe'] })?.code, 'hard-h1-powershell');
  // 嵌套对象里的命令键同样装配（深度口径 ≤4）。
  assert.equal(hard({ tool: { spec: { command: 'rm -rf /probe' } } })?.code, 'hard-h1-posix');
});

test('匹配对象：数组形态的命令文本同样装配（命令值、独立 args/argv、参数根、一层嵌套数组）', () => {
  assert.equal(hard({ command: ['rm', '-rf', '/probe/sample'] })?.code, 'hard-h1-posix');
  assert.equal(hard({ args: ['bash', '-c', 'rm -rf /probe'] })?.code, 'hard-h1-posix');
  assert.equal(hard({ argv: ['cmd', '/c', 'rd /s/q C:\\probe'] })?.code, 'hard-h1-cmd');
  assert.equal(matchHardDeny({ arguments: ['powershell', '-Command', 'Remove-Item -Recurse C:\\probe'] })?.code, 'hard-h1-powershell');
  assert.equal(hard({ command: 'rm', args: [['-rf', '/probe/sample']] })?.code, 'hard-h1-posix', '一层嵌套数组元素同样拼接');
});

test('无命令键不命中（本层无可判定对象）', () => {
  assert.equal(hard({ path: 'C:\\probe', pattern: 'Remove-Item -Recurse' }), undefined);
  assert.equal(matchHardDeny(null), undefined);
});

test('多行脚本按换行与分号拆语句逐条判定', () => {
  const hit = hard({ script: 'Write-Output a\nWrite-Output b; Remove-Item -Recurse C:\\probe' });
  assert.equal(hit?.code, 'hard-h1-powershell');
  assert.equal(hit?.key, 'script');
});

test('包装剥层：内层命中并记层数', () => {
  const one = hardCmd('powershell -Command "Remove-Item -Recurse -Force $home"');
  assert.equal(one?.code, 'hard-h1-powershell');
  assert.equal(one?.wrapDepth, 1);
  const two = hardCmd('cmd /c rd /s /q C:\\probe');
  assert.equal(two?.code, 'hard-h1-cmd');
  assert.equal(two?.wrapDepth, 1);
  const three = hardCmd('bash -c "rm -rf /probe"');
  assert.equal(three?.code, 'hard-h1-posix');
  assert.equal(three?.wrapDepth, 1);
  const nested = hardCmd('powershell -Command "cmd /c del /f C:\\probe"');
  assert.equal(nested?.code, 'hard-h1-cmd');
  assert.equal(nested?.wrapDepth, 2);
});

test('包装剥层：深度上限与无法提取的回落', () => {
  // 四层包装超过三层上限：按无法归一处理，不命中、回落审查层。
  assert.equal(hardCmd('powershell -Command powershell -Command powershell -Command powershell -Command rm -rf /probe'), undefined);
  // 执行标志后无内层文本：无法提取。
  assert.equal(hardCmd('powershell -Command'), undefined);
  // 解释器无执行标志：无法归一，不猜。
  assert.equal(hardCmd('powershell -NoProfile rm -rf /probe'), undefined);
});

test('混淆写法不命中（无法归一＝回落审查层，不是安全证据）', () => {
  // U+2011 非断行连字符：不是 ASCII 连字符，-Recurse 归一失败。
  assert.equal(hardCmd('Remove\u2011Item -Recurse C:\\probe'), undefined);
  // 反引号拆分动词：PowerShell 行接续形态，token 边界不含完整动词。
  assert.equal(hardCmd('Remove-`Item -Recurse C:\\probe'), undefined);
  // screen 级：不命中硬性拦截的同时仍交审查层（3.3 第 4 条保守处理），不是放行。
  assert.equal(screened({ command: 'Remove\u2011Item -Recurse C:\\probe' }).action, 'review');
});

test('普通读写命令与不带标志的删除不命中', () => {
  assert.equal(hardCmd('npm install'), undefined);
  assert.equal(hardCmd('Get-Content C:\\probe\\log.txt'), undefined);
  assert.equal(hardCmd('Remove-Item C:\\probe\\single.txt'), undefined);
  assert.equal(hardCmd('rm ./one.tmp'), undefined);
  assert.equal(hardCmd('rd C:\\probe\\empty'), undefined);
});

test('screen 接线：命中返回 deny 与 source=hard、理由带短码与键路径', () => {
  const result = screened({ command: 'Remove-Item -Recurse -Force C:\\probe' });
  assert.equal(result.action, 'deny');
  assert.equal(result.fields.source, 'hard');
  assert.match(result.why, /hard deny hard-h1-powershell: key "command" wrap 0/);
  assert.match(result.reason, /命中硬性危险拦截（hard-h1-powershell）/);
  assert.match(result.reason, /命令键 "command"/);
  const wrapped = screened({ command: 'powershell -Command "Remove-Item -Recurse C:\\probe"' });
  assert.match(wrapped.reason, /包装 1 层/);
});

test('screen 接线：本层先于 denyPatterns（同命中时按硬性拦截拒绝）', () => {
  const result = screened({ command: 'Remove-Item -Recurse C:\\probe' }, { denyPatterns: ['Remove-Item'] });
  assert.equal(result.action, 'deny');
  assert.match(result.why, /hard deny hard-h1-powershell/, '硬性拦截先命中，why 不是规则模式');
});

test('screen 接线：三类跳过分支先于本层（跳过即不接管）', () => {
  const args = { command: 'rm -rf /probe' };
  assert.equal(screened(args, { mode: 'off' }).action, 'skip');
  assert.equal(screened(args, { tools: ['edit'] }).action, 'skip');
  const nonEscalation = screen(
    { toolName: 'pwsh', callId: 'c', reason: '普通说明，不含升权形态' },
    { arguments: args },
    { mode: 'rules', tools: [], denyPatterns: [] },
  );
  assert.equal(nonEscalation.action, 'skip');
});

test('screen 接线：升权上限仍先于本层（更严的先判）', () => {
  const result = screened({ command: 'rm -rf /probe' }, { allowEscalationTo: 'workspace-write' });
  assert.equal(result.action, 'deny');
  assert.match(result.why, /exceeds allowEscalationTo/);
});

test('screen 接线：硬性拦截未命中时规则层照常（两层独立）', () => {
  const result = screened({ command: 'npm install', description: 'probe' }, { denyPatterns: ['npm install'] });
  assert.equal(result.action, 'deny');
  assert.match(result.why, /deny pattern/);
  const pass = screened({ command: 'npm install' });
  assert.equal(pass.action, 'review');
});

// ── 簇规则、参数边界扫描与引号感知拆句（design §12.1 定稿） ──────────────────────

test('rm 较长短标志簇按 POSIX 小写短旗标集读，簇内全属集才命中 H1', () => {
  // 簇规则 `^-[a-z]+$` 且每个字母 ∈ {r,f,i,d,v,p}：-rfvv/-frvvv/-irfdvp 都是递归＋强制的簇。
  assert.equal(hardCmd('rm -rfvv ./fixture').code, 'hard-h1-posix');
  assert.equal(hardCmd('rm -frvvv ./fixture').code, 'hard-h1-posix');
  assert.equal(hardCmd('rm -irfdvp ./fixture').code, 'hard-h1-posix');
  assert.equal(hardCmd('rm -Rf /').code, 'hard-h1-posix');
  assert.equal(hardCmd('rm -rf ./fixture').code, 'hard-h1-posix');
  // 集外字母（-force 含 o/u/c/e）不按簇读：字面目标交审查层，非字面目标按 H2。
  assert.equal(hardCmd('rm -force ./x'), undefined);
  assert.equal(hardCmd('rm -f ./x'), undefined);
  assert.equal(hardCmd('rm -f $dir').code, 'hard-h2-target');
});

test('参数边界扫描——目标/开关/取值/未识别四类参数各自归位', () => {
  // 公共参数值（-ErrorAction Continue 的 Continue）是取值参数的值，不再当目标候选；
  // 目标参数（-LiteralPath/-Path）的绑定值与后随位置参按目标计。
  assert.equal(hardCmd('Remove-Item -Force -LiteralPath:$home -ErrorAction Continue').code, 'hard-h2-target');
  assert.equal(hardCmd('Remove-Item -Force -Path:$home').code, 'hard-h2-target');
  assert.equal(hardCmd('Remove-Item -Force -LiteralPath $home').code, 'hard-h2-target');
  assert.equal(hardCmd('Remove-Item -ErrorAction Continue -Force -Path $env:TMP').code, 'hard-h2-target');
  // 开关族后的取值参数值被跳过：无目标候选 → 按无字面目标命中 H2。
  assert.equal(hardCmd('Remove-Item -Force -ErrorAction Continue').code, 'hard-h2-target');
  // 未识别参数的绑定值保守按目标候选处理（宁可偏多拦）。
  assert.equal(hardCmd('Remove-Item -Force -Foo:$home').code, 'hard-h2-target');
  // 目标参数给字面路径则不命中（H1/H2 都按目标字面性分流）。
  assert.equal(hardCmd('Remove-Item -Force -LiteralPath:C:\\x'), undefined);
  assert.equal(hardCmd('Remove-Item -Force -LiteralPath C:\\x'), undefined);
  assert.equal(hardCmd('ri -Force:$True C:\\x'), undefined);
  assert.equal(hardCmd('Remove-Item -f C:\\x'), undefined);
  // 取值参数（-Filter）的值跳过、后随位置参才是目标；字面目标不命中。
  assert.equal(hardCmd('Remove-Item -Force -Filter $pat ./x'), undefined);
  assert.equal(hardCmd('Remove-Item -Force $home').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive $dir').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /q %TEMP%').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /q C:\\tmp'), undefined);
});

test('引号感知拆句——引号内的分隔符不拆、真分隔符照拆、未闭合到末尾', () => {
  // 单/双引号内的 `;` 是路径字面，不在该处拆句；引号段整体过检。
  assert.equal(hardCmd("Remove-Item 'C:\\harmless;example' -Recurse").code, 'hard-h1-powershell');
  assert.equal(hardCmd('Remove-Item "C:\\a;b" -Recurse').code, 'hard-h1-powershell');
  assert.equal(hardCmd("bash -c \"Remove-Item 'a;b' -Recurse\"").code, 'hard-h1-powershell');
  // 引号内的换行同样是路径字面：语句不被拆散，动词与标志同句命中。
  assert.equal(hardCmd('Remove-Item "C:\\a\nb" -Recurse').code, 'hard-h1-powershell');
  // 转义写法不解释（每个引号字符都切换引号态，design §12.1）：PowerShell 的成对单引号转义
  // 被读作开合——引号态提前切换使边界偏早，误差方向偏多拦（拆出的片段各自整体过检）。
  assert.equal(hardCmd("Remove-Item 'C:\\it''s dir' -Recurse").code, 'hard-h1-powershell');
  // 未闭合引号：余下全文按一段处理（误差只偏多拦）。
  assert.equal(hardCmd("rm -rf 'abc").code, 'hard-h1-posix');
  // 引号外的真分隔符仍拆句逐条判定。
  assert.equal(hardCmd("$home = 'C:\\t'; Remove-Item -Recurse -Force $home").code, 'hard-h1-powershell');
  assert.equal(hardCmd('Remove-Item -Recurse -Force ./x').code, 'hard-h1-powershell');
  assert.equal(hardCmd('rm -r ./x').code, 'hard-h1-powershell');
  // 无害文本不受引号拆句影响。
  assert.equal(hardCmd("Write-Output 'a;b'"), undefined);
});

test('簇/参数扫描/引号拆句的控制形态：既有偏多拦口径与 CMD 族回归保持', () => {
  assert.equal(hardCmd('git commit -m "Remove-Item -Recurse x"').code, 'hard-h1-powershell');
  assert.equal(hardCmd('grep -n "rm -rf /"').code, 'hard-h1-posix');
  assert.equal(hardCmd('echo "rm -rf /"').code, 'hard-h1-posix');
  assert.equal(hardCmd('rm "-rf" /probe').code, 'hard-h1-posix');
  assert.equal(hardCmd('del /f C:\\x\\y').code, 'hard-h1-cmd');
  assert.equal(hardCmd('rd /s /q C:\\x').code, 'hard-h1-cmd');
  assert.equal(hardCmd('rd /sq C:\\x').code, 'hard-h1-cmd');
  assert.equal(hardCmd('rd /s C:\\x'), undefined);
  assert.equal(hardCmd('rd /s $dir').code, 'hard-h2-target');
  assert.equal(hardCmd('del /s C:\\lit'), undefined);
});

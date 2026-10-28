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

test('H1-PowerShell：仅 -Force 不命中 H1（枚举边界收窄），H2 按目标字面性分流', () => {
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
  // Force 族前缀不构成 H1 的递归依据（H1 只认 Recurse 族，不看目标字面性）；
  // 它构成 H2 仅强制形态，H2 在该形态下按目标字面性分流。
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

test('H2：脚本内先赋值再引用的强制递归删除——拆句后第二句命中 H1', () => {
  // $home 是只读自动变量：赋值报错但不终止脚本，变量保持真实值——脚本内
  // 先赋值再引用形态的真实语义。按分号拆语句后第二句命中 H1（强制＋递归），不需要变量追踪。
  const hit = hardCmd('$home = "C:\\probe\\t"; Remove-Item -Recurse -Force $home');
  assert.equal(hit?.code, 'hard-h1-powershell');
});

test('H2：未赋值变量引用与命令替换作目标', () => {
  assert.equal(hardCmd('rm --recursive $undeclared').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive `pwd`').code, 'hard-h2-target');
});

test('H2：`--` 长选项的冒号绑定值按目标候选过标记检查（design §12.1）', () => {
  // 形态族在场（--force／--recursive）时，未识别长选项的绑定值不因 `--` 前缀豁免：
  // 含 $ 标记 → 不可字面 → H2 拒（宁可误拦）。
  assert.equal(hardCmd('rm --force --foo:$home /etc/x').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --recursive --foo:$home /etc/x').code, 'hard-h2-target');
  // 对照：字面绑定值不命中；裸分隔符（恰为 `--`）无绑定值、行为不变；
  // 不属形态族的 `--` 绑定值照旧放行（H2 只作用于仅递归/仅强制形态）。
  assert.equal(hardCmd('rm --force --foo:/etc/lit /etc/x'), undefined);
  assert.equal(hardCmd('rm -f -- /etc/x'), undefined);
  assert.equal(hardCmd('rm -f -- $home').code, 'hard-h2-target');
  assert.equal(hardCmd('rm --foo:$home /etc/x'), undefined);
});

test('H2：`--` 选项结束后的操作数态——负号动态目标过检（design §12.1）', () => {
  // design §12.1 选项结束与操作数态：恰为 `--` 的裸 token 触发切换，其后 token 不再按旗标/参数
  // 归类、整 token 按位置操作数过检——负号开头的动态目标（变量/命令替换）必须按操作数过检，不得按旗标跳过。
  assert.equal(hardCmd('rm -f -- literal.tmp "-$victim"').code, 'hard-h2-target');
  assert.equal(hardCmd('rm -f -- literal.tmp "-$(printf victim)"').code, 'hard-h2-target');
  assert.equal(hardCmd('rm -f -- "-$victim"').code, 'hard-h2-target', '无前置字面目标控制同样命中');
  assert.equal(hardCmd('rm -f -- @targets').code, 'hard-h2-target', '操作数态与并集前缀叠加');
  assert.equal(hardCmd('rm -f -- --$victim').code, 'hard-h2-target', '操作数态后 `--` 前缀 token 是操作数');
  // 字面负号文件名不含动态标记，不误拦；`--force` 非裸分隔符、不触发切换。
  assert.equal(hardCmd('rm -f -- literal.tmp -literal.tmp'), undefined);
  assert.equal(hardCmd('rm -f --force literal.tmp'), undefined);
  assert.equal(hardCmd('rm -f -- --'), undefined, '第二个 `--` 是字面文件名操作数');
  // 旗标层不因 `--` 停扫（design §12.1）：`rm -- -r x` 仍按 -Recurse 缩写命中 H1（偏误拦，经 3.3 改写重送消化）。
  assert.equal(hardCmd('rm -- -r ./sample').code, 'hard-h1-powershell');
});

test('H2：横线 token 自身含族动态标记即按目标候选过检（三族统一）', () => {
  // del/erase/rd/rmdir 在 CMD 真实语义不解析横线选项，负号 token 就是待删文件名，
  // `%VAR%`/`!名字!` 在双引号内照常展开（design §12.1 横线动态候选规则）。
  assert.equal(hardCmd('del /s literal.tmp "-%VAR%"').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /q literal.tmp "-!victim!"').code, 'hard-h2-target');
  assert.equal(hardCmd('rm -f literal.tmp "-$victim"').code, 'hard-h2-target', '无 `--` 的前置字面目标形态同缝闭合');
  // `!` 仅作 CMD 族标记：POSIX 语境的 `!` 是文件名字面字符。
  assert.equal(hardCmd('rm -f literal.tmp "-!victim!"'), undefined);
  assert.equal(hardCmd('rm -f literal.tmp "!victim"'), undefined, '位置操作数的 `!` 同为字面字符');
  // 字面负号文件名不含标记，仍按旗标跳过。
  assert.equal(hardCmd('rm -f literal.tmp -literal.tmp'), undefined);
  // 已识别参数（目标/取值/开关）的绑定值按各自分类条款判定，横线动态候选不改判。
  assert.equal(hardCmd('remove-item -exclude:-$victim literal.tmp'), undefined, '取值参数冒号绑定值含标记仍跳过');
  assert.equal(hardCmd('Remove-Item -Force @targets').code, 'hard-h2-target', 'PS 族既有拒绝回归');
});

test('H2：跨 shell 删除动词的保守并集——PowerShell 动态前缀（design §12.1）', () => {
  // rm/del/erase/rd/rmdir 在 PowerShell 里都是 Remove-Item 别名，其 PowerShell 读法无法静态排除：
  // 两族并入 `@` splat 与 `(` 子表达式前导前缀（仍只认串首），POSIX/CMD 字面反例不受影响。
  assert.equal(hardCmd('rm -Force @targets').code, 'hard-h2-target');
  assert.equal(hardCmd('del -Force (Join-Path C:\\temp victim)').code, 'hard-h2-target');
  assert.equal(hardCmd('erase -Force @paths').code, 'hard-h2-target');
  assert.equal(hardCmd('rd /q @targets').code, 'hard-h2-target');
  assert.equal(hardCmd('rm -f @targets.txt').code, 'hard-h2-target', '串首 @ 的字面名计入误拦（经改写重送消化）');
  assert.equal(hardCmd('del /s C:\\temp\\victim.tmp'), undefined, '字面路径反例');
  assert.equal(hardCmd('rm -f /tmp/a.tmp'), undefined, '斜杠路径反例（POSIX 语境斜杠 token 是操作数）');
  assert.equal(hardCmd('Remove-Item -Force C:\\probe\\literal'), undefined, '本名字面反例不回归');
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

test('包装内层按引号感知规则重拆：无空格分号与直写同口径（design §12.1）', () => {
  // 内层分号后无空格（`ok;rm` 粘连）与有空格同判——重拆用与外层同一规则。
  const bashGlued = hardCmd('bash -c "echo ok;rm -rf /not-real"');
  assert.equal(bashGlued?.code, 'hard-h1-posix', '内层无空格分号拆出的 rm -rf 命中 H1');
  assert.equal(bashGlued?.wrapDepth, 1);
  const pwshGlued = hardCmd('pwsh -Command "Write-Output ok;mshta https://example.invalid/"');
  assert.equal(pwshGlued?.code, 'hard-h3-entry', '内层无空格分号拆出的 mshta 加载网址命中 H3');
  assert.equal(pwshGlued?.wrapDepth, 1);
  // 等价性双向：同一文本直写命中 ⇔ 作为包装内层命中（差仅层数）。
  const direct = hardCmd('echo ok;rm -rf /not-real');
  assert.equal(direct?.code, 'hard-h1-posix');
  assert.equal(direct?.wrapDepth, 0);
  const spaced = hardCmd('bash -c "echo ok; rm -rf /not-real"');
  assert.equal(spaced?.code, 'hard-h1-posix', '有空格分号同样命中');
  // 内层换行也是语句边界：多行脚本同样逐句判定。
  const multiline = hardCmd('bash -c "Remove-Item -Recurse C:\\probe\nWrite-Output ok"');
  assert.equal(multiline?.code, 'hard-h1-powershell', '内层按换行拆句后逐句判定');
});

test('包装内层多语句逐句判定、首个命中即拒；两层包装逐层重拆', () => {
  const multi = hardCmd('pwsh -Command "Write-Output a; Write-Output b; Remove-Item -Recurse C:\\probe"');
  assert.equal(multi?.code, 'hard-h1-powershell', '第三条语句才命中：逐句判定不漏中后段');
  const twoLayers = hardCmd("bash -c \"bash -c 'echo ok;rm -rf /not-real'\"");
  assert.equal(twoLayers?.code, 'hard-h1-posix', '两层包装每层剥出后都先重拆再逐句判定');
  assert.equal(twoLayers?.wrapDepth, 2);
});

test('包装内层引号内的分号不拆：重拆保持引号感知边界', () => {
  // 反例：分号在引号内——naive 按 `;` 拆会把 `rm -rf /not-real'` 拆成第二条语句造成误拦。
  assert.equal(hardCmd("bash -c \"echo 'x;rm -rf /not-real'\""), undefined, '引号内的分号不产生第二条语句');
  // 引号内路径分号：重拆后仍单语句，命中来自该语句自身的删除动词（非拆散产物）。
  const quotedPath = hardCmd('bash -c "Remove-Item \'C:\\a;b\' -Recurse"');
  assert.equal(quotedPath?.code, 'hard-h1-powershell', '单语句按动词＋-Recurse 命中');
  assert.equal(quotedPath?.wrapDepth, 1);
});

test('包装剥层：POSIX 短旗标簇同按执行标志剥层', () => {
  // 簇形态正例（design §12.1）：单横线＋小写字母且簇内含 c，命令文本取自标志 token 之后。
  assert.equal(hardCmd("bash -lc 'rm -rf /probe'")?.code, 'hard-h1-posix');
  assert.equal(hardCmd("sh -ic 'rm -fr /probe'")?.code, 'hard-h1-posix');
  assert.equal(hardCmd('zsh -euc rm -rf /probe')?.code, 'hard-h1-posix');
  // 簇内 c 前后皆可：剥的仍是标志 token 之后的文本。
  assert.equal(hardCmd("dash -cl 'rm -rf /probe'")?.code, 'hard-h1-posix');
  // 含 o 的簇不认（o 取实参，c 被吃成实参值或 o 抢走后随 token）：无法归一，回落审查层。
  assert.equal(hardCmd("bash -oc 'rm -rf /probe'"), undefined);
  assert.equal(hardCmd("bash -co 'rm -rf /probe'"), undefined);
  // 大写不属簇（-C/-L 是别的选项或无效）；pwsh 非 POSIX 首词，簇规则不适用（其 -c 是 -Command 缩写）。
  assert.equal(hardCmd("bash -LC 'rm -rf /probe'"), undefined);
  assert.equal(hardCmd('pwsh -lc Remove-Item -Recurse C:\\probe'), undefined);
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
  // 本组均为仅 Force 形态：不命中 H1（H1 只认 Recurse 族），由 H2 在仅强制
  // 形态下判断目标——目标参数给字面路径则不拦，交审查层。
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

// ── 动态删除目标的确定性拦截（design §12.1 按命令族分道）——回归钉住 ─────────────
// 口径共 30 条：14 条失败组（应确定性拒绝）＋16 条对照组（不回退）。

test('动态删除目标失败组：确定性拒绝（deny＋source=hard＋短码，不经 LLM）', () => {
  // [命令, 期望短码]：初始反例五条 ＋ 包装 del ＋ 近邻（顺序、混合目标、标志后置、
  // 嵌套表达式、含空格延迟变量名、cmd /k 包装、cmd /k 的 H1 形态、标志后置裸形态）。
  const failures = [
    ['rm -i $victim -f ./literal', 'hard-h2-target'],
    ['cmd /v:on /c "rd /s !ACCEPT_TARGET!"', 'hard-h2-target'],
    ['del /s !ACCEPT_TARGET!', 'hard-h2-target'],
    ['Remove-Item @ACCEPT_PATHS -Force', 'hard-h2-target'],
    ["Remove-Item -Force (Join-Path 'D:/accept' 'child')", 'hard-h2-target'],
    ['cmd /v:on /c "del /s !ACCEPT_TARGET!"', 'hard-h2-target'],
    ['rd /s D:/accept/literal !ACCEPT_TARGET!', 'hard-h2-target'],
    ['cmd /v:on /c "rd !ACCEPT_TARGET! /s"', 'hard-h2-target'],
    ['rd !ACCEPT_TARGET! /s', 'hard-h2-target'],
    ['Remove-Item -Force ((Get-ChildItem).FullName)', 'hard-h2-target'],
    ['rm -i -f $victim', 'hard-h2-target'],
    ['rd /s !AC CEPT!', 'hard-h2-target'],
    ['cmd /v:on /k "rd /s !ACCEPT_TARGET!"', 'hard-h2-target'],
    ['cmd /k "rd /s /q D:\\accept\\literal"', 'hard-h1-cmd'],
  ];
  for (const [command, code] of failures) {
    const result = screened({ command });
    assert.equal(result.action, 'deny', command);
    assert.equal(result.fields.source, 'hard', command);
    assert.match(result.why, new RegExp(`hard deny ${code}:`), command);
  }
});

test('动态删除目标对照组：字面与既有形态不回退（16 条）', () => {
  const controls = [
    // [命令, 期望]：undefined＝不命中硬性拦截（交审查层），字符串＝期望短码。
    ['rm -f ./literal', undefined],
    ['rd /s D:\\accept\\literal', undefined],
    ['Remove-Item -Force D:/accept/literal', undefined],
    ['rm -rfvv ./fixture', 'hard-h1-posix'],
    ['Remove-Item -Recurse D:/accept/literal', 'hard-h1-powershell'],
    ['Remove-Item -ErrorAction:Continue -Force D:/accept/literal', undefined],
    ['Remove-Item -Force:$true D:/accept/literal', undefined],
    ['Remove-Item -Force:-1 D:/accept/literal', undefined],
    ["Remove-Item 'C:\\a;b' -Force", undefined],
    ['rm -i -f ./literal', undefined],
    ['rm -f $victim ./literal', 'hard-h2-target'],
    ['cmd /c "rd /s /q D:\\accept\\literal"', 'hard-h1-cmd'],
    ['Remove-Item -Include $x -Force', 'hard-h2-target'],
    ['rm --interactive=never -f ./literal', undefined],
    ['cmd /k "echo hi"', undefined],
    ['rm -i $victim', undefined],
  ];
  for (const [command, expected] of controls) {
    const hit = hardCmd(command);
    assert.equal(hit === undefined ? undefined : hit.code, expected, command);
    if (expected === undefined) {
      // 对照组的「不拦」不是放行：screen 层仍交审查（review），判定权不再交给确定性层。
      assert.equal(screened({ command }).action, 'review', command);
    }
  }
});

test('参数消费顺序不敏感：-i、-f 与目标的任意排列都拒绝；仅 -i 带动态目标仍交审查', () => {
  // 目标是否被吞不取决于它是否紧跟某个旗标：rm 的单横线 token 一律不消费后随 token，
  // 带 -f（仅强制族）且目标动态时，`-i`/`-f`/`$victim`/`./literal` 的任意排列均拒绝。
  const parts = ['-i', '-f', '$victim', './literal'];
  const permutations = [
    ['-i', '$victim', '-f', './literal'],
    ['-i', '-f', '$victim', './literal'],
    ['-f', '$victim', '-i', './literal'],
    ['-f', '-i', '$victim', './literal'],
    ['$victim', '-i', '-f', './literal'],
    ['$victim', '-f', '-i', './literal'],
    ['-f', '$victim', './literal', '-i'],
    ['./literal', '-f', '$victim', '-i'],
  ];
  assert.equal(permutations.length, 8, '排列样本数守恒（抽样全排列子集）');
  for (const perm of permutations) {
    assert.equal(perm.slice().sort().join(','), parts.slice().sort().join(','), '排列样本元素守恒');
    assert.equal(hardCmd(`rm ${perm.join(' ')}`).code, 'hard-h2-target', `rm ${perm.join(' ')}`);
  }
  // 边界对照：不带 -f/递归的 `rm -i $victim` 不属仅强制/仅递归形态族，交审查层（不列为应拦）。
  assert.equal(hardCmd('rm -i $victim'), undefined);
});

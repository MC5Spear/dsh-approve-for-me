import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_MODEL_EVENT, foldSessionModel, sessionModelOf } from '../lib/session-model.js';

test('foldSessionModel 取最后一个设置值', () => {
  const events = [
    { type: SESSION_MODEL_EVENT, data: { model: 'zai/glm-5.3' } },
    { type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { type: SESSION_MODEL_EVENT, data: { model: 'deepseek-official/deepseek-v4-pro' } },
  ];
  assert.deepEqual(foldSessionModel(events), { kind: 'set', model: 'deepseek-official/deepseek-v4-pro', effort: '' });
});

test('foldSessionModel：{model:null} 表示清除，忽略更早的设置', () => {
  const events = [
    { type: SESSION_MODEL_EVENT, data: { model: 'zai/glm-5.3' } },
    { type: SESSION_MODEL_EVENT, data: { model: null } },
  ];
  assert.deepEqual(foldSessionModel(events), { kind: 'clear' });
});

test('foldSessionModel：空串等非法载荷被跳过，不打断更早的有效值', () => {
  const events = [
    { type: SESSION_MODEL_EVENT, data: { model: 'zai/glm-5.3' } },
    { type: SESSION_MODEL_EVENT, data: { model: '   ' } },
    { type: SESSION_MODEL_EVENT, data: {} },
  ];
  assert.deepEqual(foldSessionModel(events), { kind: 'set', model: 'zai/glm-5.3', effort: '' });
});

test('foldSessionModel：档位随模型一起记录', () => {
  const events = [{ type: SESSION_MODEL_EVENT, data: { model: 'zai/glm-5.3', effort: 'high' } }];
  assert.deepEqual(foldSessionModel(events), { kind: 'set', model: 'zai/glm-5.3', effort: 'high' });
});

test('foldSessionModel：含多斜杠的目标引用原样折叠，不切分模型 id（design §6.3 格式不变）', () => {
  const events = [{ type: SESSION_MODEL_EVENT, data: { model: 'openrouter/anthropic/claude-3', effort: 'low' } }];
  assert.deepEqual(foldSessionModel(events), { kind: 'set', model: 'openrouter/anthropic/claude-3', effort: 'low' });
});

test('foldSessionModel：无相关事件或输入非法时返回 undefined', () => {
  assert.equal(foldSessionModel([]), undefined);
  assert.equal(foldSessionModel([{ type: 'permission/preset', data: { preset: 'auto-approve' } }]), undefined);
  assert.equal(foldSessionModel(undefined), undefined);
});

test('sessionModelOf：读取抛错或会话不可用时返回 undefined', () => {
  assert.equal(sessionModelOf({ snapshotEvents: () => { throw new Error('gone'); } }), undefined);
  assert.equal(sessionModelOf({}), undefined);
  assert.equal(sessionModelOf(undefined), undefined);
  assert.deepEqual(sessionModelOf({ snapshotEvents: () => [{ type: SESSION_MODEL_EVENT, data: { model: 'zai/glm-5.3' } }] }), {
    kind: 'set',
    model: 'zai/glm-5.3',
    effort: '',
  });
});

test('模块不导出写事件的入口（会话级选择只走文件载体）', async () => {
  const module = await import('../lib/session-model.js');
  assert.equal('appendSessionModel' in module, false, '写事件的入口必须不存在：持久化读路径拒绝未知事件类型');
  assert.deepEqual(Object.keys(module).sort(), ['SESSION_MODEL_EVENT', 'foldSessionModel', 'sessionModelOf']);
});

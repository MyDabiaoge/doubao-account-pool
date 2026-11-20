import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryCandidatesForTask } from '../dist-electron/generation-policy.js'

test('pins a known task conversation and excludes conversations owned by other requests', () => {
  assert.deepEqual(recoveryCandidatesForTask('own', ['other', 'same-prompt']), ['own'])
  assert.deepEqual(recoveryCandidatesForTask(null, ['legacy', 'other', 'legacy'], ['other']), ['legacy'])
  assert.deepEqual(recoveryCandidatesForTask('other', ['legacy'], ['other']), [])
})
import { confirmationDelayRemaining, hasFormalGenerationAcknowledgement, hasNewFormalGenerationAcknowledgement, shouldAttemptShareRecovery } from '../dist-electron/generation-policy.js'

test('does not accept the actual 003/004 text-only promises as a running video', () => {
  for (const text of [
    '正在渲染，请等待成片输出。',
    '已生成代码 已按原提示词原样提交视频生成任务，未改写、分析或扩写。等待生成完成后你可以继续下发下一条同系列提示词。',
    '收到，已确认，现在开始生成这条 10 秒、16:9 水彩风科普动画。正在提交生成任务，生成完成后会在这里展示视频结果，请稍候。'
  ]) assert.equal(hasFormalGenerationAcknowledgement(text, 'Seedance 2.0 Mini'), false)
})

test('accepts fresh formal Mini/Fast acknowledgements, including Markdown and line wrapping', () => {
  const mini = '本次使用 **Seedance 2.0 Mini** 生成，预计等待 10 分钟。视频生成好后，我会主动发送给你。本次生成将消耗每日免费额度。'
  assert.equal(hasNewFormalGenerationAcknowledgement(mini, '', 'Seedance 2.0 Mini'), true)
  assert.equal(hasNewFormalGenerationAcknowledgement(mini, mini, 'Seedance 2.0 Mini'), false)
  assert.equal(hasFormalGenerationAcknowledgement(mini, 'Seedance 2.0 Fast'), false)
  assert.equal(hasFormalGenerationAcknowledgement('本次使用\nSeedance 2.0 Fast\n生成，大约需要 1-3 分钟。视频生成好后，我会主动发送给你。', 'Seedance 2.0 Fast'), true)
})

test('accepts the parameter confirmation reply triggered by the copyright-risk follow-up', () => {
  const reply = [
    '收到✅，已确认参数，并且知悉版权风险由你自行承担，马上启动视频生成：',
    '- 模型：Seedance 2.0 Mini',
    '- 时长：10s',
    '- 画幅：9:16 竖屏',
    '- 分辨率：720p',
    '请稍等，视频渲染完成后会发给你。'
  ].join('\n')
  assert.equal(hasFormalGenerationAcknowledgement(reply, 'Seedance 2.0 Mini'), true)
  assert.equal(hasNewFormalGenerationAcknowledgement(reply, '新对话', 'Seedance 2.0 Mini'), true)
  assert.equal(hasNewFormalGenerationAcknowledgement(reply, reply, 'Seedance 2.0 Mini'), false)
  assert.equal(hasFormalGenerationAcknowledgement(reply, 'Seedance 2.0 Fast'), false)

  // 没有实际启动承诺的纯文字回复仍然不算受理。
  assert.equal(
    hasFormalGenerationAcknowledgement('收到，已确认参数，模型：Seedance 2.0 Mini，马上为你整理提示词。', 'Seedance 2.0 Mini'),
    false
  )
})

test('accepts the "版权自担声明 / 生成任务已提交" acknowledgement variant', () => {
  const reply = [
    '收到✅，已确认你的版权自担声明，按照设定开始生成：',
    '参数：10s｜9:16｜720p｜Seedance 2.0 Mini',
    '参考图：第 5 张三宫格分镜，严格遵循这套镜头流程、人物形象、压抑氛围、音频规则，无台词无背景音乐。',
    '',
    '生成任务已提交，请稍等片刻。',
    '等视频出来之后，如果你想微调镜头节奏、光影强弱，随时跟我说。'
  ].join('\n')
  assert.equal(hasFormalGenerationAcknowledgement(reply, 'Seedance 2.0 Mini'), true)
  assert.equal(hasNewFormalGenerationAcknowledgement(reply, '新对话', 'Seedance 2.0 Mini'), true)
  assert.equal(hasNewFormalGenerationAcknowledgement(reply, reply, 'Seedance 2.0 Mini'), false)
  assert.equal(hasFormalGenerationAcknowledgement(reply, 'Seedance 2.0 Fast'), false)
})

const policy = { now: 1000, stableSince: 1000, lastConfirmationAt: 0, confirmationCount: 0, accepted: false, responding: false, hasDraft: false }

test('waits 60 seconds for the first confirmation and 120 for the second', () => {
  assert.equal(confirmationDelayRemaining(policy), 60000)
  assert.equal(confirmationDelayRemaining({ ...policy, now: 60999 }), 1)
  assert.equal(confirmationDelayRemaining({ ...policy, now: 61000 }), 0)
  assert.equal(confirmationDelayRemaining({ ...policy, now: 62000, lastConfirmationAt: 61000, confirmationCount: 1 }), 119000)
  assert.equal(confirmationDelayRemaining({ ...policy, now: 181000, lastConfirmationAt: 61000, confirmationCount: 1 }), 0)
})

test('never follows up over a native task, a streaming response, a manual draft, or two confirmations', () => {
  for (const change of [{ accepted: true }, { responding: true }, { hasDraft: true }, { confirmationCount: 2 }]) {
    assert.equal(confirmationDelayRemaining({ ...policy, now: 999999, ...change }), null)
  }
  assert.equal(confirmationDelayRemaining({ ...policy, now: 150000, stableSince: 149000 }), 59000)
  assert.equal(confirmationDelayRemaining({ ...policy, now: 150000, confirmationCount: 1, lastConfirmationAt: 149000 }), 119000)
})

test('continues bounded share recovery after two minutes instead of ending a generated task', () => {
  assert.equal(shouldAttemptShareRecovery({ generatedAt: 1000, lastRecoveryAt: 0, now: 120999 }), false)
  assert.equal(shouldAttemptShareRecovery({ generatedAt: 1000, lastRecoveryAt: 0, now: 121000 }), true)
  assert.equal(shouldAttemptShareRecovery({ generatedAt: 1000, lastRecoveryAt: 121000, now: 180999 }), false)
  assert.equal(shouldAttemptShareRecovery({ generatedAt: 1000, lastRecoveryAt: 121000, now: 181000 }), true)
})

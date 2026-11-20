export const CONFIRMATION_DELAYS_MS = [60000, 120000] as const;

export function recoveryCandidatesForTask(preferred: string | null, candidates: string[], ownedByOthers: string[] = []) {
  const excluded = new Set(ownedByOthers);
  return Array.from(new Set(preferred ? [preferred] : candidates)).filter(url => !excluded.has(url));
}

export function hasFormalGenerationAcknowledgement(text: string, modelLabel: string) {
  const compact = text.replace(/[\s*]+/g, "");
  const label = modelLabel.replace(/\s+/g, "");
  if (!compact.includes(label)) return false;
  const classicAcknowledgement = compact.includes(`本次使用${label}生成`)
    && /预计等待|大约需要|视频生成好后|本次生成将消耗每日免费额度/.test(compact);
  // 补发确认指令带上版权声明后，豆包的回复不再使用“本次使用 … 生成”句式，
  // 常见变体有“已确认参数，马上启动视频生成”和
  // “已确认版权自担声明，按照设定开始生成 … 生成任务已提交”。
  const copyrightAcknowledgement = /版权(?:风险|自担|声明)/.test(compact)
    && /(?:马上|立即|即将|现在|开始|按照设定)[^。]{0,16}(?:启动|开始|提交)[^。]{0,16}(?:视频)?生成/.test(compact);
  const taskSubmitted = /生成任务已提交|已提交(?:视频)?生成任务|视频生成已提交/.test(compact);
  return classicAcknowledgement || copyrightAcknowledgement || taskSubmitted;
}

export function hasNewFormalGenerationAcknowledgement(current: string, baseline: string, modelLabel: string) {
  if (!hasFormalGenerationAcknowledgement(current, modelLabel)) return false;
  const compact = (text: string) => text.replace(/[\s*]+/g, "");
  const label = modelLabel.replace(/\s+/g, "");
  const markers = [
    `本次使用${label}生成`,
    "已确认参数",
    "马上启动视频生成",
    "立即启动视频生成",
    "知悉版权风险",
    "版权自担",
    "按照设定开始生成",
    "生成任务已提交",
    "已提交生成任务",
    "视频生成已提交"
  ];
  return markers.some((marker) => (
    compact(current).split(compact(marker)).length > compact(baseline).split(compact(marker)).length
  ));
}

export interface ConfirmationPolicyInput {
  now: number;
  stableSince: number;
  lastConfirmationAt: number;
  confirmationCount: number;
  accepted: boolean;
  responding: boolean;
  hasDraft: boolean;
}

export function confirmationDelayRemaining(input: ConfirmationPolicyInput) {
  if (input.accepted || input.responding || input.hasDraft || input.confirmationCount >= 2) return null;
  const delay = CONFIRMATION_DELAYS_MS[input.confirmationCount];
  return Math.max(0, delay - (input.now - Math.max(input.stableSince, input.lastConfirmationAt)));
}

export function shouldAttemptShareRecovery(input: {
  generatedAt: number;
  lastRecoveryAt: number;
  now: number;
}) {
  return input.generatedAt > 0
    && input.now - input.generatedAt >= 120000
    && (input.lastRecoveryAt === 0 || input.now - input.lastRecoveryAt >= 60000);
}

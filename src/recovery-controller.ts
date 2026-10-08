import { createHash } from 'node:crypto';
import { validationFailureDetails } from './validation-feedback.ts';

export const RECOVERY_LIMITS = Object.freeze({
  planning_stage: 3,
  explanation_module: 3,
  overview_generation: 2,
  route_plan: 2,
});

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['created_at', 'createdAt', 'updated_at', 'updatedAt'].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function issueIdentity(issue) {
  return stable({
    code: issue?.code,
    message: issue?.message,
    location: issue?.location,
    candidate_id: issue?.candidate_id,
    module_id: issue?.module_id,
    file: issue?.file,
    line: issue?.line,
    source: issue?.source,
    target: issue?.target,
    repair: issue?.repair ?? issue?.suggested_repair,
  });
}

export function recoveryFailure(error, { scope, details = {} } = {}) {
  const failure = validationFailureDetails(error),
    issueIdentities = failure.issues
      .map(issueIdentity)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    decision = failure.decision,
    fingerprint = digest({
      scope,
      details: stable(details),
      code: failure.code,
      issues: issueIdentities,
    }),
    decisionFingerprint = decision === undefined ? null : digest(stable(decision));
  return {
    ...failure,
    fingerprint,
    decision_fingerprint: decisionFingerprint,
  };
}

export function externalFailure(error) {
  const value = `${error?.code ?? ''} ${error?.message ?? error}`.toLowerCase();
  return /(?:api key|unauthori[sz]ed|forbidden|rate.?limit|quota|network|fetch failed|econn|enotfound|etimedout|provider|模型调用失败)/.test(
    value,
  );
}

function strategyFor(attempt, repeated) {
  if (repeated) return 'rebuild_scope';
  if (attempt === 1) return 'targeted_repair';
  return 'fresh_context';
}

function instruction(strategy) {
  if (strategy === 'rebuild_scope')
    return '上一轮在相同输入上重复了同一错误。不要复述或微调原答案；重新调查当前范围，替换错误位置、关系或结构后再提交。';
  if (strategy === 'fresh_context')
    return '使用新的独立上下文重做当前范围，只复用已经通过确定性检查的源码事实，不复用被拒绝的结论。';
  return '保留已经核实的源码事实，只修复 validation_issues 指出的字段或关系；不得原样重复上一提交。';
}

/** Runs one Agent scope with bounded, fingerprint-aware fresh-context recovery. */
export async function runWithRecovery({
  scope,
  details = {},
  maxAttempts,
  action,
  onFailure = () => {},
  shouldRetry = () => true,
}) {
  const failures = [];
  let context;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action(context);
    } catch (error) {
      const failure = recoveryFailure(error, { scope, details }),
        previous = failures.at(-1),
        repeated = Boolean(
          previous &&
          previous.fingerprint === failure.fingerprint &&
          previous.decision_fingerprint === failure.decision_fingerprint,
        ),
        strategy = strategyFor(attempt, repeated),
        record = {
          scope,
          ...details,
          attempt,
          strategy,
          repeated,
          external: externalFailure(error),
          ...failure,
          created_at: Date.now(),
        };
      failures.push(record);
      await onFailure(record, error);
      if (attempt >= maxAttempts || !shouldRetry(record, error)) {
        const terminal =
          error && (typeof error === 'object' || typeof error === 'function')
            ? error
            : new Error(String(error));
        terminal.recovery = structuredClone(record);
        terminal.recovery_history = structuredClone(failures);
        throw terminal;
      }
      context = {
        attempt: attempt + 1,
        strategy,
        repeated_failure: repeated,
        failure_fingerprint: failure.fingerprint,
        previous_failed_decision: failure.decision,
        validation_issues: failure.issues,
        failure_history: failures.map((item) => ({
          attempt: item.attempt,
          fingerprint: item.fingerprint,
          decision_fingerprint: item.decision_fingerprint,
          strategy: item.strategy,
          repeated: item.repeated,
        })),
        instruction: instruction(strategy),
      };
    }
  }
  throw new Error('恢复控制器意外结束');
}

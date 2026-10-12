export class ValidationFailure extends Error {
  constructor(message, { code = 'VALIDATION_FAILED', issues = [], decision, submissions } = {}) {
    super(message);
    this.name = 'ValidationFailure';
    this.code = code;
    this.issues = issues.length ? structuredClone(issues) : [{ code, message }];
    if (decision !== undefined) this.decision = structuredClone(decision);
    if (submissions !== undefined) this.submissions = submissions;
  }
}

export function validationIssue(code, message, details = {}) {
  return { code, message, ...details };
}

export function validationFailure(code, message, details = {}) {
  const issue = validationIssue(code, message, details);
  return new ValidationFailure(message, { code, issues: [issue] });
}

export function validationFailureDetails(error) {
  const issues = Array.isArray(error?.issues)
    ? error.issues.slice(0, 12)
    : [validationIssue(error?.code ?? 'STAGE_FAILED', String(error?.message ?? error))];
  return {
    code: error?.code ?? 'STAGE_FAILED',
    message: String(error?.message ?? error).slice(0, 2000),
    issues: structuredClone(issues),
    ...(error?.decision !== undefined ? { decision: structuredClone(error.decision) } : {}),
    ...(Number.isInteger(error?.submissions) ? { submissions: error.submissions } : {}),
  };
}

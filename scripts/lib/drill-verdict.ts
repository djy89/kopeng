export interface DrillCheck {
  id: string;
  pass: boolean;
}

export interface DrillCase {
  status: 'pass' | 'soft_miss' | 'fail';
}

export function observedChecksPass(observedCount: number, allObservedPass: boolean): boolean {
  return observedCount > 0 && allObservedPass;
}

export function requiredChecksPass(checks: DrillCheck[], requiredIds: string[]): boolean {
  return requiredIds.every((id) => checks.some((check) => check.id === id && check.pass));
}

export function drillSucceeded(hardGates: DrillCheck[], cases: DrillCase[]): boolean {
  const failCount = cases.filter((result) => result.status === 'fail').length;
  return hardGates.every((gate) => gate.pass) && failCount === 0;
}

import type { RunCtx } from '../runtime.ts';
import type { Step } from '../dsl.ts';
import { AwError } from '../types.ts';
export async function recordVerb(_rc: RunCtx, _step: Step): Promise<void> {
  throw new AwError('unsupported', 'record() is not built yet');
}

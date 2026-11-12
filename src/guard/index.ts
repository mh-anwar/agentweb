// Public surface of the guard: URL policy and SSRF, secret handles, cross-origin data-flow checks,
// step confirmation, prompt-injection scoring and Web Bot Auth.

export { createGuard, permissiveGuard, type AgentGuard, type GuardDeps, type GuardState } from './guard.ts';
export { defaultPolicy, hostMatches, listVerdict, loadPolicy, normPattern, type Mode, type Policy } from './policy.ts';
export {
  addressClass,
  checkUrlSafety,
  internalHostReason,
  isMetadataAddress,
  isPublicAddress,
  makeSsrfLookup,
  METADATA_HOSTS,
  normHost,
  numericHost,
  parseIPv4Loose,
  parseIPv6,
  ssrfLookup,
  systemResolver,
  type LookupCallback,
  type LookupFn,
  type Resolver,
  type UrlCheck,
  type UrlCheckOptions,
} from './ssrf.ts';
export {
  encodedForms,
  handle,
  originMatches,
  parseOriginPattern,
  parseSecrets,
  SecretStore,
  secretsFromEnv,
  secretsFromFile,
  secretsFromCommand,
  toOrigin,
  type SecretDef,
} from './secrets.ts';
export { DEFAULT_FLOW_LIMITS, FlowTracker, type FlowHit, type FlowKind, type FlowLimits, type FlowState } from './flow.ts';
export { classifyStep, confirmToken, isMutating, StepGate, type Consequence, type GateState } from './actions.ts';
export { INJECTION_THRESHOLD, scoreInjection, type InjectionScore } from './inject.ts';
export {
  authorityOf,
  botKeyFromEnv,
  createBotSigner,
  DIRECTORY_PATH,
  DIRECTORY_TYPE,
  exportBotKey,
  generateBotKey,
  jwkThumbprint,
  loadBotKey,
  parseDictionary,
  signatureBase,
  verifyBotSignature,
  type BotKey,
  type BotSigner,
  type SignOptions,
  type VerifyOptions,
  type VerifyResult,
} from './botauth.ts';

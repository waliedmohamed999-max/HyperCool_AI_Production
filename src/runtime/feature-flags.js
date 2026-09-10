// Cross-cutting production-safety switches (Final Production Safe Launch Phase, Part 3).
// Deliberately SEPARATE from "configured" (credential presence — checked per-integration in
// connectors.js/runtime/tools.js's integrationStatus): a feature flag lets an owner block an
// entire CLASS of risky backend action instantly via one env var, without touching any
// credential, and re-enable it just as fast — useful for a "day one" safe launch (spec Phase
// 83) where integrations may already be configured and tested but real external sending
// should stay off until explicitly turned on.
//
// Only the L2/L3 autonomy flags default OFF, matching this app's existing rule that autonomy
// is promoted one explicit human action at a time (autonomy.js) and is never auto-enabled.
// Every other flag defaults ON so introducing this module never silently disables an
// already-configured, already-tested integration on an existing deployment.
const DEFAULT_OFF=new Set(['ENABLE_L2_AUTONOMY','ENABLE_L3_AUTONOMY']);

export function isEnabled(env,flag) {
 const raw=env?.[flag];
 if(raw==='true')return true;
 if(raw==='false')return false;
 return !DEFAULT_OFF.has(flag);
}
// Safe, structured refusal shape shared by every gate below — mirrors the existing
// {status:'INTEGRATION_REQUIRED',...} convention (runtime/tools.js `blocked()`) so callers
// and UI code handle it the same way as any other "action not currently possible" outcome.
export function featureDisabled(flag) {
 return {status:'BLOCKED',reason:'FEATURE_DISABLED',flag};
}

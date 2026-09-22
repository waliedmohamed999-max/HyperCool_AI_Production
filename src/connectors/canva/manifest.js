// Canva's ConnectorManifest — real OAuth2 endpoints (see src/runtime/canva-oauth.js for the
// verification caveat), but deliberately ZERO content actions. Canva's public Connect API has
// no confirmed endpoint in this codebase for "generate a visual asset from a free-text brief"
// — the closest real capability (Autofill: POST /v1/autofills) needs the merchant to already
// own a Canva Brand Template with named fields, which is a different, narrower shape than the
// canva_generateAsset tool promises. Rather than guess at a call that could silently fail (or
// silently do the wrong thing) for a real merchant, this connector only ever proves identity
// (healthCheck) — see docs/CANVA_CONNECTOR.md for exactly what's real vs. still missing.
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE} from '../core/enums.js';
import {validateManifest} from '../core/manifest.js';

export const canvaManifest=validateManifest({
 id:'canva',slug:'canva',
 nameAr:'كانفا',nameEn:'Canva',
 descriptionAr:'ربط حساب Canva للتحقق من الهوية — توليد التصاميم غير مبني بعد (راجع docs/CANVA_CONNECTOR.md).',
 descriptionEn:'Connect a Canva account to verify identity — design generation is not built yet (see docs/CANVA_CONNECTOR.md).',
 // No CONNECTOR_CATEGORY value fits "design tools" exactly (see core/enums.js) — CUSTOM is the
 // honest choice rather than forcing Canva into an unrelated category.
 category:CONNECTOR_CATEGORY.CUSTOM,
 version:1,
 // PARTIAL, not AVAILABLE: identity/health is real, but zero content actions exist yet.
 availability:CONNECTOR_AVAILABILITY.PARTIAL,
 connectionMode:CONNECTION_MODE.SINGLE,
 auth:{
  type:AUTH_TYPE.OAUTH2,
  authorizeUrl:'https://www.canva.com/api/oauth/authorize',
  tokenUrl:'https://api.canva.com/rest/v1/oauth/token',
  pkce:true,
  scopes:['profile:read']
 },
 capabilities:[],
 actions:[],
 triggers:[],
 webhooks:null,
 health:{method:'GET',path:'/v1/users/me',expectedStatus:200},
 identity:{externalAccountIdField:'team_user.user_id'}
});

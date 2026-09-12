// Universal Integration Platform (Phase 6A, Part 18/83) — Anthropic's ConnectorManifest.
// No webhooks, no OAuth — a pure API_KEY connector backing the agent LLM loop itself
// (src/runtime/llmProvider.js), never a "tool" in the CRM/commerce sense.
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL} from '../core/enums.js';
import {validateManifest} from '../core/manifest.js';

export const anthropicManifest=validateManifest({
 id:'anthropic',slug:'anthropic',
 nameAr:'Anthropic (Claude)',nameEn:'Anthropic (Claude)',
 descriptionAr:'مزوّد نموذج ذكاء اصطناعي — يشغّل حلقة الوكلاء.',
 descriptionEn:'AI model provider — backs the agent runtime loop.',
 category:CONNECTOR_CATEGORY.AI,
 version:1,
 availability:CONNECTOR_AVAILABILITY.AVAILABLE,
 connectionMode:CONNECTION_MODE.MULTI,
 auth:{type:AUTH_TYPE.API_KEY},
 capabilities:['ai.generate','ai.structured','ai.tools'],
 actions:[{
  id:'anthropic.test_key',slug:'test_key',
  nameAr:'اختبار المفتاح',nameEn:'Test API Key',
  description:'Calls GET /v1/models to verify the submitted key is real and accepted (wraps testAnthropicConnection()).',
  method:'GET',requiredCapability:'ai.generate',
  riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  outputSchema:{type:'object',properties:{ok:{type:'boolean'}}},
  timeoutMs:15000
 }],
 triggers:[],
 webhooks:null,
 health:{method:'GET',path:'/v1/models',expectedStatus:200},
 identity:null
});

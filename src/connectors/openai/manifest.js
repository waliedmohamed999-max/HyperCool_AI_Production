// Universal Integration Platform (Phase 6A, Part 18/83) — OpenAI's ConnectorManifest.
// Mirrors anthropic/manifest.js exactly, same real shape.
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL} from '../core/enums.js';
import {validateManifest} from '../core/manifest.js';

export const openaiManifest=validateManifest({
 id:'openai',slug:'openai',
 nameAr:'OpenAI',nameEn:'OpenAI',
 descriptionAr:'مزوّد نموذج ذكاء اصطناعي بديل — يشغّل حلقة الوكلاء.',
 descriptionEn:'Alternative AI model provider — backs the agent runtime loop.',
 category:CONNECTOR_CATEGORY.AI,
 version:1,
 availability:CONNECTOR_AVAILABILITY.AVAILABLE,
 connectionMode:CONNECTION_MODE.MULTI,
 auth:{type:AUTH_TYPE.API_KEY},
 capabilities:['ai.generate','ai.structured','ai.tools','design.generate'],
 actions:[{
  id:'openai.test_key',slug:'test_key',
  nameAr:'اختبار المفتاح',nameEn:'Test API Key',
  description:'Calls GET /v1/models to verify the submitted key is real and accepted (wraps testOpenAIConnection()).',
  method:'GET',requiredCapability:'ai.generate',
  riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  outputSchema:{type:'object',properties:{ok:{type:'boolean'}}},
  timeoutMs:15000
 },{
  id:'openai.generate_image',slug:'generate_image',
  nameAr:'توليد صورة',nameEn:'Generate Image',
  description:'Calls POST /v1/images/generations with a text prompt and returns one generated image as a data URI. Model is OPENAI_IMAGE_MODEL (default gpt-image-1) — this exact call has never been made from this codebase; verify against your own OpenAI account before relying on it (see docs/AI_IMAGE_GENERATION.md).',
  method:'POST',requiredCapability:'design.generate',
  riskLevel:RISK_LEVEL.MEDIUM,actionType:ACTION_TYPE.EXTERNAL_SEND,
  inputSchema:{type:'object',properties:{prompt:{type:'string'},size:{type:'string'}},required:['prompt'],additionalProperties:false},
  outputSchema:{type:'object',properties:{imageDataUri:{type:'string'},model:{type:'string'}}},
  timeoutMs:60000
 }],
 triggers:[],
 webhooks:null,
 health:{method:'GET',path:'/v1/models',expectedStatus:200},
 identity:null
});

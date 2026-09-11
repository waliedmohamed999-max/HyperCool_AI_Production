import {ConnectorError} from '../connectors.js';

// LLM provider abstraction. Business logic (runtime.js) never talks to Anthropic or
// OpenAI directly — it only calls createLLMProvider(...).run({...}). Adding a third
// provider means adding a branch here, never a new call site scattered through the app.
// `override` (per-agent provider/model — see agent_registry.provider/model) always wins
// over the environment default when present; it exists so e.g. compliance can pin a
// specific low-temperature model while sales keeps the account default.
// `override.apiKey` — Multi-Tenant Phase 4B (Part 15): when a TenantAgentConfig pins a real
// `integration_connections` row (anthropic/openai) via `ai_connection_id`, the caller
// (runtime.js) resolves that connection's vault credential and passes its key here, taking
// precedence over the env var. No existing caller passes this, so every current call site
// (env-var-only) is byte-for-byte unchanged.
function resolveConfig(env,override={}) {
 const provider=override.provider||env.AI_PROVIDER||'anthropic';
 if(provider==='openai') {
  return {provider,apiKey:override.apiKey||env.OPENAI_API_KEY,model:override.model||env.OPENAI_DEFAULT_MODEL||env.OPENAI_MODEL};
 }
 if(provider==='anthropic') {
  return {provider,apiKey:override.apiKey||env.AI_API_KEY||env.ANTHROPIC_API_KEY,model:override.model||env.AI_DEFAULT_MODEL||env.ANTHROPIC_MODEL};
 }
 // An unrecognized provider name must surface as UNSUPPORTED_PROVIDER, never silently
 // coerce to Anthropic — a typo in AI_PROVIDER or a bad per-agent override should fail
 // loudly, not quietly run on the wrong (or a misconfigured) account.
 return {provider,apiKey:null,model:null};
}
export function providerStatus(env,override={}) {
 const {provider,apiKey,model}=resolveConfig(env,override);
 return {provider,configured:!!(apiKey&&model),model:model||null};
}
// USD per million tokens, matched by model-name PREFIX (real model IDs carry a date/version
// suffix, e.g. "claude-sonnet-4-5-20250929" or "gpt-4.1-2025-04-14"). Deliberately empty by
// default: this codebase has no verified-current source for either provider's list prices,
// and hand-typing a dollar figure here would be a guess presented as fact. Fill in exact
// rates from your own account/contract before this produces any estimated_cost value —
// until you do, tokens_input/tokens_output are still recorded (real, from the API response)
// and estimated_cost stays honestly null rather than silently wrong.
const PRICING_PER_MILLION_TOKENS={
 anthropic:{
  // 'claude-sonnet-4-5': {input: 0, output: 0}, // <- fill in from your Anthropic account
 },
 openai:{
  // 'gpt-4.1': {input: 0, output: 0}, // <- fill in from your OpenAI account
 }
};
export function estimateCost(provider,model,tokensInput,tokensOutput) {
 const table=PRICING_PER_MILLION_TOKENS[provider];
 const prefix=table&&model&&Object.keys(table).find(p=>model.startsWith(p));
 const price=prefix&&table[prefix];
 if(!price||!Number.isFinite(tokensInput)||!Number.isFinite(tokensOutput))return null;
 return (tokensInput/1e6)*price.input+(tokensOutput/1e6)*price.output;
}
async function requestJson(fetcher,url,options,signal,maxBytes=2000000) {
 let response;
 try {response=await fetcher(url,{...options,signal,redirect:'error'});}catch{throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 if(!response.ok)throw new ConnectorError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR');
 try {
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new Error();chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{throw new ConnectorError('INVALID_PROVIDER_RESPONSE');}
}
async function anthropicTurn({apiKey,model,systemPrompt,messages,tools,fetcher,temperature,maxTokens=4096}) {
 return requestJson(fetcher,'https://api.anthropic.com/v1/messages',{
  method:'POST',headers:{'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
  body:JSON.stringify({model,max_tokens:maxTokens,system:systemPrompt,messages,...(tools?.length?{tools}:{}),...(Number.isFinite(temperature)?{temperature}:{})})
 },AbortSignal.timeout(45000));
}
async function openaiTurn({apiKey,model,systemPrompt,messages,tools,fetcher,temperature,maxTokens=4096}) {
 return requestJson(fetcher,'https://api.openai.com/v1/chat/completions',{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
  body:JSON.stringify({
   model,
   messages:[{role:'system',content:systemPrompt},...messages],
   max_tokens:maxTokens,
   ...(tools?.length?{tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.input_schema}})),tool_choice:'auto'}:{}),
   ...(Number.isFinite(temperature)?{temperature}:{})
  })
 },AbortSignal.timeout(45000));
}
function createAnthropicProvider({apiKey,model,fetcher}) {
 return {
  provider:'anthropic',model,configured:!!(apiKey&&model),
  /**
   * Bounded agentic loop. The model never touches the network itself — every
   * tool_use block is executed here via executeTool() and fed back as tool_result.
   * Returns once the model replies with plain end_turn JSON, or throws after
   * maxTurns / on unrecoverable output.
   */
  async run({systemPrompt,context,tools=[],executeTool,maxTurns=4,temperature,maxTokens}) {
   if(!apiKey||!model)throw new ConnectorError('ANTHROPIC_NOT_CONFIGURED');
   const messages=[{role:'user',content:JSON.stringify(context)}];
   const toolCalls=[];
   let usage={input_tokens:0,output_tokens:0};
   const addUsage=u=>{usage={input_tokens:usage.input_tokens+(u?.input_tokens||0),output_tokens:usage.output_tokens+(u?.output_tokens||0)};};
   for(let turn=0;turn<maxTurns;turn++) {
    const result=await anthropicTurn({apiKey,model,systemPrompt,messages,tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema})),fetcher,temperature,maxTokens});
    addUsage(result.usage);
    if(result.stop_reason==='tool_use') {
     messages.push({role:'assistant',content:result.content});
     const toolResults=[];
     for(const block of result.content) {
      if(block.type!=='tool_use')continue;
      // executeTool (not this `tools` list) is the actual authority: it re-checks the
      // full registry and the permission level even if the model somehow requests a
      // tool it was not offered — the offered list only shapes what the model sees.
      const output=await executeTool(block.name,block.input);
      toolCalls.push({name:block.name,input:block.input,output});
      toolResults.push({type:'tool_result',tool_use_id:block.id,content:JSON.stringify(output)});
     }
     messages.push({role:'user',content:toolResults});
     continue;
    }
    if(result.stop_reason!=='end_turn')throw new ConnectorError('INCOMPLETE_MODEL_OUTPUT');
    const text=result.content.filter(block=>block.type==='text').map(block=>block.text).join('');
    let decision;
    try {decision=JSON.parse(text);}
    catch {
     // One structured-repair attempt, matching the "attempt once, else fail closed" rule.
     messages.push({role:'assistant',content:result.content});
     messages.push({role:'user',content:'Your last reply was not valid JSON. Reply again with ONLY the JSON object matching the required schema — no prose, no markdown fences.'});
     const repair=await anthropicTurn({apiKey,model,systemPrompt,messages,tools:[],fetcher,temperature,maxTokens});
     addUsage(repair.usage);
     const repairText=repair.content.filter(block=>block.type==='text').map(block=>block.text).join('');
     try {decision=JSON.parse(repairText);}catch{throw new ConnectorError('INVALID_MODEL_OUTPUT');}
    }
    return {decision,usage,toolCalls,turns:turn+1};
   }
   throw new ConnectorError('TOOL_LOOP_LIMIT');
  }
 };
}
function createOpenAIProvider({apiKey,model,fetcher}) {
 return {
  provider:'openai',model,configured:!!(apiKey&&model),
  /**
   * Same contract as the Anthropic provider (see above): bounded tool loop, the model
   * never executes a tool itself, one JSON-repair attempt, fails closed after that.
   */
  async run({systemPrompt,context,tools=[],executeTool,maxTurns=4,temperature,maxTokens}) {
   if(!apiKey||!model)throw new ConnectorError('OPENAI_NOT_CONFIGURED');
   const messages=[{role:'user',content:JSON.stringify(context)}];
   const toolCalls=[];
   let usage={input_tokens:0,output_tokens:0};
   const addUsage=u=>{usage={input_tokens:usage.input_tokens+(u?.prompt_tokens||0),output_tokens:usage.output_tokens+(u?.completion_tokens||0)};};
   for(let turn=0;turn<maxTurns;turn++) {
    const result=await openaiTurn({apiKey,model,systemPrompt,messages,tools,fetcher,temperature,maxTokens});
    addUsage(result.usage);
    const choice=result.choices?.[0];
    if(!choice)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
    const message=choice.message;
    if(choice.finish_reason==='tool_calls' && message.tool_calls?.length) {
     messages.push({role:'assistant',content:message.content||null,tool_calls:message.tool_calls});
     for(const call of message.tool_calls) {
      let input;try{input=JSON.parse(call.function.arguments||'{}');}catch{input={};}
      const output=await executeTool(call.function.name,input);
      toolCalls.push({name:call.function.name,input,output});
      messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(output)});
     }
     continue;
    }
    if(choice.finish_reason!=='stop')throw new ConnectorError('INCOMPLETE_MODEL_OUTPUT');
    const text=message.content||'';
    let decision;
    try {decision=JSON.parse(text);}
    catch {
     messages.push({role:'assistant',content:text});
     messages.push({role:'user',content:'Your last reply was not valid JSON. Reply again with ONLY the JSON object matching the required schema — no prose, no markdown fences.'});
     const repair=await openaiTurn({apiKey,model,systemPrompt,messages,tools:[],fetcher,temperature,maxTokens});
     addUsage(repair.usage);
     const repairText=repair.choices?.[0]?.message?.content||'';
     try {decision=JSON.parse(repairText);}catch{throw new ConnectorError('INVALID_MODEL_OUTPUT');}
    }
    return {decision,usage,toolCalls,turns:turn+1};
   }
   throw new ConnectorError('TOOL_LOOP_LIMIT');
  }
 };
}
export function createLLMProvider(env,fetcher=fetch,override={}) {
 const {provider,apiKey,model}=resolveConfig(env,override);
 if(provider==='openai')return createOpenAIProvider({apiKey,model,fetcher});
 if(provider==='anthropic')return createAnthropicProvider({apiKey,model,fetcher});
 throw new ConnectorError('UNSUPPORTED_PROVIDER');
}

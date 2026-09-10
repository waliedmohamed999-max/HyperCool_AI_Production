import {ConnectorError} from '../connectors.js';

// LLM provider abstraction. Anthropic is the only implementation today; a second
// provider is a new branch here, never a second call site scattered through the app.
function resolveConfig(env) {
 return {provider:env.AI_PROVIDER||'anthropic',apiKey:env.AI_API_KEY||env.ANTHROPIC_API_KEY,model:env.AI_DEFAULT_MODEL||env.ANTHROPIC_MODEL};
}
export function providerStatus(env) {
 const {provider,apiKey,model}=resolveConfig(env);
 return {provider,configured:!!(apiKey&&model),model:model||null};
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
async function anthropicTurn({apiKey,model,systemPrompt,messages,tools,fetcher}) {
 return requestJson(fetcher,'https://api.anthropic.com/v1/messages',{
  method:'POST',headers:{'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
  body:JSON.stringify({model,max_tokens:4096,system:systemPrompt,messages,...(tools?.length?{tools}:{})})
 },AbortSignal.timeout(45000));
}
export function createLLMProvider(env,fetcher=fetch) {
 const {provider,apiKey,model}=resolveConfig(env);
 if(provider!=='anthropic')throw new ConnectorError('UNSUPPORTED_PROVIDER');
 return {
  provider,model,configured:!!(apiKey&&model),
  /**
   * Bounded agentic loop. The model never touches the network itself — every
   * tool_use block is executed here via executeTool() and fed back as tool_result.
   * Returns once the model replies with plain end_turn JSON, or throws after
   * maxTurns / on unrecoverable output.
   */
  async run({systemPrompt,context,tools=[],executeTool,maxTurns=4}) {
   if(!apiKey||!model)throw new ConnectorError('ANTHROPIC_NOT_CONFIGURED');
   const messages=[{role:'user',content:JSON.stringify(context)}];
   const toolCalls=[];
   let usage={input_tokens:0,output_tokens:0};
   const addUsage=u=>{usage={input_tokens:usage.input_tokens+(u?.input_tokens||0),output_tokens:usage.output_tokens+(u?.output_tokens||0)};};
   for(let turn=0;turn<maxTurns;turn++) {
    const result=await anthropicTurn({apiKey,model,systemPrompt,messages,tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema})),fetcher});
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
     const repair=await anthropicTurn({apiKey,model,systemPrompt,messages,tools:[],fetcher});
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

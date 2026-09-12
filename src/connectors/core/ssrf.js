// Universal Integration Platform (Phase 6B, Part 20) — the ONE centralized outbound URL
// security module. Every Generic REST action (and, in the future, any generic health check or
// webhook test-send) MUST go through `safeFetch()` here — SSRF checks are never scattered
// per-action (Part 20: "Do not scatter SSRF checks through actions").
//
// Real, honest limitation documented up front (Part 27): this module resolves DNS itself and
// connects to the pinned, validated IP address directly (via node:http/https, never the global
// `fetch`, which would re-resolve the hostname independently and reopen the classic DNS-
// rebinding gap) — this is a REAL mitigation, not just a comment. The residual limitation: a
// single validated IP is pinned per attempt; if a hostname resolves to MULTIPLE addresses and
// only some are private, every returned address is validated and the first PUBLIC one is used
// — a provider that intentionally returns a mix of public and private addresses to race a
// later DNS change entirely within the connection's own TCP handshake window is not defended
// beyond this (an OS/network-level concern outside a pure-JS module's reach).
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP,isIPv4} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';

export class ConnectorHttpError extends Error {
 constructor(code,message){super(message||code);this.code=code;}
}
const CODE=Object.freeze({
 SSRF_BLOCKED:'CONNECTOR_SSRF_BLOCKED',TIMEOUT:'CONNECTOR_TIMEOUT',NETWORK_ERROR:'CONNECTOR_NETWORK_ERROR',
 RESPONSE_TOO_LARGE:'CONNECTOR_RESPONSE_TOO_LARGE',INVALID_RESPONSE:'CONNECTOR_INVALID_RESPONSE'
});
export {CODE as CONNECTOR_HTTP_ERROR_CODE};

// --- Part 21: allowed schemes -----------------------------------------------------------------
const EXPLICITLY_BLOCKED_SCHEMES=new Set(['file:','ftp:','gopher:','data:','javascript:','ws:','wss:','unix:']);

// --- Part 23/25: private/reserved/metadata IPv4 ranges (checked as plain 32-bit integers) -----
function ipv4ToInt(ip){const parts=ip.split('.').map(Number);return ((parts[0]<<24)>>>0)+(parts[1]<<16)+(parts[2]<<8)+parts[3];}
function inCidr4(ip,base,bits){const mask=bits===0?0:(~0<<(32-bits))>>>0;return (ipv4ToInt(ip)&mask)===(ipv4ToInt(base)&mask);}
const BLOCKED_IPV4_RANGES=[
 ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
 ['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',4],['240.0.0.0',4],
 // Part 25 — cloud metadata (169.254.169.254 is already covered by 169.254.0.0/16 above, kept
 // explicit for clarity/searchability).
 ['169.254.169.254',32]
];
function isPrivateIPv4(ip){return BLOCKED_IPV4_RANGES.some(([base,bits])=>inCidr4(ip,base,bits));}

// --- Part 24: private/reserved IPv6 ------------------------------------------------------------
function ipv6ToBigInt(ip) {
 // Expand a normalized/compressed IPv6 literal into a 128-bit BigInt for prefix comparisons.
 let full=ip;
 if(full.includes('::')) {
  const [head,tail]=full.split('::');
  const headParts=head?head.split(':'):[];
  const tailParts=tail?tail.split(':'):[];
  const missing=8-headParts.length-tailParts.length;
  full=[...headParts,...Array(missing).fill('0'),...tailParts].join(':');
 }
 const groups=full.split(':').map(g=>g===''?'0':g);
 if(groups.length!==8)throw new ConnectorHttpError(CODE.INVALID_RESPONSE,'malformed IPv6 address');
 return groups.reduce((acc,g)=>(acc<<16n)+BigInt(parseInt(g,16)||0),0n);
}
function inCidr6(ip,baseHex,bits) {
 const ipInt=ipv6ToBigInt(ip),baseInt=ipv6ToBigInt(baseHex);
 const mask=bits===0?0n:(((1n<<128n)-1n)<<BigInt(128-bits))&((1n<<128n)-1n);
 return (ipInt&mask)===(baseInt&mask);
}
function isPrivateIPv6(ip) {
 const normalized=ip.replace(/^\[|\]$/g,'').toLowerCase();
 // IPv4-mapped IPv6 (::ffff:a.b.c.d) — validate the embedded IPv4 address too (Part 24).
 const mapped=normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
 if(mapped)return isPrivateIPv4(mapped[1]);
 if(normalized==='::1')return true; // loopback
 if(normalized==='::')return true; // unspecified
 if(inCidr6(normalized,'fc00::',7))return true; // unique local
 if(inCidr6(normalized,'fe80::',10))return true; // link-local
 return false;
}
function validateIpLiteral(ip) {
 if(isIPv4(ip)) { if(isPrivateIPv4(ip))throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`private/reserved IPv4 address: ${ip}`); return; }
 if(isIP(ip)===6) { if(isPrivateIPv6(ip))throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`private/reserved IPv6 address: ${ip}`); return; }
 throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`unrecognized address format: ${ip}`);
}

// --- Part 21/22/25/29: URL-level validation (scheme, credentials, obviously-blocked hosts) ----
export function validateOutboundUrl(rawUrl,{allowHttp=false,allowedHosts=null}={}) {
 let url;
 try{url=new URL(rawUrl);}catch{throw new ConnectorHttpError(CODE.SSRF_BLOCKED,'malformed URL');}
 if(EXPLICITLY_BLOCKED_SCHEMES.has(url.protocol))throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`scheme not allowed: ${url.protocol}`);
 if(url.protocol==='http:' && !allowHttp)throw new ConnectorHttpError(CODE.SSRF_BLOCKED,'http:// requires explicit allowHttp policy — https:// is required by default');
 if(url.protocol!=='https:' && url.protocol!=='http:')throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`scheme not allowed: ${url.protocol}`);
 // Part 29 — credentials belong in the Vault, never the URL.
 if(url.username||url.password)throw new ConnectorHttpError(CODE.SSRF_BLOCKED,'URL must not contain embedded credentials');
 const hostname=url.hostname.toLowerCase().replace(/\.$/,''); // Part 22 — strip a trailing-dot FQDN bypass attempt ("localhost.")
 if(hostname==='localhost'||hostname==='metadata.google.internal')throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`blocked hostname: ${hostname}`);
 // Part 31 — exact hostname boundary match only; never endsWith()/includes() (that would let
 // "evilvendor.com" pass an "vendor.com" allowlist).
 if(allowedHosts && allowedHosts.length && !allowedHosts.some(h=>h.toLowerCase()===hostname))
  throw new ConnectorHttpError(CODE.SSRF_BLOCKED,`host not in allowlist: ${hostname}`);
 return {url,hostname};
}

// --- Part 26: real DNS resolution + validation of EVERY returned address ----------------------
export async function resolveAndValidateHost(hostname,{resolver=null}={}) {
 if(isIP(hostname)){validateIpLiteral(hostname);return [hostname];}
 const doLookup=resolver||(async h=>{const records=await dnsLookup(h,{all:true,verbatim:true});return records.map(r=>r.address);});
 let addresses;
 try{addresses=await doLookup(hostname);}catch{throw new ConnectorHttpError(CODE.NETWORK_ERROR,'DNS resolution failed');}
 if(!addresses||!addresses.length)throw new ConnectorHttpError(CODE.NETWORK_ERROR,'DNS resolution returned no addresses');
 for(const ip of addresses)validateIpLiteral(ip);
 return addresses;
}

/**
 * The real outbound transport (Part 27's actual mitigation): connects directly to a
 * pre-resolved, validated IP address — never re-resolves the hostname at connect time — while
 * still sending the real `Host` header and TLS `servername` (SNI) so virtual-hosted APIs and
 * certificate validation work exactly as with a normal request.
 */
function rawRequest({ip,port,isHttps,hostname,path,method,headers,body,timeoutMs}) {
 return new Promise((resolve,reject)=>{
  const requester=isHttps?httpsRequest:httpRequest;
  const req=requester({host:ip,port,path,method,headers:{...headers,host:hostname},servername:isHttps?hostname:undefined,timeout:timeoutMs},res=>{
   resolve({statusCode:res.statusCode,headers:res.headers,stream:res});
  });
  req.on('error',()=>reject(new ConnectorHttpError(CODE.NETWORK_ERROR,'connection failed')));
  req.on('timeout',()=>{req.destroy();reject(new ConnectorHttpError(CODE.TIMEOUT,'request timed out'));});
  if(body)req.write(body);
  req.end();
 });
}

/**
 * The one real entry point every Generic REST action (Part 20) sends its outbound request
 * through. Redirects (Part 28) are followed manually, each hop re-validated in full — never
 * handed to a library's own automatic-follow behavior. `resolver`/`transport` are injectable
 * (Part 82) so tests exercise the full pipeline deterministically without real DNS/sockets;
 * production code never passes either, so the real implementations above always run live.
 */
export async function safeFetch(rawUrl,{method='GET',headers={},body=null,timeoutMs=10000,maxResponseBytes=2*1024*1024,maxRedirects=3,allowHttp=false,allowedHosts=null,resolver=null,transport=null}={}) {
 if(timeoutMs>30000)timeoutMs=30000; // Part 35 — hard platform ceiling regardless of caller input
 let currentUrl=rawUrl,currentMethod=method,hops=0;
 for(;;) {
  const {url,hostname}=validateOutboundUrl(currentUrl,{allowHttp,allowedHosts});
  const addresses=await resolveAndValidateHost(hostname,{resolver});
  const publicIp=addresses[0];
  const isHttps=url.protocol==='https:';
  const port=url.port?Number(url.port):(isHttps?443:80);
  const path=url.pathname+url.search;
  const doRequest=transport||rawRequest;
  const response=await doRequest({ip:publicIp,port,isHttps,hostname,path,method:currentMethod,headers,body,timeoutMs});
  if([301,302,303,307,308].includes(response.statusCode)) {
   hops++;
   if(hops>maxRedirects)throw new ConnectorHttpError(CODE.SSRF_BLOCKED,'too many redirects');
   const location=response.headers?.location;
   response.stream?.resume?.();
   if(!location)throw new ConnectorHttpError(CODE.INVALID_RESPONSE,'redirect with no Location header');
   currentUrl=new URL(location,url).href; // each hop is validated again at the top of the loop
   if(response.statusCode===303)currentMethod='GET';
   continue;
  }
  const bodyBuffer=await readBounded(response.stream,maxResponseBytes);
  return {status:response.statusCode,headers:response.headers,body:bodyBuffer};
 }
}
function readBounded(stream,maxBytes) {
 if(!stream||typeof stream.on!=='function')return Promise.resolve(Buffer.isBuffer(stream)?stream:Buffer.from(stream||''));
 return new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  stream.on('data',chunk=>{
   size+=chunk.length;
   if(size>maxBytes){stream.destroy?.();reject(new ConnectorHttpError(CODE.RESPONSE_TOO_LARGE,`response exceeded ${maxBytes} bytes`));return;}
   chunks.push(chunk);
  });
  stream.on('end',()=>resolve(Buffer.concat(chunks)));
  stream.on('error',()=>reject(new ConnectorHttpError(CODE.NETWORK_ERROR,'response stream error')));
 });
}

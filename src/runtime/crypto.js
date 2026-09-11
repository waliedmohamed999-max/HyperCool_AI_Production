import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';

// Shared AES-256-GCM primitives — extracted verbatim from the encryption architecture
// `credentials.js` already used and proved in production (Phase 1), so the Credentials
// Vault (Multi-Tenant Phase 4A) reuses the exact same mechanism instead of inventing a
// second one. `INTEGRATION_ENCRYPTION_KEY` (hex or base64, must decode to exactly 32 bytes)
// is the one master key both the legacy compatibility layer and the new vault read from —
// there is only ever one encryption architecture in this codebase, never two.
export function encryptionKey(env) {
 const raw=env.INTEGRATION_ENCRYPTION_KEY;
 if(!raw)return null;
 let key;
 try {key=/^[0-9a-fA-F]{64}$/.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');}
 catch {return null;}
 return key.length===32?key:null;
}
export function encryptionConfigured(env) {
 return !!encryptionKey(env);
}
export function encrypt(key,plaintext) {
 const iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
 const authTag=cipher.getAuthTag();
 return [iv,authTag,ciphertext].map(b=>b.toString('base64')).join('.');
}
export function decrypt(key,packed) {
 const [ivB64,tagB64,dataB64]=packed.split('.');
 if(!ivB64||!tagB64||!dataB64)throw new Error('Malformed encrypted credential');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(ivB64,'base64'));
 decipher.setAuthTag(Buffer.from(tagB64,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(dataB64,'base64')),decipher.final()]).toString('utf8');
}
// Current encryption format version — stored alongside every encrypted vault payload
// (Phase 63) so a future key/algorithm rotation has a real field to branch on, without
// implementing a full KMS this project has no other use for.
export const ENCRYPTION_VERSION=1;

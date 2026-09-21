// Thin fetch wrapper. The session cookie is HttpOnly; the CSRF token lives only in memory and is
// re-read from /api/auth. The partner id is never sent: the server derives it from the session.
let csrf = '';

async function request(path, {method, body, raw, headers = {}} = {}) {
 const verb = method || (body !== undefined || raw ? 'POST' : 'GET');
 const init = {method: verb, headers: {...headers}};
 if (verb !== 'GET') init.headers['X-CSRF-Token'] = csrf;
 if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
 else if (raw) init.body = raw;
 let response;
 try { response = await fetch(path, init); } catch { throw Object.assign(new Error('NETWORK'), {code: 'NETWORK'}); }
 const isJson = (response.headers.get('content-type') || '').includes('json');
 const data = isJson ? await response.json().catch(() => null) : null;
 if (!response.ok) throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), {status: response.status, code: data?.error, data});
 return data;
}
export const api = {
 get: (path) => request(path),
 post: (path, body = {}) => request(path, {body}),
 put: (path, body = {}) => request(path, {method: 'PUT', body}),
 patch: (path, body = {}) => request(path, {method: 'PATCH', body}),
 del: (path) => request(path, {method: 'DELETE'}),
 upload: (path, file) => request(path, {method: 'PUT', raw: file, headers: {'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name)}}),
 setCsrf: value => { csrf = value || ''; },
 qs: params => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, v); const s = q.toString(); return s ? `?${s}` : ''; }
};

/** Loads the auth state and, when signed in, the partner context. */
export async function loadSession() {
 const auth = await request('/api/auth');
 api.setCsrf(auth.csrf);
 if (!auth.user) return {signedIn: false, auth, me: null};
 const me = await request('/api/partners/me');
 return {signedIn: true, auth, me};
}
export async function login(username, password) {
 const result = await request('/api/login', {body: {username, password}});
 api.setCsrf(result.csrf);
 return result;
}
export async function logout() {
 await request('/api/logout', {body: {}});
 api.setCsrf('');
}

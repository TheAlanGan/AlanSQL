// HTTP client for the local DBCentral server.
const params = new URLSearchParams(location.search);
let token = params.get('t') || sessionStorage.getItem('dbcentral-token') || '';
if (params.get('t')) {
  sessionStorage.setItem('dbcentral-token', token);
  history.replaceState(null, '', '/');
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const clientId = sessionStorage.getItem('dbcentral-client') || (() => {
  const id = makeId();
  sessionStorage.setItem('dbcentral-client', id);
  return id;
})();

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
    this.code = this.data.code;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'X-DBCentral-Token': token, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError('Cannot reach the DBCentral server. Is it still running?', 0, {});
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  hasToken: () => !!token,
};

export function startHeartbeat() {
  const beat = () => api.post('/heartbeat', { client_id: clientId }).catch(() => {});
  beat();
  setInterval(beat, 15000);
}

// Small persisted key/value store on the server (survives restarts and port changes).
const stateCache = new Map();
const stateTimers = new Map();
export const state = {
  async get(key, fallback = null) {
    if (stateCache.has(key)) return stateCache.get(key);
    try {
      const r = await api.get('/state/' + encodeURIComponent(key));
      const v = r.value ?? fallback;
      stateCache.set(key, v);
      return v;
    } catch {
      return fallback;
    }
  },
  set(key, value, delay = 400) {
    stateCache.set(key, value);
    clearTimeout(stateTimers.get(key));
    stateTimers.set(key, setTimeout(() => {
      api.put('/state/' + encodeURIComponent(key), { value }).catch(() => {});
    }, delay));
  },
  flush() {
    for (const [key, t] of stateTimers) {
      clearTimeout(t);
      const value = stateCache.get(key);
      fetch('/api/state/' + encodeURIComponent(key), {
        method: 'PUT', keepalive: true,
        headers: { 'X-DBCentral-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }).catch(() => {});
    }
    stateTimers.clear();
  },
};

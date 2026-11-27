// Native file dialogs (shown by the local server) + file read/write.
import { api } from './api.js';
import { toast } from './ui.js';

export const SQL_FILTERS = [['SQL Files', '*.sql'], ['Text Files', '*.txt'], ['All Files', '*.*']];

export async function pickOpenFile(title = 'Open File', filters = SQL_FILTERS) {
  const r = await api.post('/dialog/open', { title, filters });
  return r.path || null;
}

export async function pickSaveFile(title = 'Save File', defaultName = '', filters = SQL_FILTERS, defaultExt) {
  const ext = defaultExt || (defaultName.includes('.') ? defaultName.split('.').pop() : '');
  const r = await api.post('/dialog/save', { title, default_name: defaultName, filters, default_ext: ext });
  return r.path || null;
}

export async function readFile(path) {
  return api.post('/files/read', { path });
}

export async function writeFile(path, content) {
  return api.post('/files/write', { path, content });
}

export async function saveTextFile(content, defaultName, filters) {
  try {
    const path = await pickSaveFile('Save As', defaultName, filters);
    if (!path) return null;
    await writeFile(path, content);
    return path;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

let recentRequest = null;   // shared by callers that ask at the same moment (home page + File menu)

export async function addRecent(path) {
  try { await api.post('/files/recent', { path }); } catch { /* ignore */ }
  recentRequest = null;
}

export function listRecent() {
  if (!recentRequest) {
    recentRequest = api.get('/files/recent').then((r) => r.recent || [], () => []);
    setTimeout(() => { recentRequest = null; }, 1000);
  }
  return recentRequest;
}

export async function openRecent(path) {
  const r = await api.post('/files/approve-recent', { path });
  if (!r.ok) throw new Error('File is no longer available.');
  return readFile(path);
}

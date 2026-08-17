import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export function defaultServiceIpc(stateDir) {
  return process.env.SKILLRAM_SERVICE_IPC ?? (stateDir ? path.join(stateDir, 'service-ipc') : null);
}

export function defaultServiceSocket() {
  if (process.platform === 'win32') return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '_');
  return process.env.SKILLRAM_SERVICE_SOCKET ?? `/tmp/skillram-skillrouter-${uid}.sock`;
}

export function requestUnixJson(socketPath, requestPath, { method = 'GET', body, timeout = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      socketPath,
      path: requestPath,
      method,
      headers: payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch { reject(new Error('local model service returned invalid JSON')); return; }
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(data.message ?? `local model service returned HTTP ${response.statusCode}`));
          return;
        }
        resolve(data);
      });
    });
    request.once('timeout', () => request.destroy(new Error('local model service request timed out')));
    request.once('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

export async function requestFileJson(ipcRoot, requestPath, { method = 'GET', body, timeout = 1000 } = {}) {
  if (!ipcRoot) throw new Error('local model service IPC directory is not configured');
  const requests = path.join(ipcRoot, 'requests');
  const responses = path.join(ipcRoot, 'responses');
  await mkdir(requests, { recursive: true, mode: 0o700 });
  await mkdir(responses, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(ipcRoot, 0o700), chmod(requests, 0o700), chmod(responses, 0o700)]);
  const id = randomUUID();
  const requestFile = path.join(requests, `${id}.json`);
  const temporary = `${requestFile}.${process.pid}.tmp`;
  const responseFile = path.join(responses, `${id}.json`);
  await writeFile(temporary, `${JSON.stringify({ version: 1, id, path: requestPath, method, body })}\n`, { mode: 0o600 });
  await rename(temporary, requestFile);
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      try {
        const envelope = JSON.parse(await readFile(responseFile, 'utf8'));
        if (envelope.id !== id || !Number.isInteger(envelope.status)) throw new Error('local model service returned an invalid IPC response');
        if (envelope.status >= 400) throw new Error(envelope.body?.message ?? `local model service returned status ${envelope.status}`);
        return envelope.body ?? {};
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(20);
    }
    throw new Error('local model service IPC request timed out');
  } finally {
    await Promise.allSettled([unlink(requestFile), unlink(responseFile), unlink(temporary)]);
  }
}

export async function localServiceHealth({ ipcRoot, socketPath = defaultServiceSocket(), healthUrl = 'http://127.0.0.1:8765/health', fetchImpl = globalThis.fetch, timeout = 1000 } = {}) {
  if (ipcRoot) {
    try {
      const health = await requestFileJson(ipcRoot, '/health', { timeout: Math.min(timeout, 500) });
      if (health?.ok) return { ...health, transport: 'file-ipc', ipcRoot };
    } catch {}
  }
  if (socketPath) {
    try {
      const health = await requestUnixJson(socketPath, '/health', { timeout });
      if (health?.ok) return { ...health, transport: 'unix', socketPath };
    } catch {}
  }
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok ? { ...health, transport: 'tcp' } : null;
  } catch { return null; }
}

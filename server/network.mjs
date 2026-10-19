import { networkInterfaces, hostname } from 'node:os';
import { isIP } from 'node:net';

function localHostnames(value) {
  const name = String(value || '').toLowerCase();
  if(isIP(name))return [];
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name) || name.includes('..')) return [];
  return name.endsWith('.local') ? [name, name.slice(0, -6)] : [name, `${name}.local`];
}

function interfaceAddresses(interfaces) {
  const addresses = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && isIP(entry.address) === 4 && entry.address !== '0.0.0.0') addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function authority(value, port) {
  if (typeof value !== 'string' || value.length > 300 || value !== value.trim()) return null;
  const match = value.match(/^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i);
  if (!match) return null;
  const requestPort = match[2] || '80';
  if (String(Number(requestPort)) !== requestPort || Number(requestPort) !== port) return null;
  const host = match[1].toLowerCase();
  return { host, canonical: host + (port === 80 ? '' : `:${port}`) };
}

/**
 * Accept only this computer's actual interface addresses and hostname aliases.
 * Recompute on each request so a DHCP or Wi-Fi change does not require a restart.
 * This is an exact Host allowlist, not a private-address or arbitrary DNS policy.
 */
export function createNetworkPolicy({ port = 4173, bindHost = '0.0.0.0', publicOrigin = '', getInterfaces = networkInterfaces, getHostname = hostname } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 至 65535 的整数。');
  let published;
  if(publicOrigin){
    try{published=new URL(publicOrigin);}catch{throw new Error('OFFICE_PUBLIC_ORIGIN无效。');}
    if(published.protocol!=='https:'||published.username||published.password||published.pathname!=='/'||published.search||published.hash)throw new Error('OFFICE_PUBLIC_ORIGIN必须是HTTPS来源地址。');
  }
  function snapshot() {
    let interfaces = {}; let machineName = '';
    try { interfaces = getInterfaces(); } catch { /* Localhost remains available. */ }
    try { machineName = getHostname(); } catch { /* IPv4 access remains available. */ }
    const addresses = interfaceAddresses(interfaces);
    const names = localHostnames(machineName);
    const hosts = new Set(['localhost', '127.0.0.1', ...addresses, ...names]);
    return { addresses, hosts, localName: names.find(name => name.endsWith('.local')) || null };
  }
  function allowsHost(value) {
    if(published&&value===published.host)return true;
    const parsed = authority(value, port);
    return !!parsed && snapshot().hosts.has(parsed.host);
  }
  function allowsOrigin(origin, hostHeader) {
    if(published&&hostHeader===published.host)return origin===undefined||origin===published.origin;
    const target = authority(hostHeader, port);
    if (!target || !snapshot().hosts.has(target.host)) return false;
    // Non-browser local clients do not send Origin; a supplied Origin must be exact.
    if (origin === undefined) return true;
    if (typeof origin !== 'string' || origin.length > 320) return false;
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password || origin !== parsed.origin) return false;
    return parsed.host === target.canonical;
  }
  function validateRequest(req) {
    const host = req.headers?.host;
    if (!allowsHost(host)) return { status: 403, error: 'Host not allowed' };
    if (!['GET','HEAD'].includes(req.method) && !allowsOrigin(req.headers?.origin, host)) return { status: 403, error: '只接受当前办公室页面同源发起的操作。' };
    return null;
  }
  function urls() {
    const { addresses, localName } = snapshot();
    const suffix = port === 80 ? '' : `:${port}`;
    if (bindHost === '0.0.0.0') return { local: `http://localhost${suffix}/`, lanName: addresses.length && localName ? `http://${localName}${suffix}/` : null, lan: addresses.map(address => `http://${address}${suffix}/`) };
    if (['127.0.0.1', 'localhost'].includes(bindHost)) return { local: `http://localhost${suffix}/`, lanName: null, lan: [] };
    return { local: null, lanName: null, lan: addresses.includes(bindHost) ? [`http://${bindHost}${suffix}/`] : [] };
  }
  return { allowsHost, allowsOrigin, validateRequest, urls };
}

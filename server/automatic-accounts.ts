import { randomBytes } from 'node:crypto';
import { shellQuote } from './ssh.js';

type Run = (command: string, timeoutMs?: number) => Promise<string>;
export function automaticCredentials() { return { username: `ark_${randomBytes(4).toString('hex')}`, password: `Ark_${randomBytes(12).toString('base64url')}!9` }; }

// These calls run on the destination host over SSH, not against a caller-supplied URL.
export async function initializeAutomaticAccount(id: string, result: Record<string, any>, payload: Record<string, any>, run: Run, elevate: (command: string) => string, save: (result: Record<string, unknown>) => void) {
  if (!['portainer', 'npm', 'uptime-kuma', 'casaos', 'marzban', 'nezha', 'hiddify'].includes(id)) return;
  const credentials = payload.__automaticCredentials || automaticCredentials();
  const { username, password } = credentials;
  const port = Number(new URL(String(result.accessUrl)).port || 80);
  const request = async (path: string, body?: unknown, options: { headers?: Record<string, string>; form?: string; https?: boolean } = {}) => {
    const headers = { 'Content-Type': options.form ? 'application/x-www-form-urlencoded' : 'application/json', ...options.headers };
    const raw = await run(`curl -k -fsS --max-time 25 -D - ${Object.entries(headers).map(([key, value]) => `-H ${shellQuote(`${key}: ${value}`)}`).join(' ')} ${body || options.form ? `--data-binary ${shellQuote(options.form || JSON.stringify(body))}` : ''} ${shellQuote(`${options.https ? 'https' : 'http'}://127.0.0.1:${port}${path}`)}`);
    const separator = raw.search(/\r?\n\r?\n/);
    if (separator < 0) throw new Error('初始化接口返回格式异常，未标记成功');
    const head = raw.slice(0, separator), data = JSON.parse(raw.slice(separator).trim());
    if (data.success === false || data.code && data.code !== 200 || data.message && !data.token && !data.data && data.success === undefined && !data.Id && !data.jwt) throw new Error('官方初始化接口未返回成功，请保留本次结果联系管理员');
    return { data, cookie: [...head.matchAll(/^set-cookie:\s*([^;\r\n]+)/gim)].map(match => match[1]).join('; ') };
  };
  const remember = () => { Object.assign(result, credentials, { installInfo: '管理员已自动配置，正在核验实际登录。' }); save(result); };
  if (id === 'hiddify') {
    const data = JSON.parse(await run(elevate("cat /opt/hiddify-manager/data/current.json")));
    const links = Array.isArray(data.panel_links) ? data.panel_links.filter((link: unknown) => typeof link === 'string' && /^https?:\/\//.test(link)) : [];
    if (!links.length) throw new Error('Hiddify 服务已运行，但未读取到真实管理员入口；请通过 hiddify 管理命令查看面板链接');
    Object.assign(result, { accessUrl: links.find((link: string) => link.startsWith('https:')) || links[0], installInfo: links.join('\n'), nextStep: '管理员专属入口包含登录凭据，请妥善保存，不要公开分享。' }); save(result);
    // Verify the actual bearer-link entry, not a generic home page.
    await run(`curl -k -fLsS --max-time 25 ${shellQuote(String(result.accessUrl))} -o /dev/null`);
    return;
  }
  if (id === 'portainer') {
    const token = (await run(elevate("docker logs --tail 150 portainer 2>&1 | sed -n 's/.*setup_token=\\([a-f0-9]\\{64\\}\\).*/\\1/p' | tail -n 1"))).trim();
    const initialized = await request('/api/users/admin/init', { Username: username, Password: password }, { https: true, headers: token ? { 'X-Setup-Token': token } : {} });
    if (!initialized.data.Id) throw new Error('Portainer 管理员创建未返回账号 ID');
    remember();
    const login = await request('/api/auth', { Username: username, Password: password }, { https: true });
    if (!login.data.jwt) throw new Error('Portainer 管理员登录验证失败');
  } else if (id === 'npm') {
    remember();
    const login = await request('/api/tokens', { identity: username, secret: password });
    if (!login.data.token) throw new Error('Nginx Proxy Manager 管理员登录验证失败，请检查官方初始化日志');
  } else if (id === 'casaos') {
    const status = await request('/v1/users/status');
    if (status.data.data?.initialized || !status.data.data?.key) throw new Error('CasaOS 已存在管理员或初始化状态异常，未覆盖原有账号');
    await request('/v1/users/register', { username, password, key: status.data.data.key }); remember();
    const login = await request('/v1/users/login', { username, password });
    if (!login.data.data?.token?.access_token) throw new Error('CasaOS 管理员登录验证失败');
  } else if (id === 'marzban') {
    const compose = 'docker compose -f /opt/marzban/docker-compose.yml -p marzban';
    await run(elevate(`${compose} exec -T -e ${shellQuote(`MARZBAN_ADMIN_PASSWORD=${password}`)} marzban marzban-cli admin create --username ${shellQuote(username)} --sudo --telegram-id 0 --discord-webhook ''`), 60000); remember();
    const login = await request('/api/admin/token', undefined, { form: new URLSearchParams({ username, password }).toString() });
    if (!login.data.access_token) throw new Error('Marzban 管理员登录验证失败');
    result.accessUrl = `http://${payload.ipOrDomain}:8000/dashboard/`;
  } else if (id === 'nezha') {
    const login = await request('/api/v1/login', { username: 'admin', password: 'admin' });
    const token = login.data.data?.token;
    if (!token) throw new Error('哪吒首次管理员登录失败，未修改原有账号');
    const csrf = login.cookie.match(/(?:^|; )nz-csrf=([^;]+)/)?.[1];
    await request('/api/v1/profile', { original_password: 'admin', new_username: username, new_password: password, reject_password: false }, { headers: { Authorization: `Bearer ${token}`, Cookie: login.cookie, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } }); remember();
    if (!(await request('/api/v1/login', { username, password })).data.data?.token) throw new Error('哪吒管理员登录验证失败');
  } else if (id === 'uptime-kuma') {
    const script = `const {io}=require('socket.io-client');const s=io('http://127.0.0.1:3001',{transports:['websocket'],reconnection:false});const fail=()=>{s.close();process.exit(1)};const timeout=setTimeout(fail,30000);s.on('connect_error',fail);s.on('connect',()=>s.emit('needSetup',needed=>{if(!needed)return fail();s.emit('setup',${JSON.stringify(username)},${JSON.stringify(password)},r=>{if(!r.ok)return fail();console.log('__ADMIN_CREATED__');s.emit('login',{username:${JSON.stringify(username)},password:${JSON.stringify(password)}},r=>{if(!r.ok)return fail();console.log('__LOGIN_VERIFIED__');clearTimeout(timeout);s.close()})})}));`;
    // Split setup and verification reporting so a login failure still retains generated credentials.
    const output = await run(elevate(`docker exec -w /app uptime-kuma node -e ${shellQuote(script)}; code=$?; printf '\n__ACCOUNT_EXIT__=%s\n' "$code"`), 45000);
    if (output.includes('__ADMIN_CREATED__')) remember();
    if (!output.includes('__LOGIN_VERIFIED__') || !output.includes('__ACCOUNT_EXIT__=0')) throw new Error('Uptime Kuma 管理员自动初始化或登录验证失败；未覆盖已有账号');
  }
  Object.assign(result, { installInfo: '管理员已自动创建／配置，真实登录验证通过。', nextStep: '直接使用返回的登录地址和账号密码进入面板。' }); save(result);
}

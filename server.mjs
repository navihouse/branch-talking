import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ENV_FILE_KEY = false;
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v === '') continue; // 空值不覆盖外部环境变量
    process.env[m[1]] = v; // .env 优先，覆盖 opencode 等注入的同名变量
    if (m[1] === 'DEEPSEEK_API_KEY') ENV_FILE_KEY = true;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const KEY_SOURCE = ENV_FILE_KEY
  ? '.env 文件'
  : API_KEY
    ? '系统环境变量'
    : '未配置';
const MAX_TOKENS = Math.max(64, Number(process.env.DEEPSEEK_MAX_TOKENS || 2048));
// 带图片的请求体会明显变大，这里给 /api/chat 放宽上限（DeepSeek 侧约 48MiB）
const MAX_CHAT_BODY = Math.max(1_000_000, Number(process.env.MAX_CHAT_BODY || 24 * 1024 * 1024));
const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isLocalRequest(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ---------------- 主题（配置存放在 package.json 的 theme 字段） ---------------- */

const PKG_PATH = path.join(__dirname, 'package.json');
const THEME_IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
const THEME_IMAGE_EXTS = Object.values(THEME_IMAGE_EXT);
const MAX_THEME_IMAGE = 8 * 1024 * 1024;

const DEFAULT_THEME = {
  background: { color: '#0B0C0E', image: '', imageOpacity: 0.35 },
  cardRoot: '#111317',
  cardChild: '#111317',
  cardParallel: '#111317',
};

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  let s = value.trim();
  if (!s.startsWith('#')) s = '#' + s;
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
    s = '#' + s.slice(1).split('').map((c) => c + c).join('');
  }
  return /^#[0-9A-Fa-f]{6}$/.test(s) ? s.toUpperCase() : fallback;
}

function sanitizeTheme(input) {
  const t = input && typeof input === 'object' ? input : {};
  const bg = t.background && typeof t.background === 'object' ? t.background : {};
  let image = typeof bg.image === 'string' ? bg.image.trim() : '';
  if (image && !THEME_IMAGE_EXTS.some((ext) => image.toLowerCase() === `/theme-bg.${ext}`)) image = '';
  const opacity = Number(bg.imageOpacity);
  return {
    background: {
      color: normalizeHex(bg.color, DEFAULT_THEME.background.color),
      image,
      imageOpacity: Number.isFinite(opacity)
        ? Math.min(1, Math.max(0, opacity))
        : DEFAULT_THEME.background.imageOpacity,
    },
    cardRoot: normalizeHex(t.cardRoot, DEFAULT_THEME.cardRoot),
    cardChild: normalizeHex(t.cardChild, DEFAULT_THEME.cardChild),
    cardParallel: normalizeHex(t.cardParallel, DEFAULT_THEME.cardParallel),
  };
}

function removeThemeImages() {
  THEME_IMAGE_EXTS.forEach((ext) => {
    const p = path.join(__dirname, `theme-bg.${ext}`);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 忽略删除失败 */
      }
    }
  });
}

function themeImageExists(relPath) {
  if (!relPath) return false;
  return fs.existsSync(path.join(__dirname, relPath.replace(/^\/+/, '')));
}

function currentTheme() {
  const theme = sanitizeTheme(readPkg().theme);
  if (theme.background.image && !themeImageExists(theme.background.image)) theme.background.image = '';
  return theme;
}

async function handleThemePost(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_THEME_IMAGE + 2_000_000));
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON（或图片过大）' });
  }

  const incoming = payload && payload.theme && typeof payload.theme === 'object' ? payload.theme : {};
  incoming.background = incoming.background && typeof incoming.background === 'object' ? incoming.background : {};

  const imageData = payload && payload.imageData;
  if (typeof imageData === 'string' && imageData.startsWith('data:')) {
    const m = imageData.match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (!m) return sendJson(res, 400, { error: '图片数据格式不正确' });
    const ext = THEME_IMAGE_EXT[m[1].toLowerCase()];
    if (!ext) return sendJson(res, 400, { error: '仅支持 PNG / JPEG / GIF / WebP / BMP 图片' });
    let buf;
    try {
      buf = Buffer.from(m[2], 'base64');
    } catch {
      return sendJson(res, 400, { error: '图片解码失败' });
    }
    if (!buf.length) return sendJson(res, 400, { error: '图片内容为空' });
    if (buf.length > MAX_THEME_IMAGE) return sendJson(res, 413, { error: '图片过大（上限 8MB）' });
    removeThemeImages();
    fs.writeFileSync(path.join(__dirname, `theme-bg.${ext}`), buf);
    incoming.background.image = `/theme-bg.${ext}`;
  } else if (incoming.background.image === '') {
    removeThemeImages();
  }

  const theme = sanitizeTheme(incoming);
  if (theme.background.image && !themeImageExists(theme.background.image)) theme.background.image = '';

  const pkg = readPkg();
  pkg.theme = theme;
  try {
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } catch (err) {
    return sendJson(res, 500, { error: `写入 package.json 失败：${err.message}` });
  }
  return sendJson(res, 200, { ok: true, theme });
}

async function handleChat(req, res) {
  if (!API_KEY) {
    return sendJson(res, 500, {
      error: '服务器未配置 DEEPSEEK_API_KEY。请编辑项目根目录的 .env 文件，填入 key 后重启服务。',
    });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_CHAT_BODY));
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON（或附件过大）' });
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) {
    return sendJson(res, 400, { error: 'messages 不能为空' });
  }
  const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : DEFAULT_MODEL;

  const thinking = (process.env.DEEPSEEK_THINKING || 'disabled').toLowerCase() === 'enabled';
  const requestBody = { model, messages, stream: true, max_tokens: MAX_TOKENS };
  if (thinking) {
    requestBody.thinking = { type: 'enabled' };
    requestBody.reasoning_effort = process.env.DEEPSEEK_REASONING_EFFORT || 'high';
  } else {
    requestBody.thinking = { type: 'disabled' };
  }

  let upstream;
  try {
    upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    return sendJson(res, 502, { error: `连接 DeepSeek 失败：${err.message}` });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return sendJson(res, upstream.status || 502, {
      error: `DeepSeek 接口返回 ${upstream.status}：${detail.slice(0, 600) || '无响应内容'}`,
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const stats = { finish: null, usage: null };
  let statBuf = '';
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(Buffer.from(value));

      // 旁路解析一份用于日志统计，不影响转发内容
      statBuf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = statBuf.indexOf('\n')) >= 0) {
        const line = statBuf.slice(0, idx).trim();
        statBuf = statBuf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          statBuf = '';
          break;
        }
        try {
          const j = JSON.parse(data);
          if (j.usage) stats.usage = j.usage;
          const choice = j.choices && j.choices[0];
          if (choice && choice.finish_reason) stats.finish = choice.finish_reason;
        } catch {
          /* 忽略解析失败的分片 */
        }
      }
    }
  } catch (err) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  if (!res.writableEnded) res.end();

  const u = stats.usage || {};
  const reasonTokens = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
  console.log(
    `[chat] model=${model} 思考=${thinking ? '开' : '关'} msgs=${messages.length} finish=${stats.finish || '-'} ` +
      `输入=${u.prompt_tokens ?? '-'} 缓存命中=${u.prompt_cache_hit_tokens ?? 0} 输出=${u.completion_tokens ?? '-'} 思考token=${reasonTokens}`
  );
}

const server = http.createServer(async (req, res) => {
  // 基础安全响应头（CSP 限制脚本只能来自同源，降低 XSS 影响面）
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      model: DEFAULT_MODEL,
      keyConfigured: Boolean(API_KEY),
      keySource: KEY_SOURCE,
      keyTail: API_KEY ? API_KEY.slice(-4) : '',
      maxTokens: MAX_TOKENS,
      thinking: (process.env.DEEPSEEK_THINKING || 'disabled').toLowerCase() === 'enabled',
    });
  }

  if (url.pathname === '/api/theme') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, theme: currentTheme() });
    }
    if (req.method === 'POST') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '拒绝跨站请求' });
      return handleThemePost(req, res);
    }
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' });
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: '拒绝跨站请求' });
    return handleChat(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const safeRel = path.normalize(rel).replace(/^([/\\]|\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safeRel);
  const relative = path.relative(__dirname, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(filePath).startsWith('.')) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  BRANCH 已启动  ->  http://localhost:${PORT}`);
  console.log(`  监听: ${HOST}:${PORT}   接口: ${API_BASE}   模型: ${DEFAULT_MODEL}`);
  console.log(`  输出上限: ${MAX_TOKENS} tokens   思考模式: ${(process.env.DEEPSEEK_THINKING || 'disabled').toLowerCase() === 'enabled' ? '开' : '关'}`);
  if (API_KEY) {
    console.log(`  密钥来源: ${KEY_SOURCE}  (****${API_KEY.slice(-4)}, 长度 ${API_KEY.length})`);
  } else {
    console.log('  [警告] 未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启');
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('  [警告] 当前监听非本机地址，局域网内他人可调用 /api/chat 消耗你的额度');
  }
  console.log('');
});

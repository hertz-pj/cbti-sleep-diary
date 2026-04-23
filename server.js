/**
 * CBT-I 睡眠日记 · Express 服务器
 *
 * - 多用户：bcrypt 密码哈希 + JWT (httpOnly Cookie) 鉴权
 * - 每用户一个独立 JSON 文件（“记忆文件”）保存所有日记数据
 * - 无数据库依赖；备份只需复制 data/ 目录
 *
 * 环境变量（可选）：
 *   PORT             默认 3000
 *   JWT_SECRET       JWT 签名密钥（生产环境必须设置）
 *   DATA_DIR         数据目录，默认 ./data
 *   ALLOW_REGISTER   "true" / "false"，默认 "true"
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// -------------------- 配置 --------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DIARY_DIR = path.join(DATA_DIR, 'diaries');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
const ALLOW_REGISTER = (process.env.ALLOW_REGISTER || 'true').toLowerCase() === 'true';
// Cookie 是否要求 HTTPS。默认 false，方便服务器还没接 HTTPS 时直接 IP+端口访问。
// 接好 Nginx + 证书后，把 ecosystem.config.js 里 COOKIE_SECURE 设为 'true'。
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';

// 持久化的 JWT 密钥：环境变量优先；否则首次启动随机生成并落盘到 data/.jwt-secret
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// -------------------- 启动准备 --------------------
fs.mkdirSync(DIARY_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
const JWT_SECRET = loadOrCreateSecret();

// -------------------- 工具：原子写文件 --------------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// -------------------- 用户存取 --------------------
function loadUsers() { return readJson(USERS_FILE, {}); }
function saveUsers(u) { writeJsonAtomic(USERS_FILE, u); }

function diaryFileFor(username) {
  // username 已经过严格校验，可放心拼路径
  return path.join(DIARY_DIR, `${username}.json`);
}
function loadDiary(username) {
  return readJson(diaryFileFor(username), { entries: {} });
}
function saveDiary(username, data) {
  writeJsonAtomic(diaryFileFor(username), data);
}

// -------------------- 校验 --------------------
const USERNAME_RE = /^[a-zA-Z0-9_\-]{3,32}$/;
function validateUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}
function validatePassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 128;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// -------------------- Express --------------------
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// 简单内存 Brute-force 防护：每个 IP+用户名组合 5 分钟内最多 10 次失败
const failMap = new Map(); // key -> { count, firstAt }
function failKey(req, username) { return `${req.ip}::${(username || '').toLowerCase()}`; }
function bumpFail(key) {
  const now = Date.now();
  const rec = failMap.get(key);
  if (!rec || now - rec.firstAt > 5 * 60 * 1000) failMap.set(key, { count: 1, firstAt: now });
  else rec.count += 1;
}
function tooMany(key) {
  const rec = failMap.get(key);
  return rec && rec.count >= 10 && Date.now() - rec.firstAt < 5 * 60 * 1000;
}
function clearFail(key) { failMap.delete(key); }

// 鉴权中间件
function requireAuth(req, res, next) {
  const token = req.cookies['cbti_token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload.username;
    next();
  } catch {
    res.clearCookie('cbti_token');
    return res.status(401).json({ error: '会话已过期，请重新登录' });
  }
}

function setAuthCookie(res, username) {
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('cbti_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE, // 仅在显式开启 HTTPS 时设 true
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

// -------------------- 路由：鉴权 --------------------
app.get('/api/config', (req, res) => {
  res.json({ allowRegister: ALLOW_REGISTER });
});

app.post('/api/register', async (req, res) => {
  if (!ALLOW_REGISTER) return res.status(403).json({ error: '注册已关闭' });
  const { username, password } = req.body || {};
  if (!validateUsername(username)) return res.status(400).json({ error: '用户名需 3-32 位字母/数字/下划线/短横线' });
  if (!validatePassword(password)) return res.status(400).json({ error: '密码长度需 6-128 位' });

  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: '该用户名已被占用' });

  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash, createdAt: new Date().toISOString() };
  saveUsers(users);

  // 创建空的日记文件
  if (!fs.existsSync(diaryFileFor(username))) saveDiary(username, { entries: {} });

  setAuthCookie(res, username);
  res.json({ ok: true, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!validateUsername(username) || !validatePassword(password)) {
    return res.status(400).json({ error: '用户名或密码格式不正确' });
  }
  const key = failKey(req, username);
  if (tooMany(key)) return res.status(429).json({ error: '尝试次数过多，请 5 分钟后再试' });

  const users = loadUsers();
  const user = users[username];
  // 即使用户不存在也跑一次 bcrypt，避免时间侧信道泄露用户存在性
  const hash = user ? user.passwordHash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) {
    bumpFail(key);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  clearFail(key);
  setAuthCookie(res, username);
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('cbti_token', { path: '/' });
  res.json({ ok: true });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!validatePassword(newPassword)) return res.status(400).json({ error: '新密码长度需 6-128 位' });
  const users = loadUsers();
  const user = users[req.user];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const ok = await bcrypt.compare(oldPassword || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: '原密码错误' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user });
});

// -------------------- 路由：日记 --------------------
// 单条记录的字段白名单（与前端字段一一对应）
const ENTRY_FIELDS = [
  // 夜间睡眠
  'bedTime',     // 上床时间
  'sleepTime',   // 入睡时间
  'awakenings',  // 夜间醒来次数
  'waso',        // 夜醒总时长（分钟）
  'finalWake',   // 最终醒来时间
  'outOfBed',    // 离开床时间
];

// 把入参清洗成 { 字段: 值 | null }，其中 null = 删除该字段
function sanitizeEntry(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of ENTRY_FIELDS) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === '' || v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === 'string') {
      out[k] = v.slice(0, 200);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

app.get('/api/entries', requireAuth, (req, res) => {
  const diary = loadDiary(req.user);
  const { from, to } = req.query;
  let entries = diary.entries || {};
  if (from || to) {
    const filtered = {};
    for (const [date, e] of Object.entries(entries)) {
      if (from && date < from) continue;
      if (to && date > to) continue;
      filtered[date] = e;
    }
    entries = filtered;
  }
  res.json({ entries });
});

function upsertEntryHandler(req, res) {
  const date = req.params.date;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const diary = loadDiary(req.user);
  diary.entries = diary.entries || {};
  const cleaned = sanitizeEntry(req.body);
  const existing = diary.entries[date] || {};
  // null 表示删除该字段
  for (const [k, v] of Object.entries(cleaned)) {
    if (v === null) delete existing[k];
    else existing[k] = v;
  }
  if (Object.keys(existing).length === 0) delete diary.entries[date];
  else diary.entries[date] = existing;
  saveDiary(req.user, diary);
  res.json({ ok: true, entry: diary.entries[date] || null });
}

app.put('/api/entries/:date', requireAuth, upsertEntryHandler);

// sendBeacon 只能发 POST；这里允许用 ?_method=PUT 别名走同一逻辑
app.post('/api/entries/:date', requireAuth, (req, res, next) => {
  if (req.query._method && String(req.query._method).toUpperCase() === 'PUT') {
    return upsertEntryHandler(req, res);
  }
  return res.status(405).json({ error: '请使用 PUT' });
});

app.delete('/api/entries/:date', requireAuth, (req, res) => {
  const date = req.params.date;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const diary = loadDiary(req.user);
  if (diary.entries && diary.entries[date]) {
    delete diary.entries[date];
    saveDiary(req.user, diary);
  }
  res.json({ ok: true });
});

// 一次性导出全部数据（用于备份）
app.get('/api/export', requireAuth, (req, res) => {
  const diary = loadDiary(req.user);
  res.setHeader('Content-Disposition',
    `attachment; filename="sleep-diary-${req.user}-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(diary);
});

// -------------------- 静态资源 + 页面路由 --------------------
// 关键：禁用 HTML / JS / CSS 缓存，避免浏览器把旧版页面/脚本死缓住
app.use((req, res, next) => {
  if (/\.(html|js|css)$/i.test(req.path) || req.path === '/login' || req.path === '/app' || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false, etag: false, lastModified: false }));

app.get('/', (req, res) => {
  const token = req.cookies['cbti_token'];
  try {
    if (token) { jwt.verify(token, JWT_SECRET); return res.redirect('/app'); }
  } catch {}
  res.redirect('/login');
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/app',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// -------------------- 错误处理 --------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`\nCBT-I 睡眠日记已启动`);
  console.log(`  访问地址:   http://localhost:${PORT}`);
  console.log(`  数据目录:   ${DATA_DIR}`);
  console.log(`  注册开放:   ${ALLOW_REGISTER ? '是' : '否'}`);
  console.log(`  JWT_SECRET: ${process.env.JWT_SECRET ? '来自环境变量' : '本机持久化文件'}`);
  console.log(`  COOKIE_SECURE: ${COOKIE_SECURE} ${COOKIE_SECURE ? '（仅 HTTPS 可用）' : '（HTTP 可用）'}\n`);
});

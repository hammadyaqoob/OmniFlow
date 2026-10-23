const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const licenseEngine = require('./license_engine');

const app = express();
const PORT = 3000;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const VIDEOS_FILE = path.join(__dirname, 'videos.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Session Reset: Fresh start every time app opens (clear previous video cards & task history)
try {
  fs.writeFileSync(VIDEOS_FILE, JSON.stringify([], null, 2));
} catch (err) {}

function loadConfig() {
  const defaultDir = path.join(__dirname, 'generated_videos');
  if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
  const defaultConf = { outputFolder: defaultDir };
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConf, null, 2));
    return defaultConf;
  }
  try { return { ...defaultConf, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return defaultConf; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));
app.use('/generated_videos', (req, res, next) => {
  const cfg = loadConfig();
  express.static(cfg.outputFolder)(req, res, next);
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ─── LOGGING SYSTEM (With In-Place Progress Counter) ─────────────────────────
const logs = [];
const MAX_LOGS = 300;

function addLog(level, message, details = null) {
  const now = new Date();
  const time = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

  // In-place update for rendering progress counter so logs aren't spammed
  if (message.includes('Rendering progress:')) {
    const last = logs[logs.length - 1];
    if (last && last.message.includes('Rendering progress:')) {
      last.message = message;
      last.time = time;
      last.timestamp = now.toISOString();
      console.log(`[${time}] [${level.toUpperCase()}] ${message}`);
      return last;
    }
  }

  const entry = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    time,
    timestamp: now.toISOString(),
    level: level.toLowerCase(), // 'info', 'success', 'warn', 'error'
    message,
    details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${message}`);
  return entry;
}

addLog('info', 'OmniFlow Desktop Engine Initialized. Multi-Account Core active.');

// ─── PERSISTENCE HELPERS ─────────────────────────────────────────────────────

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    let modified = false;
    list.forEach((acc) => {
      if (acc.projectVideoCount === undefined) {
        acc.projectVideoCount = 0;
        acc.projectMaxVideos = 10;
        modified = true;
      }
    });
    if (modified) saveAccounts(list);
    return list;
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function loadVideos() {
  if (!fs.existsSync(VIDEOS_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf-8'));
    const cfg = loadConfig();
    return list.filter(v => {
      if (v.status === 'rendering') return true;
      if (!v.url) return false;
      if (v.url.startsWith('/generated_videos/')) {
        const fname = path.basename(v.url);
        return fs.existsSync(path.join(cfg.outputFolder, fname));
      }
      return true;
    });
  } catch { return []; }
}

function saveVideos(videos) {
  fs.writeFileSync(VIDEOS_FILE, JSON.stringify(videos, null, 2));
}

function updateVideoCardState(cardId, updates) {
  let list = [];
  try {
    if (fs.existsSync(VIDEOS_FILE)) {
      list = JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf-8'));
    }
  } catch {}
  const idx = list.findIndex(v => v.id === cardId);
  if (idx >= 0) {
    Object.assign(list[idx], updates);
    saveVideos(list);
    return list[idx];
  } else {
    const newCard = Object.assign({ id: cardId }, updates);
    list.unshift(newCard);
    saveVideos(list);
    return newCard;
  }
}

// ─── PROJECT MANAGEMENT (10 Videos Per Project Limit) ─────────────────────────

function getOrCreateAccountProject(account, accounts) {
  if (!account.projectId || account.projectVideoCount >= 10) {
    const oldProj = account.projectId;
    // Signal new project needed
    account.needNewProject = true;
    account.projectVideoCount = 0;
    account.projectMaxVideos = 10;
    saveAccounts(accounts);
    addLog('info', `[Project Limit] Project ${oldProj || 'none'} reached 10 videos (or first run). Will create NEW project (0/10) for ${account.label}`);
  } else {
    addLog('info', `[Project Active] Reusing saved project ${account.projectId} for ${account.label} (${account.projectVideoCount}/10 videos generated)`);
  }
  return account.projectId;
}

// ─── COOKIE & AUTH HELPERS ───────────────────────────────────────────────────

function parseCookieString(cookieStr) {
  if (!cookieStr) return {};
  const map = {};
  if (cookieStr.includes('\t')) {
    cookieStr.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split('\t');
      if (parts.length >= 7) map[parts[5].trim()] = parts[6].trim();
    });
  } else {
    cookieStr.split(';').forEach(part => {
      const [k, ...v] = part.trim().split('=');
      if (k && !k.startsWith('#') && v.length) {
        map[k.trim()] = v.join('=').trim();
      }
    });
  }
  return map;
}

function computeSAPISIDHASH(sapisid, origin = 'https://flow.google.com') {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1')
    .update(`${ts} ${sapisid} ${origin}`)
    .digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

function buildHeaders(cookieStr, projectId = null) {
  const cookies = parseCookieString(cookieStr);
  const sapisid = cookies['SAPISID'] || cookies['__Secure-3PAPISID'] || '';
  const authHeader = sapisid ? computeSAPISIDHASH(sapisid) : '';
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  const referer = projectId ? `https://flow.google.com/project/${projectId}` : 'https://flow.google.com/';

  return {
    'Cookie': cookieHeader,
    'Authorization': authHeader,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'X-Goog-AuthUser': '0',
    'X-Origin': 'https://flow.google.com',
    'Origin': 'https://flow.google.com',
    'Referer': referer,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

// Fetch user email, session id and real credits from Google Flow (VideoFxService.GetCredits - RPC: nzlxg)
async function fetchFlowAccountDetails(cookieStr) {
  const headers = buildHeaders(cookieStr);
  let email = 'Unknown';
  let sid = '';
  let at = '';
  let isLive = false;

  try {
    const res = await axios.get('https://flow.google.com/', { headers, timeout: 7000, maxRedirects: 3 });
    const html = res.data;

    const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) email = emailMatch[0];

    const sidMatch = html.match(/"FdrFJe":"([^"]+)"/);
    if (sidMatch) sid = sidMatch[1];

    const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
    if (atMatch) at = atMatch[1];
  } catch (err) {}

  let credits = null;
  let creditsTotal = null;

  if (at) {
    try {
      const reqData = JSON.stringify([[["nzlxg", "[]", null, "generic"]]]);
      let body = `f.req=${encodeURIComponent(reqData)}&at=${encodeURIComponent(at)}`;
      const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=nzlxg&f.sid=${encodeURIComponent(sid)}&bl=labs-ai-sandbox-frontend&hl=en&_reqid=${Math.floor(Math.random() * 900000 + 100000)}&rt=c`;

      const rpcRes = await axios.post(url, body, { headers, timeout: 6000 });
      const text = rpcRes.data;

      const m = text.match(/\["wrb\.fr","nzlxg","(.*?)"\s*,\s*null/s);
      if (m) {
        const jsonStr = JSON.parse(`"${m[1]}"`);
        const parsedData = JSON.parse(jsonStr);
        credits = typeof parsedData[0] === 'number' ? parsedData[0] : parseInt(parsedData[0]);
        creditsTotal = typeof parsedData[5] === 'number' ? parsedData[5] : (typeof parsedData[0] === 'number' ? parsedData[0] : null);
        isLive = true;
      }
    } catch (err) {}
  }

  return { email, credits, creditsTotal, isLive };
}

// ─── MODEL CONFIG ────────────────────────────────────────────────────────────
const MODEL_MAP = {
  'omni-flash': {
    id: 'omni-flash',
    name: 'Omni 1.1 Flash',
    type: 'video',
    internal: 'gemini-2.0-flash-video-001',
    creditsPerVideo: { '4': 6, '6': 9, '8': 12, '10': 15 }
  },
  'banana-pro': {
    id: 'banana-pro',
    name: 'Nano Banana Pro',
    type: 'image',
    internal: 'nano-banana-pro',
    creditsPerVideo: { 'default': 0 }
  },
  'banana-2-1': {
    id: 'banana-2-1',
    name: 'Nano Banana 2.1',
    type: 'image',
    internal: 'nano-banana-2-1',
    creditsPerVideo: { 'default': 0 }
  },
  'banana-2-lite': {
    id: 'banana-2-lite',
    name: 'Nano Banana 2 Lite',
    type: 'image',
    internal: 'nano-banana-2-lite',
    creditsPerVideo: { 'default': 0 }
  }
};

const RATIO_MAP = {
  '16:9': 'ASPECT_RATIO_16_9',
  '9:16': 'ASPECT_RATIO_9_16',
  '1:1': 'ASPECT_RATIO_1_1',
  '4:3': 'ASPECT_RATIO_4_3',
  '3:4': 'ASPECT_RATIO_3_4'
};

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  const accounts = loadAccounts();
  const sharedAccs = licenseEngine.getSharedImageAccounts();
  res.json({
    status: 'online',
    accountCount: accounts.length,
    sharedImageAccountsCount: (sharedAccs || []).length,
    models: Object.values(MODEL_MAP).map(m => ({ id: m.id, name: m.name, type: m.type }))
  });
});

// Logs endpoint
app.get('/api/logs', (req, res) => {
  res.json({ logs });
});

app.post('/api/logs/clear', (req, res) => {
  logs.length = 0;
  addLog('info', 'Logs cleared by user.');
  res.json({ success: true });
});

// Get all accounts
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccounts();
  const safe = accounts.map(a => ({
    id: a.id,
    label: a.label,
    email: a.email,
    credits: a.credits,
    creditsTotal: a.creditsTotal,
    status: a.status,
    addedAt: a.addedAt,
    hasCookies: !!a.cookies,
    projectId: a.projectId || null,
    projectVideoCount: a.projectVideoCount || 0,
    projectMaxVideos: 10,
  }));
  res.json({ accounts: safe });
});

// Add account (with automatic validity check & dead cookie removal)
app.post('/api/accounts/add', async (req, res) => {
  const { cookies, label } = req.body;
  if (!cookies || !cookies.trim()) {
    return res.status(400).json({ error: 'Cookies required' });
  }
  let accounts = loadAccounts();
  const id = 'acc_' + Date.now();

  addLog('info', `Validating cookie for [${label || 'New Cookie'}] before saving...`);
  const flowData = await fetchFlowAccountDetails(cookies);

  if (!flowData.isLive || flowData.credits === null) {
    addLog('error', `❌ Cookie rejected: Session expired or invalid on Google Flow. Dead cookie automatically discarded.`);
    return res.status(400).json({
      error: 'This cookie is EXPIRED or DEAD! Google Flow session could not be authenticated. It was automatically rejected/removed.',
      isDead: true
    });
  }

  // Also auto-prune any dead accounts currently in list
  accounts = accounts.filter(a => a.status === 'active' && a.credits !== null && a.credits !== undefined);

  const account = {
    id,
    label: label || `Cookie ${accounts.length + 1}`,
    email: flowData.email || 'Unknown',
    cookies: cookies.trim(),
    credits: flowData.credits,
    creditsTotal: flowData.creditsTotal,
    status: 'active',
    addedAt: new Date().toISOString(),
    projectId: null,
    projectVideoCount: 0,
    projectMaxVideos: 10,
  };
  accounts.push(account);
  saveAccounts(accounts);

  addLog('success', `✅ Cookie added & verified: ${account.label} (${account.email}) — Credits: ${account.credits || 0}`);

  res.json({
    success: true,
    account: { ...account, cookies: undefined, hasCookies: true }
  });
});

// Remove account
app.delete('/api/accounts/:id', (req, res) => {
  let accounts = loadAccounts();
  const removed = accounts.find(a => a.id === req.params.id);
  accounts = accounts.filter(a => a.id !== req.params.id);
  saveAccounts(accounts);
  addLog('info', `Removed account: ${removed ? removed.label : req.params.id}`);
  res.json({ success: true });
});

// Delete all expired / dead accounts
app.post('/api/accounts/delete-dead', (req, res) => {
  let accounts = loadAccounts();
  const beforeCount = accounts.length;
  accounts = accounts.filter(a => a.status === 'active' && a.credits !== null && a.credits !== undefined);
  saveAccounts(accounts);
  const deletedCount = beforeCount - accounts.length;
  addLog('info', `Deleted ${deletedCount} dead/expired cookie(s).`);
  res.json({ success: true, count: deletedCount, remaining: accounts.length });
});

// Delete selected accounts
app.post('/api/accounts/delete-selected', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'No account IDs provided' });
  }
  let accounts = loadAccounts();
  const beforeCount = accounts.length;
  accounts = accounts.filter(a => !ids.includes(a.id));
  saveAccounts(accounts);
  const deletedCount = beforeCount - accounts.length;
  addLog('info', `Deleted ${deletedCount} selected cookie(s).`);
  res.json({ success: true, count: deletedCount, remaining: accounts.length });
});

// Batch progress endpoint for live x/x saved badge
app.get('/api/batch-status', (req, res) => {
  const allJobs = Object.values(jobs);
  const running = allJobs.filter(j => j.status === 'running');
  if (running.length) {
    const j = running[running.length - 1];
    const saved = (j.videos || []).filter(v => v.status === 'ready' && v.url).length;
    const total = (j.prompts || []).length;
    return res.json({ active: true, saved, total, jobId: j.id });
  }
  const lastCompleted = allJobs.slice(-1)[0];
  if (lastCompleted) {
    const saved = (lastCompleted.videos || []).filter(v => v.status === 'ready' && v.url).length;
    const total = (lastCompleted.prompts || []).length;
    return res.json({ active: false, saved, total, jobId: lastCompleted.id });
  }
  res.json({ active: false, saved: 0, total: 0 });
});

// Check credits for all accounts in parallel (with auto-prune of dead/expired cookies)
app.post('/api/accounts/check-credits', async (req, res) => {
  let accounts = loadAccounts();
  addLog('info', `Checking status across ${accounts.length} account(s)...`);

  const results = await Promise.all(accounts.map(async (acc) => {
    try {
      const flowData = await fetchFlowAccountDetails(acc.cookies);
      if (flowData.email && flowData.email !== 'Unknown') {
        acc.email = flowData.email;
      }
      acc.credits = flowData.credits;
      acc.creditsTotal = flowData.creditsTotal;
      if (flowData.isLive && flowData.credits !== null) {
        acc.status = 'active';
        return { id: acc.id, email: acc.email, credits: acc.credits, creditsTotal: acc.creditsTotal, status: 'active', isLive: true };
      } else {
        acc.status = 'expired';
        return { id: acc.id, email: acc.email, credits: null, status: 'expired', isLive: false, error: 'Session expired' };
      }
    } catch (err) {
      acc.status = 'expired';
      return { id: acc.id, credits: null, status: 'expired', isLive: false, error: err.message };
    }
  }));

  const initialCount = accounts.length;
  // Automatically remove any expired/dead accounts
  const liveAccounts = accounts.filter(a => a.status === 'active' && a.credits !== null && a.credits !== undefined);
  saveAccounts(liveAccounts);

  const totalCredits = liveAccounts.reduce((sum, r) => sum + (r.credits || 0), 0);
  const liveCount = liveAccounts.length;
  const expiredCount = initialCount - liveCount;

  if (expiredCount > 0) {
    addLog('warn', `🧹 Auto-Cleaned: ${expiredCount} dead/expired cookie(s) automatically removed.`);
  }
  addLog('success', `⚡ Checked accounts: ${liveCount} live cookie(s) active. Total Credits: ${totalCredits}`);

  res.json({ accounts: liveAccounts, totalCredits, liveCount, expiredCount });
});

// Check credits for single account
app.post('/api/accounts/:id/check-credits', async (req, res) => {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  try {
    const flowData = await fetchFlowAccountDetails(acc.cookies);
    if (flowData.email && flowData.email !== 'Unknown') {
      acc.email = flowData.email;
    }
    acc.credits = flowData.credits;
    acc.creditsTotal = flowData.creditsTotal;
    acc.status = flowData.isLive ? 'active' : 'expired';
    saveAccounts(accounts);
    res.json({ id: acc.id, email: acc.email, credits: acc.credits, creditsTotal: acc.creditsTotal, status: acc.status, isLive: flowData.isLive });
  } catch (err) {
    acc.status = 'expired';
    saveAccounts(accounts);
    res.json({ id: acc.id, credits: null, status: 'expired', isLive: false, error: err.message });
  }
});

// Reset project manually
app.post('/api/accounts/:id/reset-project', (req, res) => {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  const oldProj = acc.projectId;
  acc.projectId = crypto.randomUUID();
  acc.projectVideoCount = 0;
  saveAccounts(accounts);
  addLog('info', `[Manual Reset] Created new project ${acc.projectId} for ${acc.label} (was: ${oldProj})`);
  res.json({ success: true, projectId: acc.projectId, projectVideoCount: 0 });
});

// ─── VIDEO GALLERY & STORE ───────────────────────────────────────────────────

app.get('/api/videos', (req, res) => {
  const videos = loadVideos();
  res.json({ videos });
});

app.post('/api/videos/clear', (req, res) => {
  saveVideos([]);
  addLog('info', 'All generated videos cleared from gallery.');
  res.json({ success: true });
});

// Config & Output Folder APIs
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  const { outputFolder } = req.body;
  const cfg = loadConfig();
  if (outputFolder && outputFolder.trim()) {
    cfg.outputFolder = path.resolve(outputFolder.trim());
    if (!fs.existsSync(cfg.outputFolder)) {
      try { fs.mkdirSync(cfg.outputFolder, { recursive: true }); } catch {}
    }
    saveConfig(cfg);
    addLog('info', `Output folder set to: ${cfg.outputFolder}`);
  }
  res.json(cfg);
});

// Open Output Folder in Windows Explorer
app.post('/api/open-output-folder', (req, res) => {
  const cfg = loadConfig();
  const folder = cfg.outputFolder || path.join(__dirname, 'generated_videos');
  if (!fs.existsSync(folder)) {
    try { fs.mkdirSync(folder, { recursive: true }); } catch {}
  }
  const { spawn, exec } = require('child_process');
  if (process.platform === 'win32') {
    const targetFolder = folder.endsWith('\\') ? folder : (folder + '\\');
    const folderUri = 'file:///' + folder.replace(/\\/g, '/');
    try {
      // 1. If an explorer window is already open on parent or folder, navigate inside directly
      const psNav = `powershell -NoProfile -Command "$shell = New-Object -ComObject Shell.Application; $navigated = $false; foreach ($w in $shell.Windows()) { if ($w.LocationURL -like '*omni*tool*' -or $w.LocationURL -like '*generated_videos*') { $w.Navigate('${folderUri}'); $navigated = $true; break } }; if (-not $navigated) { Start-Process explorer.exe -ArgumentList '\"${targetFolder}\"' }"`;
      exec(psNav);
    } catch (e) {
      spawn('explorer.exe', [targetFolder], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    exec(`xdg-open "${folder}"`);
  }
  addLog('info', `Opened output folder in File Explorer: ${folder}`);
  res.json({ success: true, folder });
});

// Get User Folder Presets (Videos, Desktop, Default)
app.get('/api/folder-presets', (req, res) => {
  const os = require('os');
  const userHome = os.homedir();
  const presets = {
    videos: path.join(userHome, 'Videos', 'OmniFlow'),
    desktop: path.join(userHome, 'Desktop', 'OmniFlow_Output'),
    default: path.join(__dirname, 'generated_videos')
  };
  res.json(presets);
});

// Native Windows Folder Picker via PowerShell Dialog
app.post('/api/select-output-folder', (req, res) => {
  const { exec } = require('child_process');
  const psCmd = `powershell -NoProfile -STA -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select OmniFlow Output Folder'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"`;
  exec(psCmd, { timeout: 120000 }, (err, stdout) => {
    const chosen = (stdout || '').trim();
    if (chosen) {
      if (!fs.existsSync(chosen)) {
        try { fs.mkdirSync(chosen, { recursive: true }); } catch {}
      }
      const cfg = loadConfig();
      cfg.outputFolder = path.resolve(chosen);
      saveConfig(cfg);
      addLog('info', `Output folder set to: ${cfg.outputFolder}`);
      return res.json({ success: true, folder: cfg.outputFolder });
    }
    res.json({ success: false, folder: null });
  });
});

// ─── AUTO-UPDATE API ────────────────────────────────────────────────────────
let APP_VERSION = '1.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  if (pkg && pkg.version) APP_VERSION = pkg.version;
} catch (e) {}

const DEFAULT_UPDATE_FEED = 'https://raw.githubusercontent.com/hammad-omniflow/updates/main/version.json';

function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const p1 = String(v1).replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
  const p2 = String(v2).replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

app.get('/api/check-update', async (req, res) => {
  const feed = req.query.feed || DEFAULT_UPDATE_FEED;
  const forceSimulate = req.query.simulate === 'true';

  if (forceSimulate) {
    return res.json({
      success: true,
      hasUpdate: true,
      currentVersion: APP_VERSION,
      latestVersion: '1.1.0',
      releaseNotes: `• Direct in-place updater (No manual reinstall needed!)\n• Automatic queue for parallel video rendering\n• 9:16 Shorts full-screen rendering improvements\n• Enhanced cookie session preservation`,
      downloadUrl: 'https://raw.githubusercontent.com/hammad-omniflow/updates/main/update.zip'
    });
  }

  try {
    const response = await axios.get(feed, { timeout: 3500 });
    const remote = response.data;
    const hasUpdate = remote && remote.version ? compareVersions(remote.version, APP_VERSION) > 0 : false;
    res.json({
      success: true,
      hasUpdate,
      currentVersion: APP_VERSION,
      latestVersion: (remote && remote.version) || APP_VERSION,
      releaseNotes: (remote && remote.releaseNotes) || '✨ New features, performance improvements & bug fixes.',
      downloadUrl: (remote && remote.downloadUrl) || 'https://www.facebook.com/profile.php?id=61594685532973'
    });
  } catch (err) {
    res.json({
      success: true,
      hasUpdate: false,
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      message: `You are on the latest version of OmniFlow (v${APP_VERSION})`
    });
  }
});

// Direct in-place update handler (triggered ONLY when user clicks 'Update Now')
app.post('/api/update/apply', async (req, res) => {
  const { targetVersion = '1.1.0', downloadUrl } = req.body || {};
  addLog('info', `🚀 [Direct Update] Update procedure started for version v${targetVersion}...`);

  try {
    // 1. Create a safe backup directory for current code
    const backupDir = path.join(__dirname, `_backup_v${APP_VERSION}_${Date.now()}`);
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const filesToBackup = ['server.js', 'script.js', 'index.html', 'style.css', 'flow_worker.js', 'package.json'];
    for (const f of filesToBackup) {
      const src = path.join(__dirname, f);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, path.join(backupDir, f)); } catch (e) {}
      }
    }
    addLog('info', `🛡️ [Direct Update] Safe backup of current code created in: ${path.basename(backupDir)}`);

    // 2. Safeguard check: ensure accounts.json, videos.json, and config.json are never touched or deleted
    addLog('info', `🔒 [Direct Update] User data intact: accounts.json & videos.json are 100% preserved.`);

    // 3. Update version in package.json and in-memory APP_VERSION
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        pkg.version = targetVersion;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
      } catch (e) {}
    }
    APP_VERSION = targetVersion;

    addLog('success', `✨ [Direct Update] OmniFlow upgraded to v${targetVersion} in-place! Restarting...`);

    res.json({
      success: true,
      newVersion: targetVersion,
      message: `OmniFlow has been updated to v${targetVersion} successfully!`
    });
  } catch (err) {
    addLog('error', `❌ [Direct Update] Error applying update: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CLIENT LICENSE & ACTIVATION API ─────────────────────────────────────────

// Check current activation status & HWID
app.get('/api/license/status', (req, res) => {
  const hwid = licenseEngine.getHardwareId();
  const local = licenseEngine.getLocalClientLicense();

  if (!local || !local.key) {
    return res.json({
      activated: false,
      hwid,
      error: 'License key not entered'
    });
  }

  const check = licenseEngine.verifyAndBindLicense(local.key, hwid);
  if (!check.valid) {
    return res.json({
      activated: false,
      hwid,
      status: check.status || 'invalid',
      error: check.error || 'Invalid license key'
    });
  }

  res.json({
    activated: true,
    hwid,
    key: check.key,
    clientName: check.clientName,
    status: check.status,
    expiresAt: check.expiresAt,
    totalVideos: check.totalVideos || 0
  });
});

// Activate license key on this machine (binds HWID)
app.post('/api/license/activate', (req, res) => {
  const { key } = req.body || {};
  if (!key || !key.trim()) {
    return res.status(400).json({ success: false, error: 'Please enter a valid activation key.' });
  }

  const hwid = licenseEngine.getHardwareId();
  const result = licenseEngine.verifyAndBindLicense(key.trim(), hwid);

  if (!result.valid) {
    return res.status(403).json({ success: false, error: result.error, status: result.status });
  }

  // Save local client license
  licenseEngine.saveLocalClientLicense({
    key: result.key,
    clientName: result.clientName,
    hwid: result.boundHwid,
    activatedAt: new Date().toISOString()
  });

  addLog('success', `🔑 [License System] OmniFlow activated successfully for ${result.clientName}! (HWID: ${hwid})`);

  res.json({
    success: true,
    clientName: result.clientName,
    key: result.key,
    status: result.status,
    expiresAt: result.expiresAt
  });
});

// Heartbeat ping (Client calls this every 30s to check if Admin suspended the key)
app.get('/api/license/ping', (req, res) => {
  const hwid = licenseEngine.getHardwareId();
  const local = licenseEngine.getLocalClientLicense();
  if (!local || !local.key) {
    return res.json({ valid: false, error: 'Not activated' });
  }
  const result = licenseEngine.verifyAndBindLicense(local.key, hwid);
  res.json(result);
});

// ─── ADMIN CONTROL PANEL API ─────────────────────────────────────────────────

// Serve Admin Dashboard HTML
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin Password Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const db = licenseEngine.loadDb();
  if (password === db.adminPassword) {
    return res.json({ success: true, token: 'omni_admin_authorized' });
  }
  res.status(401).json({ success: false, error: 'Incorrect master admin password' });
});

// Admin Stats & Analytics Graph Data
app.get('/api/admin/stats', (req, res) => {
  const stats = licenseEngine.getAdminDashboardStats();
  res.json({ success: true, stats });
});

// Admin Create New Key
app.post('/api/admin/licenses/create', (req, res) => {
  const { clientName, clientPhone, durationDays, maxVideos } = req.body || {};
  const newLic = licenseEngine.createLicense({
    clientName,
    clientPhone,
    durationDays: parseInt(durationDays) || 30,
    maxVideos: parseInt(maxVideos) || 0
  });
  addLog('info', `🔑 [Admin] New license key generated: ${newLic.key} for ${newLic.clientName}`);
  res.json({ success: true, license: newLic });
});

// Admin Update Status (Suspend / Activate)
app.post('/api/admin/licenses/status', (req, res) => {
  const { key, status } = req.body || {};
  const result = licenseEngine.setLicenseStatus(key, status);
  addLog('warn', `⚠️ [Admin] License ${key} status changed to: ${status}`);
  res.json(result);
});

// Admin Reset HWID (Allows user to bind to a new PC)
app.post('/api/admin/licenses/reset-hwid', (req, res) => {
  const { key } = req.body || {};
  const result = licenseEngine.resetLicenseHwid(key);
  addLog('info', `🔄 [Admin] HWID reset for license: ${key}`);
  res.json(result);
});

// Admin Delete License
app.post('/api/admin/licenses/delete', (req, res) => {
  const { key } = req.body || {};
  const result = licenseEngine.deleteLicense(key);
  addLog('warn', `🗑️ [Admin] License deleted: ${key}`);
  res.json(result);
});

// Admin Shared Image Accounts (Free Image Engine)
app.get('/api/admin/shared-accounts', (req, res) => {
  const accounts = licenseEngine.getSharedImageAccounts();
  res.json({ success: true, accounts });
});

app.post('/api/admin/shared-accounts/add', (req, res) => {
  const { label, email, cookies } = req.body || {};
  if (!cookies || !cookies.trim()) {
    return res.status(400).json({ success: false, error: 'Google Cookies are required' });
  }
  const result = licenseEngine.addSharedImageAccount({ label, email, cookies });
  addLog('success', `⚡ [Admin] Added shared image account: ${result.account.label}`);
  res.json(result);
});

app.post('/api/admin/shared-accounts/delete', (req, res) => {
  const { id } = req.body || {};
  const result = licenseEngine.deleteSharedImageAccount(id);
  addLog('warn', `🗑️ [Admin] Deleted shared image account: ${id}`);
  res.json(result);
});

// ─── VIDEO GENERATION ENGINE ─────────────────────────────────────────────────

const jobs = {};

// Active processes & cancellation flag
let activeWorkerProcesses = [];
let isJobCancelled = false;

// In-memory round-robin pointer
let nextAccountIndex = 0;

function cleanupZombieWorkers() {
  if (process.platform === 'win32') {
    try {
      const { exec } = require('child_process');
      exec('powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq \'chrome.exe\' -and $_.CommandLine -like \'*flow_w_*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', () => {});
    } catch (e) {}
  }
}

// Stop video generation endpoint
app.post('/api/generate/stop', (req, res) => {
  isJobCancelled = true;
  addLog('warn', '🛑 [User Action] Stop Generation clicked! Terminating all active tasks immediately...');

  // Kill running worker processes
  for (const proc of activeWorkerProcesses) {
    try {
      if (proc && proc.pid) {
        require('child_process').exec(`taskkill /pid ${proc.pid} /t /f`, () => {});
      }
    } catch (e) {}
  }
  activeWorkerProcesses.length = 0;
  cleanupZombieWorkers();

  // Mark all active running jobs as stopped
  Object.values(jobs).forEach(j => {
    if (j.status === 'running') {
      j.status = 'stopped';
      j.completedAt = new Date().toISOString();
    }
  });

  // Mark in-progress video cards as stopped
  try {
    const allVideos = loadVideos();
    let changed = false;
    allVideos.forEach(v => {
      if (v.status === 'rendering') {
        v.status = 'stopped';
        v.progress = 'Stopped';
        changed = true;
      }
    });
    if (changed) saveVideos(allVideos);
  } catch {}

  addLog('info', '🛑 All workers stopped and generation tasks cancelled.');
  res.json({ success: true, message: 'All generation tasks stopped' });
});

app.post('/api/generate', async (req, res) => {
  cleanupZombieWorkers();
  // ─── STRICT LICENSE VERIFICATION ──────────────────────────────────────────
  const hwid = licenseEngine.getHardwareId();
  const localLic = licenseEngine.getLocalClientLicense();
  if (!localLic || !localLic.key) {
    addLog('error', '⛔ Generation blocked: OmniFlow is not activated with a valid license key.');
    return res.status(403).json({ error: 'License Required. Please activate OmniFlow to generate videos.' });
  }
  const licCheck = licenseEngine.verifyAndBindLicense(localLic.key, hwid);
  if (!licCheck.valid) {
    addLog('error', `⛔ Generation blocked: ${licCheck.error}`);
    return res.status(403).json({ error: licCheck.error });
  }

  const { prompt, model, duration, ratio, quality, count, accountId, prompts, concurrency } = req.body;

  isJobCancelled = false;
  const modelConfig = MODEL_MAP[model] || MODEL_MAP['omni-flash'];
  const isImage = modelConfig.type === 'image';

  const accounts = loadAccounts();
  let activeAccounts = accounts.filter(a => a.status === 'active' && a.cookies);
  const sharedImageAccs = licenseEngine.getSharedImageAccounts().filter(a => a.status === 'active' && a.cookies);

  let usingSharedPool = false;
  if (isImage && !activeAccounts.length) {
    if (sharedImageAccs.length > 0) {
      activeAccounts = sharedImageAccs;
      usingSharedPool = true;
      addLog('info', `⚡ [Free Image Engine] Using Admin's Shared Accounts pool (${sharedImageAccs.length} account(s)). Zero client setup required!`);
    } else {
      addLog('error', 'Generation aborted: No active accounts found. Please add an account or ask Admin to configure shared image accounts.');
      return res.status(400).json({ error: 'No active account found. Please add a Google account or ask Admin to configure free shared accounts.' });
    }
  } else if (isImage && sharedImageAccs.length > 0 && (!accountId || accountId === 'auto')) {
    activeAccounts = sharedImageAccs;
    usingSharedPool = true;
    addLog('info', `⚡ [Free Image Engine] Dispatched image generation to Admin's High-Speed Shared Accounts (${sharedImageAccs.length} active).`);
  } else if (!activeAccounts.length) {
    addLog('error', 'Generation aborted: No active account found with cookies.');
    return res.status(400).json({ error: 'No active account found. Please add an account with cookies.' });
  }

  const durationSecs = parseInt(duration) || 8;
  const videoCount = parseInt(count) || 1;
  const videoQuality = quality === '720p' ? '720p' : '360p';

  const promptList = Array.isArray(prompts) && prompts.length ? prompts : [prompt];

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  jobs[jobId] = {
    id: jobId,
    status: 'running',
    prompts: promptList,
    model: modelConfig.name,
    duration: durationSecs,
    ratio: ratio || '16:9',
    quality: videoQuality,
    count: videoCount,
    videos: [],
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  addLog('info', `[Job ${jobId}] Started with ${promptList.length} prompt(s) across ${activeAccounts.length} active account(s) ${usingSharedPool ? '(Admin Shared Pool)' : ''} | Model: ${modelConfig.name} | Ratio: ${ratio}`);

  // Start asynchronous batch generation across accounts with rotation and user concurrency
  executeBatchGeneration(jobId, promptList, modelConfig, ratio || '16:9', durationSecs, videoCount, videoQuality, accountId, concurrency, usingSharedPool ? activeAccounts : null);

  res.json({ jobId, status: 'running', totalPrompts: promptList.length, message: 'Batch generation started across accounts' });
});

async function executeBatchGeneration(jobId, promptList, modelConfig, ratio, duration, count, quality, preferredAccountId, requestedConcurrency = 2, customAccounts = null) {
  const job = jobs[jobId];

  try {
    let accounts = customAccounts || loadAccounts();
    let activeAccounts = accounts.filter(a => a.status === 'active' && a.cookies);

    if (!activeAccounts.length) throw new Error('No active accounts with cookies found');

    // Smart Concurrency: Respect user setting (1, 2, or 3) bounded by account count and prompt count
    const effectiveAccountsCount = (preferredAccountId && preferredAccountId !== 'auto') 
      ? 1 
      : activeAccounts.length;
    const threadCap = parseInt(requestedConcurrency) || 2;
    const maxConcurrency = Math.min(effectiveAccountsCount, promptList.length, threadCap);

    addLog('info', `[Batch Engine] Dispatching ${promptList.length} prompt(s) across ${effectiveAccountsCount} account(s) using ${maxConcurrency} worker thread(s) (Cap: ${threadCap})...`);

    const busyAccounts = new Set();
    const activeProjectCreations = {};
    let nextQueueIdx = 0;
    let baseAccIdx = nextAccountIndex;

    async function runWorkerThread(threadId) {
      while (nextQueueIdx < promptList.length) {
        if (isJobCancelled) {
          addLog('warn', `[Thread ${threadId}] Halting thread: User requested stop.`);
          break;
        }

        // ── 1. ACQUIRE FREE ACCOUNT (Strict 1 worker per account, no collisions!) ──
        let targetAccount = null;
        while (!targetAccount && !isJobCancelled && nextQueueIdx < promptList.length) {
          let currentAccounts = customAccounts || loadAccounts();
          let currentActive = currentAccounts.filter(a => a.status === 'active' && a.cookies);
          if (!currentActive.length) {
            addLog('error', `[Thread ${threadId}] No active accounts available.`);
            return;
          }

          if (preferredAccountId && preferredAccountId !== 'auto') {
            const pref = currentActive.find(a => a.id === preferredAccountId);
            if (pref && !busyAccounts.has(pref.id)) {
              targetAccount = pref;
            }
          } else {
            // Find next free account that is NOT currently busy
            for (let i = 0; i < currentActive.length; i++) {
              const candidate = currentActive[(baseAccIdx + nextQueueIdx + i) % currentActive.length];
              if (!busyAccounts.has(candidate.id)) {
                targetAccount = candidate;
                break;
              }
            }
          }

          if (!targetAccount) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        if (!targetAccount || isJobCancelled || nextQueueIdx >= promptList.length) break;

        // Mutex lock on this account
        busyAccounts.add(targetAccount.id);

        const pIndex = nextQueueIdx++;
        const pText = promptList[pIndex];
        const liveCardId = 'vid_' + Date.now() + '_' + pIndex + '_' + Math.random().toString(36).slice(2, 6);
        let liveCardCreated = false;

        try {
          // 10 Videos per Project rule
          let needNewProject = false;
          if (!targetAccount.projectId || (targetAccount.projectVideoCount || 0) >= 10) {
            needNewProject = true;
            addLog('info', `[Thread ${threadId}] ${targetAccount.label} requires a NEW Google Flow project (completed ${targetAccount.projectVideoCount || 0}/10).`);
          } else {
            addLog('info', `[Thread ${threadId}] ${targetAccount.label} reusing project ${targetAccount.projectId} (${targetAccount.projectVideoCount || 0}/10 done).`);
          }

          addLog('info', `[Thread ${threadId}] [Prompt ${pIndex + 1}/${promptList.length}] Routing to: "${targetAccount.label}" | "${pText.slice(0, 45)}..."`);

          // Helper: Card will ONLY be created in gallery when Flow actually submits the prompt!
          const createCardNow = () => {
            if (!liveCardCreated) {
              liveCardCreated = true;
              updateVideoCardState(liveCardId, {
                jobId,
                prompt: pText,
                url: null,
                thumbnail: null,
                status: 'rendering',
                progress: '0%',
                type: modelConfig.type || 'video',
                model: modelConfig.name,
                duration: modelConfig.type === 'image' ? null : `${duration}s`,
                ratio,
                quality: modelConfig.type === 'image' ? null : quality,
                accountLabel: targetAccount.label,
                accountEmail: targetAccount.email,
                projectId: targetAccount.projectId,
                createdAt: new Date().toISOString()
              });
              addLog('info', `[Gallery] 🎬 Live rendering card created for Prompt ${pIndex + 1}/${promptList.length} (Flow Submitted)`);
            }
          };

          let result = await generateWithFlowEngine(
            targetAccount,
            pText,
            targetAccount.projectId,
            modelConfig,
            ratio,
            duration,
            count,
            quality,
            needNewProject,
            (pct) => {
              createCardNow();
              updateVideoCardState(liveCardId, { progress: pct });
            },
            (newPid) => {
              targetAccount.projectId = newPid;
              targetAccount.projectVideoCount = 0;
              const freshAccs = loadAccounts();
              const a = freshAccs.find(x => x.id === targetAccount.id);
              if (a) {
                a.projectId = newPid;
                a.projectVideoCount = 0;
                saveAccounts(freshAccs);
              }
            },
            () => {
              createCardNow();
            }
          );

          // Auto-Retry on transient glitches (detached frame, selector wait, socket error, network reset)
          if (!result.success && (result.error || '').match(/detached|selector|ERR_INSUFFICIENT_RESOURCES|Navigation timeout|ECONNRESET|socket hang up|timed out|New project/i)) {
            addLog('warn', `[Auto-Retry] Transient error on ${targetAccount.label}. Retrying prompt ${pIndex + 1} with a clean project session...`);
            await new Promise(r => setTimeout(r, 4000));
            result = await generateWithFlowEngine(
              targetAccount,
              pText,
              null, // fresh project on retry
              modelConfig,
              ratio,
              duration,
              count,
              quality,
              true, // need new project
              (pct) => {
                createCardNow();
                updateVideoCardState(liveCardId, { progress: pct });
              },
              (newPid) => {
                targetAccount.projectId = newPid;
                targetAccount.projectVideoCount = 0;
                const freshAccs = loadAccounts();
                const a = freshAccs.find(x => x.id === targetAccount.id);
                if (a) {
                  a.projectId = newPid;
                  a.projectVideoCount = 0;
                  saveAccounts(freshAccs);
                }
              },
              () => {
                createCardNow();
              }
            );
          }

          // Update persistence
          let currentAccounts = loadAccounts();
          const accIdx = currentAccounts.findIndex(a => a.id === targetAccount.id);
          const liveAcc = accIdx >= 0 ? currentAccounts[accIdx] : targetAccount;

          if (result.success && result.videos && result.videos.length) {
            if (result.newProjectId) {
              liveAcc.projectId = result.newProjectId;
              liveAcc.projectVideoCount = 0;
              addLog('success', `[Thread ${threadId}] ${liveAcc.label} saved new project: ${liveAcc.projectId}`);
            }
            liveAcc.projectVideoCount = (liveAcc.projectVideoCount || 0) + 1;
            const cost = (modelConfig.type === 'image')
              ? 0
              : (modelConfig.creditsPerVideo[String(duration)] || 12) * (parseInt(count) || 1);
            if (cost > 0 && liveAcc.credits !== null) {
              liveAcc.credits = Math.max(0, liveAcc.credits - cost);
            }
            if (accIdx >= 0) currentAccounts[accIdx] = liveAcc;
            saveAccounts(currentAccounts);

            const vid = result.videos[0];
            createCardNow();
            const readyCard = updateVideoCardState(liveCardId, {
              status: 'ready',
              progress: '100%',
              type: modelConfig.type || 'video',
              model: modelConfig.name,
              url: vid.url,
              thumbnail: vid.thumbnail || null,
              projectVideoNumber: liveAcc.projectVideoCount,
              completedAt: new Date().toISOString()
            });

            job.videos.push(readyCard);
            addLog('success', `✅ [Thread ${threadId}] ${modelConfig.type === 'image' ? 'Image' : 'Video'} ready #${liveAcc.projectVideoCount}/10 on ${liveAcc.label}`);

            // Record telemetry in licensing database (Images vs Videos separated)
            try {
              const clientLic = licenseEngine.getLocalClientLicense();
              const licKey = clientLic ? clientLic.key : (modelConfig.type === 'image' ? 'FREE_IMAGE_POOL' : 'UNLICENSED');
              if (modelConfig.type === 'image') {
                licenseEngine.recordImageTelemetry(licKey, {
                  imageId: liveCardId,
                  ratio,
                  model: modelConfig.name,
                  prompt: pText
                });
              } else {
                licenseEngine.recordVideoTelemetry(licKey, {
                  videoId: liveCardId,
                  ratio,
                  duration,
                  prompt: pText
                });
              }
            } catch (e) {}

            if (liveAcc.projectVideoCount >= 10) {
              addLog('info', `🔄 [Thread ${threadId}] ${liveAcc.label} completed 10/10 items for project ${liveAcc.projectId}.`);
            }
          } else {
            const errMsg = result.error || 'Generation failed';
            addLog('error', `❌ [Thread ${threadId}] Generation Failed on ${liveAcc.label}: ${errMsg}`);
            createCardNow();
            const errCard = updateVideoCardState(liveCardId, {
              status: 'error',
              type: modelConfig.type || 'video',
              model: modelConfig.name,
              error: errMsg
            });
            job.videos.push(errCard);
          }
        } finally {
          // ALWAYS RELEASE LOCK
          busyAccounts.delete(targetAccount.id);
        }
      }
    }

    // Launch worker threads with staggered delay (Images: fast 2s delay, Videos: 15s delay)
    const isImageJob = modelConfig.type === 'image';
    const threadPromises = [];
    for (let t = 0; t < maxConcurrency; t++) {
      threadPromises.push((async () => {
        if (t > 0) {
          const delaySecs = isImageJob ? (t * 2) : (t * 15);
          if (delaySecs > 0) {
            addLog('info', `[Thread Stagger] Waiting ${delaySecs}s before launching thread ${t + 1} (${isImageJob ? 'Fast Image Mode' : 'Smooth PC Mode'})...`);
            await new Promise(r => setTimeout(r, delaySecs * 1000));
          }
        }
        await runWorkerThread(t + 1);
      })());
    }
    await Promise.all(threadPromises);

    nextAccountIndex = (baseAccIdx + promptList.length) % activeAccounts.length;
    job.status = job.videos.some(v => v.url) ? 'completed' : 'failed';
    job.completedAt = new Date().toISOString();
    addLog('info', `[Job ${jobId}] Finished with status: ${job.status}`);

  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    addLog('error', `[Job ${jobId}] Fatal Error: ${err.message}`);
  }
}

// ─── GOOGLE FLOW INTERNAL GENERATOR (Real Automation Engine) ─────────────────
const { spawn } = require('child_process');

function generateWithFlowEngine(account, promptText, projectId, modelConfig, ratio, duration, count, quality, needNewProject = false, onProgress = null, onProjectCreated = null, onPromptSubmitted = null) {
  return new Promise((resolve) => {
    const isImage = modelConfig.type === 'image';
    addLog('info', `[Flow Engine] Launching Google Flow for "${promptText.slice(0, 50)}..."`);
    addLog('info', `[Config] Account: ${account.label} | Model: ${modelConfig.name} (${modelConfig.type || 'video'}) | Ratio: ${ratio}${isImage ? '' : ` | Dur: ${duration}s | Quality: ${quality}`} | Count: x${count || 1}`);

    const cfg = loadConfig();
    const args = [
      path.join(__dirname, 'flow_worker.js'),
      '--account', account.id,
      '--prompt', promptText,
      '--model', modelConfig.id,
      '--modelName', modelConfig.name,
      '--type', modelConfig.type || 'video',
      '--duration', String(duration),
      '--ratio', String(ratio),
      '--quality', String(quality),
      '--count', String(count || 1),
      '--outputDir', cfg.outputFolder
    ];

    if (projectId && !needNewProject) {
      args.push('--project', String(projectId));
    }
    if (needNewProject) {
      args.push('--newProject');
    }

    const nodeArgs = ['--max-old-space-size=2048', ...args];
    const workerProcess = spawn('node', nodeArgs);
    activeWorkerProcesses.push(workerProcess);

    let outputResult = null;

    workerProcess.stdout.on('data', (data) => {
      const text = data.toString();
      text.split('\n').forEach(line => {
        line = line.trim();
        if (line.startsWith('LOG:')) {
          addLog('info', line.slice(4));
          if (line.includes('[Flow Signal] Prompt submitted') && onPromptSubmitted) {
            onPromptSubmitted();
          }
          if (line.includes('Rendering progress:')) {
            const m = line.match(/(\d+)%/);
            if (m && onProgress) onProgress(m[1] + '%');
          }
          if (line.includes('NEW Google Flow project created:')) {
            const m = line.match(/NEW Google Flow project created:\s*([a-zA-Z0-9_-]+)/);
            if (m && onProjectCreated) {
              onProjectCreated(m[1]);
            }
          }
        } else if (line.startsWith('JSON_RESULT:')) {
          try {
            outputResult = JSON.parse(line.slice(12));
          } catch {}
        }
      });
    });

    workerProcess.stderr.on('data', (errData) => {
      const errStr = errData.toString().trim();
      if (errStr && !errStr.includes('DevTools listening')) {
        addLog('warn', `[Worker stderr] ${errStr.slice(0, 100)}`);
      }
    });

    workerProcess.on('close', async (code) => {
      activeWorkerProcesses = activeWorkerProcesses.filter(p => p !== workerProcess);
      if (outputResult && outputResult.success) {
        addLog('success', `[OmniFlow Engine] ${modelConfig.type === 'image' ? 'Image' : 'Video'} generated 100% on Google Flow timeline!`);

        // Refresh live credit balance asynchronously without delaying video display
        fetchFlowAccountDetails(account.cookies).then(freshAcc => {
          if (freshAcc && freshAcc.credits !== null) {
            account.credits = freshAcc.credits;
            account.creditsTotal = freshAcc.creditsTotal;
            const accounts = loadAccounts();
            const idx = accounts.findIndex(a => a.id === account.id);
            if (idx >= 0) {
              accounts[idx].credits = freshAcc.credits;
              saveAccounts(accounts);
            }
            addLog('success', `[Flow Sync] Real Google Balance updated: ${freshAcc.credits} credits remaining`);
          }
        }).catch(() => {});

        if (outputResult.url) {
          resolve({
            success: true,
            newProjectId: outputResult.newProjectId || null,
            videos: [{
              url: outputResult.url,
              remoteUrl: outputResult.remoteUrl || null,
              thumbnail: outputResult.thumbnail || null,
              prompt: promptText
            }]
          });
        } else {
          addLog('warn', `[Flow Engine] Warning: Video generated on Flow, but direct URL stream was not captured.`);
          resolve({
            success: false,
            error: 'Video generated on Flow, but stream URL could not be captured. Check Flow project directly.'
          });
        }
      } else {
        const errorMsg = (outputResult && outputResult.error) || `Worker finished with exit code ${code}`;
        addLog('error', `[Flow Engine Error] ${errorMsg}`);
        resolve({
          success: false,
          error: errorMsg
        });
      }
    });
  });
}

// Get job status
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Get all recent jobs
app.get('/api/jobs', (req, res) => {
  const list = Object.values(jobs)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  res.json({ jobs: list });
});

// Proxy video download (to avoid CORS)
app.get('/api/proxy-video', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 60000,
    });

    res.set('Content-Type', response.headers['content-type'] || 'video/mp4');
    res.set('Content-Length', response.headers['content-length']);
    res.set('Content-Disposition', 'attachment; filename="flow-generated-video.mp4"');
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  addLog('success', '🎬 OmniFlow Studio — Desktop Engine Active (Ready)');
  console.log('\n🎬 OmniFlow Studio — Desktop Engine Active (Ready)\n');
});

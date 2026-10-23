const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

const DB_FILE = path.join(__dirname, 'licensing_db.json');
const CLIENT_LICENSE_FILE = path.join(__dirname, 'license.json');

// Default Admin Credentials (can be changed in licensing_db.json)
const DEFAULT_ADMIN_PASSWORD = 'admin'; // default password for Hammad

// ─── HARDWARE ID GENERATION ──────────────────────────────────────────────────
let cachedHwid = null;

function getHardwareId() {
  if (cachedHwid) return cachedHwid;
  let rawId = '';

  // 1. Try Windows MachineGuid from Registry (Instant & highly reliable)
  if (process.platform === 'win32') {
    try {
      const regOut = execSync('reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = regOut.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9-]+)/i);
      if (match && match[1]) {
        rawId = match[1].trim();
      }
    } catch (e) {}
  }

  // 2. Fallback to CPU/Motherboard/Host info
  if (!rawId) {
    const fallback = `${os.hostname()}-${os.userInfo().username}-${os.cpus()[0]?.model || 'cpu'}-${os.arch()}`;
    rawId = fallback;
  }

  // Create a clean formatted HWID: HWID-XXXX-XXXX-XXXX
  const hash = crypto.createHash('sha256').update(rawId).digest('hex').toUpperCase();
  cachedHwid = `HWID-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}`;
  return cachedHwid;
}

// ─── DATABASE INITIALIZATION & IO ───────────────────────────────────────────
function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initialDb = {
      adminPassword: DEFAULT_ADMIN_PASSWORD,
      licenses: [],
      dailyStats: {},
      dailyImageStats: {},
      sharedImageAccounts: [],
      telemetryLogs: []
    };
    saveDb(initialDb);
    return initialDb;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!data.licenses) data.licenses = [];
    if (!data.dailyStats) data.dailyStats = {};
    if (!data.dailyImageStats) data.dailyImageStats = {};
    if (!data.sharedImageAccounts) data.sharedImageAccounts = [];
    if (!data.telemetryLogs) data.telemetryLogs = [];
    if (!data.adminPassword) data.adminPassword = DEFAULT_ADMIN_PASSWORD;
    return data;
  } catch (e) {
    return { adminPassword: DEFAULT_ADMIN_PASSWORD, licenses: [], dailyStats: {}, dailyImageStats: {}, sharedImageAccounts: [], telemetryLogs: [] };
  }
}

function saveDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving licensing_db.json:', e);
  }
}

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

// ─── KEY GENERATOR ───────────────────────────────────────────────────────────
function generateKey() {
  const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `OMNI-${p1}-${p2}-${p3}`;
}

function createLicense({ clientName, clientPhone, durationDays = 30, maxVideos = 0 }) {
  const db = loadDb();
  const key = generateKey();
  const now = new Date();
  
  let expiresAt = null;
  if (durationDays > 0) {
    const expDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    expiresAt = expDate.toISOString();
  } else {
    expiresAt = 'LIFETIME';
  }

  const record = {
    key,
    clientName: clientName || 'Client',
    clientPhone: clientPhone || '',
    status: 'active', // 'active' | 'suspended' | 'expired'
    durationDays: durationDays <= 0 ? 'Lifetime' : `${durationDays} Days`,
    createdAt: now.toISOString(),
    expiresAt,
    boundHwid: null,
    totalVideos: 0,
    todayVideos: 0,
    lastActiveDate: null,
    lastPing: null,
    maxVideos: parseInt(maxVideos) || 0 // 0 = unlimited
  };

  db.licenses.unshift(record);
  saveDb(db);
  return record;
}

// ─── VERIFY & BIND LICENSE ───────────────────────────────────────────────────
function verifyAndBindLicense(key, hwid) {
  const db = loadDb();
  const record = db.licenses.find(l => l.key.toUpperCase() === String(key).trim().toUpperCase());

  if (!record) {
    return { valid: false, error: 'Invalid activation key. Please check or contact Hammad.' };
  }

  if (record.status === 'suspended') {
    return {
      valid: false,
      status: 'suspended',
      error: 'Your license has been suspended by the administrator. Contact WhatsApp: 03198662419.'
    };
  }

  // Check Expiry
  if (record.expiresAt && record.expiresAt !== 'LIFETIME') {
    const exp = new Date(record.expiresAt).getTime();
    if (Date.now() > exp) {
      record.status = 'expired';
      saveDb(db);
      return { valid: false, status: 'expired', error: 'Your license key has expired.' };
    }
  }

  // Check HWID Binding
  if (!record.boundHwid) {
    // First activation: bind to this machine!
    record.boundHwid = hwid;
    record.lastActiveDate = new Date().toISOString();
    saveDb(db);
  } else if (record.boundHwid !== hwid) {
    return {
      valid: false,
      error: 'This key is already activated on another computer! Contact admin to reset HWID.'
    };
  }

  // Record ping
  record.lastPing = new Date().toISOString();
  saveDb(db);

  return {
    valid: true,
    key: record.key,
    clientName: record.clientName,
    status: record.status,
    expiresAt: record.expiresAt,
    boundHwid: record.boundHwid,
    totalVideos: record.totalVideos || 0
  };
}

// ─── CLIENT LOCAL LICENSE FILE IO ────────────────────────────────────────────
function getLocalClientLicense() {
  if (!fs.existsSync(CLIENT_LICENSE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CLIENT_LICENSE_FILE, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function saveLocalClientLicense(lic) {
  try {
    fs.writeFileSync(CLIENT_LICENSE_FILE, JSON.stringify(lic, null, 2), 'utf-8');
  } catch (e) {}
}

function clearLocalClientLicense() {
  try {
    if (fs.existsSync(CLIENT_LICENSE_FILE)) fs.unlinkSync(CLIENT_LICENSE_FILE);
  } catch (e) {}
}

// ─── TELEMETRY & STATS RECORDER ──────────────────────────────────────────────
function recordVideoTelemetry(key, { videoId, ratio, duration, prompt }) {
  const db = loadDb();
  const today = getTodayString();

  // 1. Update Daily Video Stats
  if (!db.dailyStats) db.dailyStats = {};
  if (!db.dailyStats[today]) db.dailyStats[today] = 0;
  db.dailyStats[today]++;

  // 2. Update License stats
  const record = db.licenses.find(l => l.key.toUpperCase() === String(key).trim().toUpperCase());
  if (record) {
    record.totalVideos = (record.totalVideos || 0) + 1;

    // Reset todayVideos if day changed
    if (record.lastActiveDate && record.lastActiveDate.split('T')[0] !== today) {
      record.todayVideos = 1;
    } else {
      record.todayVideos = (record.todayVideos || 0) + 1;
    }

    record.lastActiveDate = new Date().toISOString();
    record.lastPing = new Date().toISOString();
  }

  // 3. Log event
  if (!db.telemetryLogs) db.telemetryLogs = [];
  db.telemetryLogs.unshift({
    id: videoId || Date.now().toString(),
    type: 'video',
    key: key || 'UNKNOWN',
    clientName: record ? record.clientName : 'Client',
    ratio: ratio || '16:9',
    duration: duration || '8s',
    prompt: prompt ? String(prompt).slice(0, 100) : '',
    timestamp: new Date().toISOString()
  });

  // Keep last 250 telemetry logs
  if (db.telemetryLogs.length > 250) db.telemetryLogs.length = 250;

  saveDb(db);
}

function recordImageTelemetry(key, { imageId, ratio, model, prompt }) {
  const db = loadDb();
  const today = getTodayString();

  // 1. Update Daily Image Stats
  if (!db.dailyImageStats) db.dailyImageStats = {};
  if (!db.dailyImageStats[today]) db.dailyImageStats[today] = 0;
  db.dailyImageStats[today]++;

  // 2. Update License stats
  const record = db.licenses.find(l => l.key.toUpperCase() === String(key).trim().toUpperCase());
  if (record) {
    record.totalImages = (record.totalImages || 0) + 1;

    // Reset todayImages if day changed
    if (record.lastActiveDate && record.lastActiveDate.split('T')[0] !== today) {
      record.todayImages = 1;
    } else {
      record.todayImages = (record.todayImages || 0) + 1;
    }

    record.lastActiveDate = new Date().toISOString();
    record.lastPing = new Date().toISOString();
  }

  // 3. Log event
  if (!db.telemetryLogs) db.telemetryLogs = [];
  db.telemetryLogs.unshift({
    id: imageId || Date.now().toString(),
    type: 'image',
    key: key || 'FREE_POOL',
    clientName: record ? record.clientName : (key === 'FREE_IMAGE_POOL' ? 'Free Client (Shared Pool)' : 'Client'),
    ratio: ratio || '1:1',
    model: model || 'Nano Banana',
    prompt: prompt ? String(prompt).slice(0, 100) : '',
    timestamp: new Date().toISOString()
  });

  if (db.telemetryLogs.length > 250) db.telemetryLogs.length = 250;

  saveDb(db);
}

// ─── ADMIN ACTIONS ───────────────────────────────────────────────────────────
function setLicenseStatus(key, status) {
  const db = loadDb();
  const record = db.licenses.find(l => l.key.toUpperCase() === String(key).trim().toUpperCase());
  if (!record) return { success: false, error: 'License key not found' };

  record.status = status; // 'active', 'suspended', 'expired'
  saveDb(db);
  return { success: true, key: record.key, status: record.status };
}

function resetLicenseHwid(key) {
  const db = loadDb();
  const record = db.licenses.find(l => l.key.toUpperCase() === String(key).trim().toUpperCase());
  if (!record) return { success: false, error: 'License key not found' };

  record.boundHwid = null;
  saveDb(db);
  return { success: true, message: 'HWID reset successfully! User can now activate on new PC.' };
}

function deleteLicense(key) {
  const db = loadDb();
  const idx = db.licenses.findIndex(l => l.key.toUpperCase() === String(key).trim().toUpperCase());
  if (idx === -1) return { success: false, error: 'License key not found' };

  db.licenses.splice(idx, 1);
  saveDb(db);
  return { success: true };
}

// ─── ADMIN SHARED IMAGE ACCOUNTS (FREE IMAGE ENGINE) ─────────────────────────
function getSharedImageAccounts() {
  const db = loadDb();
  return db.sharedImageAccounts || [];
}

function addSharedImageAccount({ label, email, cookies }) {
  const db = loadDb();
  if (!db.sharedImageAccounts) db.sharedImageAccounts = [];
  const newAcc = {
    id: 'shared_img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    label: (label && label.trim()) || `Shared Image Bot #${db.sharedImageAccounts.length + 1}`,
    email: (email && email.trim()) || 'Shared Pool Account',
    cookies: cookies ? cookies.trim() : '',
    status: 'active',
    projectVideoCount: 0,
    projectId: null,
    addedAt: new Date().toISOString()
  };
  db.sharedImageAccounts.push(newAcc);
  saveDb(db);
  return { success: true, account: newAcc };
}

function deleteSharedImageAccount(id) {
  const db = loadDb();
  if (!db.sharedImageAccounts) db.sharedImageAccounts = [];
  db.sharedImageAccounts = db.sharedImageAccounts.filter(a => a.id !== id);
  saveDb(db);
  return { success: true };
}

// ─── AGGREGATED ADMIN STATS ──────────────────────────────────────────────────
function getAdminDashboardStats() {
  const db = loadDb();
  const today = getTodayString();

  let totalLifetimeVideos = 0;
  Object.values(db.dailyStats || {}).forEach(count => {
    totalLifetimeVideos += count || 0;
  });

  const todayVideos = (db.dailyStats && db.dailyStats[today]) || 0;

  let totalLifetimeImages = 0;
  Object.values(db.dailyImageStats || {}).forEach(count => {
    totalLifetimeImages += count || 0;
  });

  const todayImages = (db.dailyImageStats && db.dailyImageStats[today]) || 0;

  const totalLicenses = db.licenses.length;
  const activeLicenses = db.licenses.filter(l => l.status === 'active').length;
  const suspendedLicenses = db.licenses.filter(l => l.status === 'suspended').length;
  const sharedAccounts = db.sharedImageAccounts || [];

  // Build 7-day analytics chart data for both videos and images
  const chartLabels = [];
  const chartVideoValues = [];
  const chartImageValues = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().split('T')[0];
    const displayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    chartLabels.push(displayLabel);
    chartVideoValues.push((db.dailyStats && db.dailyStats[dayStr]) || 0);
    chartImageValues.push((db.dailyImageStats && db.dailyImageStats[dayStr]) || 0);
  }

  return {
    totalLifetimeVideos,
    todayVideos,
    totalLifetimeImages,
    todayImages,
    totalLicenses,
    activeLicenses,
    suspendedLicenses,
    sharedAccountsCount: sharedAccounts.length,
    sharedAccounts,
    chart: {
      labels: chartLabels,
      videoValues: chartVideoValues,
      imageValues: chartImageValues,
      values: chartVideoValues // Backwards compatibility
    },
    licenses: db.licenses,
    recentActivity: (db.telemetryLogs || []).slice(0, 30)
  };
}

module.exports = {
  getHardwareId,
  createLicense,
  verifyAndBindLicense,
  getLocalClientLicense,
  saveLocalClientLicense,
  clearLocalClientLicense,
  recordVideoTelemetry,
  recordImageTelemetry,
  getSharedImageAccounts,
  addSharedImageAccount,
  deleteSharedImageAccount,
  setLicenseStatus,
  resetLicenseHwid,
  deleteLicense,
  getAdminDashboardStats,
  loadDb,
  saveDb
};

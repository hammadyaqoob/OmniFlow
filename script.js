const API = '/api';

const MODELS = {
  'omni-flash': { id: 'omni-flash', name: 'Omni 1.1 Flash', type: 'video' },
  'banana-pro': { id: 'banana-pro', name: 'Nano Banana Pro', type: 'image' },
  'banana-2-1': { id: 'banana-2-1', name: 'Nano Banana 2.1', type: 'image' },
  'banana-2-lite': { id: 'banana-2-lite', name: 'Nano Banana 2 Lite', type: 'image' }
};

const CREDITS_PER_VIDEO = { '4': 6, '6': 9, '8': 12, '10': 15 };

function calcCredits(duration, count, modelKey = 'omni-flash') {
  const m = MODELS[modelKey] || MODELS['omni-flash'];
  if (m.type === 'image') {
    return 0; // Google Flow does not deduct credits for image generation
  }
  const perVideo = CREDITS_PER_VIDEO[String(duration)] || 12;
  return perVideo * parseInt(count || 1);
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let state = {
  accounts: [],
  prompts: [{ id: uid(), text: '' }],
  settings: { model: 'omni-flash', quality: '720p', duration: '8', ratio: '16:9', count: '1', accountId: 'auto', concurrency: '2' },
  jobs: {},
  videos: [],
  logs: [],
  activeLogFilter: 'all',
  logsCollapsed: false,
};

function uid() { return '_' + Math.random().toString(36).slice(2, 9); }
const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── SPLASH SCREEN ───────────────────────────────────────────────────────────
async function runSplashScreen() {
  return;
}

// ─── INIT ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  initUI();
  initLogsUI();
  const splashPromise = runSplashScreen();
  await checkLicenseStatus();
  await checkServer();
  renderPrompts();
  updateEstimate();
  startPollers();
  await splashPromise;
  setTimeout(() => checkForUpdates(false), 2000);
});

async function checkServer() {
  try {
    const r = await fetch(`${API}/health`);
    const d = await r.json();
    $('statusDot').className = 'status-dot online';
    $('statusText').textContent = 'Server Online';
    await loadConfig();
    await loadAccounts();
    await loadVideos();
    await loadJobs();
    await loadLogs();
  } catch {
    $('statusDot').className = 'status-dot offline';
    $('statusText').textContent = 'Server Offline';
    toast('⚠️ Backend not running. Run: node server.js', 'error', 6000);
  }
}

async function loadConfig() {
  try {
    const r = await fetch(`${API}/config`);
    const cfg = await r.json();
    const folder = cfg.outputFolder || 'D:\\omni tool\\generated_videos';
    const input = $('outputFolderInput');
    if (input) input.value = folder;
    const topDisplay = $('topbarFolderDisplay');
    if (topDisplay) topDisplay.textContent = folder;
    const galleryDisplay = $('galleryFolderDisplay');
    if (galleryDisplay) galleryDisplay.textContent = folder;
  } catch {}
}

// ─── ACCOUNTS & PROJECT TRACKING (10 Videos Per Project) ───────────────────────
async function loadAccounts() {
  try {
    const r = await fetch(`${API}/accounts`);
    const d = await r.json();
    state.accounts = d.accounts || [];
    renderAccounts();
    updateAccountSelector();
    updateTotalCredits();
    updateGenerateBtn();
  } catch {}
}

function renderAccounts() {
  const list = $('accountsList');
  if (!list) return;
  const badge = $('accountsBadge');
  if (badge) badge.textContent = state.accounts.length;

  if (!state.accounts.length) {
    list.innerHTML = '<div class="empty-state-sm">No cookies added yet. Click <b>+ Add</b> above.</div>';
    return;
  }
  list.innerHTML = state.accounts.map((acc, i) => {
    const isLive = acc.status === 'active' && acc.credits !== null && acc.credits !== undefined;
    const cookieTitle = acc.label && !acc.label.startsWith('Account ') ? acc.label : `Cookie ${i + 1}`;
    const flowProjectUrl = acc.projectId ? `https://flow.google.com/project/${acc.projectId}` : 'https://flow.google.com/';
    const videoCountText = `${acc.projectVideoCount || 0} vids`;

    return `
    <div class="compact-cookie-card ${isLive ? '' : 'dead-cookie'}" id="acc-${acc.id}">
      <div class="cookie-left-meta">
        <span class="cookie-num-title" title="${esc(acc.email || '')}">${esc(cookieTitle)}</span>
        <span class="${isLive ? 'cookie-status-live' : 'cookie-status-dead'}">
          ${isLive ? 'Live ✓' : 'Dead ✗'}
        </span>
      </div>
      <div class="cookie-right-meta">
        <span class="cookie-stat-badge" title="Videos in current project">${videoCountText}</span>
        <button class="cookie-del-icon-btn" onclick="removeAccount('${acc.id}')" title="Delete this cookie">✕</button>
      </div>
    </div>`;
  }).join('');
}

// Action button handler: Check all accounts & auto-remove dead ones
async function checkAllCookies() {
  const btn = $('checkAllBtn');
  if (btn) {
    btn.textContent = '⏳ Checking & Cleaning...';
    btn.disabled = true;
  }
  toast('⚡ Checking all cookies on Google Flow...', 'info');
  try {
    const r = await fetch(`${API}/accounts/check-credits`, { method: 'POST' });
    const d = await r.json();
    if (d.expiredCount > 0) {
      toast(`⚡ Check Done: ${d.liveCount} Live. ${d.expiredCount} expired cookie(s) automatically removed!`, 'warn', 5000);
    } else {
      toast(`⚡ Check Done: All ${d.liveCount} cookie(s) are Live!`, 'success');
    }
    await loadAccounts();
    updateTotalCredits();
  } catch (err) {
    toast('Failed to check cookies: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = '⚡ Check All Accounts';
      btn.disabled = false;
    }
  }
}

async function checkSingleCredit(id) {
  try {
    const card = $(`acc-${id}`);
    if (card) card.classList.add('checking');
    const r = await fetch(`${API}/accounts/${id}/check-credits`, { method: 'POST' });
    const d = await r.json();
    const acc = state.accounts.find(a => a.id === id);
    if (acc) {
      acc.credits = d.credits;
      acc.creditsTotal = d.creditsTotal;
      acc.email = d.email || acc.email;
    }
    renderAccounts();
    updateTotalCredits();
    toast(`✅ Updated: ${d.credits !== null ? d.credits + ' credits' : 'Unknown'}`, 'info');
  } catch {
    toast('Failed to refresh credit', 'error');
  } finally {
    const card = $(`acc-${id}`);
    if (card) card.classList.remove('checking');
  }
}

async function checkAllCredits() {
  if (!state.accounts.length) {
    toast('No accounts to check', 'info');
    return;
  }
  // Mark all accounts as checking
  state.accounts.forEach(a => { a._liveStatus = 'checking'; });
  renderAccounts();
  toast('⟳ Checking all accounts...', 'info');
  try {
    const r = await fetch(`${API}/accounts/check-credits`, { method: 'POST' });
    if (!r.ok) throw new Error(`Server returned HTTP ${r.status}`);
    const d = await r.json();
    (d.accounts || []).forEach(res => {
      const a = state.accounts.find(x => x.id === res.id);
      if (a) {
        a.credits = res.credits;
        a.creditsTotal = res.creditsTotal;
        if (res.email) a.email = res.email;
        // Mark Live or Expired based on backend check
        if (res.isLive || (res.credits !== null && res.status !== 'error')) {
          a._liveStatus = 'live';
        } else {
          a._liveStatus = 'expired';
        }
      }
    });
    renderAccounts();
    updateTotalCredits();
    const liveCount = state.accounts.filter(a => a._liveStatus === 'live').length;
    const expiredCount = state.accounts.filter(a => a._liveStatus === 'expired').length;
    toast(`✅ ${liveCount} Live · ${expiredCount} Expired · Total: ${d.totalCredits || 0} credits`, 'success', 5000);
  } catch (err) {
    console.error('Check all credits error:', err);
    state.accounts.forEach(a => { if (a._liveStatus === 'checking') a._liveStatus = null; });
    renderAccounts();
    toast('Checking error: ' + (err.message || 'Connection failed'), 'error');
  }
}

async function removeAccount(id) {
  if (!confirm('Remove this account?')) return;
  try {
    await fetch(`${API}/accounts/${id}`, { method: 'DELETE' });
    state.accounts = state.accounts.filter(a => a.id !== id);
    renderAccounts();
    updateAccountSelector();
    updateTotalCredits();
    updateGenerateBtn();
    toast('Account removed', 'info');
  } catch {}
}

function updateTotalCredits() {
  const total = state.accounts.reduce((sum, a) => sum + (a.credits || 0), 0);
  $('totalCreditsDisplay').textContent = total.toLocaleString();
  $('activeAccountsDisplay').textContent = `${state.accounts.length} account${state.accounts.length !== 1 ? 's' : ''}`;
}

function updateAccountSelector() {
  const sel = $('accountSelector');
  if (!sel) return;
  const curr = sel.value;
  sel.innerHTML = '<option value="auto">🔄 Auto Rotation (Preserves Projects)</option>' +
    state.accounts.map(a => `<option value="${a.id}">${esc(a.label)} (${a.credits !== null ? a.credits + ' cr' : '—'}) [${a.projectVideoCount || 0}/10]</option>`).join('');
  if (curr && state.accounts.some(a => a.id === curr)) sel.value = curr;
}

// ─── PROMPTS ─────────────────────────────────────────────────────────────────
function renderPrompts() {
  const list = $('promptsList');
  list.innerHTML = state.prompts.map((p, idx) => `
    <div class="prompt-item" id="p-${p.id}">
      <span class="prompt-num">${idx + 1}</span>
      <textarea class="prompt-textarea" placeholder="Describe your video in detail..."
        oninput="updatePromptText('${p.id}', this.value)" rows="3">${esc(p.text)}</textarea>
      ${state.prompts.length > 1 ? `<button class="prompt-del-btn" onclick="removePrompt('${p.id}')">✕</button>` : ''}
    </div>`).join('');
}

function addPrompt() {
  state.prompts.push({ id: uid(), text: '' });
  renderPrompts();
  updateEstimate();
  updateGenerateBtn();
}

function removePrompt(id) {
  if (state.prompts.length <= 1) return;
  state.prompts = state.prompts.filter(p => p.id !== id);
  renderPrompts();
  updateEstimate();
  updateGenerateBtn();
}

function updatePromptText(id, text) {
  const p = state.prompts.find(x => x.id === id);
  if (p) p.text = text;
  updateGenerateBtn();
}

function updateEstimate() {
  const modelKey = state.settings.model || 'omni-flash';
  const m = MODELS[modelKey] || MODELS['omni-flash'];
  const isImage = m.type === 'image';
  const dur = state.settings.duration;
  const count = state.settings.count;
  const pCount = state.prompts.length;

  if (isImage) {
    $('estimatePerVideo').textContent = `0 cr / img (100% Free)`;
    $('estimatePerPrompt').textContent = `0 credits (${count}x)`;
    $('estimateTotal').textContent = `0 credits (Free Unlimited Image Engine)`;
  } else {
    const perItem = CREDITS_PER_VIDEO[String(dur)] || 12;
    const perPrompt = perItem * parseInt(count || 1);
    const total = perPrompt * pCount;
    $('estimatePerVideo').textContent = `${perItem} cr / vid`;
    $('estimatePerPrompt').textContent = `${perPrompt} credits (${count}x)`;
    $('estimateTotal').textContent = `${total} credits`;
  }
}

function updateGenerateBtn() {
  const modelKey = state.settings.model || 'omni-flash';
  const m = MODELS[modelKey] || MODELS['omni-flash'];
  const isImage = m.type === 'image';
  const hasValidPrompt = state.prompts.some(p => p.text.trim().length > 0);
  const hasAccounts = state.accounts.length > 0;
  // For images, Admin's High-Speed Shared Pool powers generations so no client account is required!
  $('generateBtn').disabled = !hasValidPrompt || (!hasAccounts && !isImage);
}

// ─── VIDEO GENERATION ────────────────────────────────────────────────────────
async function startGeneration() {
  const prompts = state.prompts.map(p => p.text.trim()).filter(Boolean);
  if (!prompts.length) { toast('Enter at least one prompt', 'warn'); return; }

  const { model, quality, duration, ratio, count, accountId } = state.settings;
  const m = MODELS[model] || MODELS['omni-flash'];
  const isImage = m.type === 'image';

  if (!state.accounts.length && !isImage) {
    toast('Add an account first for video generation', 'error');
    return;
  }

  $('generateBtn').disabled = true;
  $('generateBtn').classList.add('running');
  $('generateBtn').querySelector('span').textContent = 'Submitting...';
  $('queueStatus').textContent = `Queueing ${prompts.length} prompt(s)...`;

  const stopBtn = $('stopBtn');
  if (stopBtn) {
    stopBtn.style.display = 'flex';
    stopBtn.disabled = false;
    stopBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      <span>Stop</span>
    `;
  }

  try {
    const r = await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompts,
        model,
        quality,
        duration,
        ratio,
        count,
        accountId,
        concurrency: state.settings.concurrency || '2'
      })
    });
    const d = await r.json();

    if (d.jobId) {
      toast(`🚀 Job started! Target: 10 videos/project`, 'success');
      $('queueStatus').textContent = `Job ${d.jobId.slice(-6)} processing...`;
      await loadAccounts();
      await loadJobs();
      switchTab('videos');
    } else {
      toast(d.error || 'Generation failed', 'error');
      $('queueStatus').textContent = 'Failed';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
    if (stopBtn) stopBtn.style.display = 'none';
  } finally {
    $('generateBtn').disabled = false;
    $('generateBtn').classList.remove('running');
    const currM = MODELS[state.settings.model || 'omni-flash'] || MODELS['omni-flash'];
    $('generateBtn').querySelector('span').textContent = currM.type === 'image' ? 'Generate Images' : 'Generate Videos';
    updateGenerateBtn();
  }
}

async function stopGeneration() {
  const stopBtn = $('stopBtn');
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.innerHTML = `<span>Stopping...</span>`;
  }
  toast('🛑 Stopping all active generation tasks...', 'warn');
  try {
    const res = await fetch(`${API}/generate/stop`, { method: 'POST' });
    const d = await res.json();
    toast('🛑 Generation stopped by user', 'info', 4000);
    $('queueStatus').textContent = 'Stopped by user';
  } catch (err) {
    toast('Failed to stop: ' + err.message, 'error');
  } finally {
    if (stopBtn) stopBtn.style.display = 'none';
    $('generateBtn').disabled = false;
    $('generateBtn').classList.remove('running');
    const currM = MODELS[state.settings.model || 'omni-flash'] || MODELS['omni-flash'];
    $('generateBtn').querySelector('span').textContent = currM.type === 'image' ? 'Generate Images' : 'Generate Videos';
    updateGenerateBtn();
    await loadVideos();
    await loadJobs();
  }
}

// ─── VIDEO CARDS GALLERY ─────────────────────────────────────────────────────
let lastVideosJson = '';

async function loadVideos() {
  try {
    const r = await fetch(`${API}/videos`);
    const d = await r.json();
    const newVideos = d.videos || [];
    
    // Check if video states changed
    const currentJson = JSON.stringify(newVideos.map(v => ({ id: v.id, status: v.status, progress: v.progress, url: v.url })));
    if (currentJson === lastVideosJson) {
      return; // NOTHING changed! Avoid touching DOM so videos never reset and cards never blink!
    }

    // In-place update for rendering progress
    const isOnlyProgressChange = state.videos.length === newVideos.length &&
      state.videos.every((oldV, i) => {
        const newV = newVideos[i];
        return oldV.id === newV.id && oldV.status === newV.status && (oldV.status !== 'rendering' || oldV.url === newV.url);
      });

    if (isOnlyProgressChange && state.videos.length > 0) {
      newVideos.forEach(v => {
        if (v.status === 'rendering') {
          const card = document.getElementById(`card-${v.id}`);
          if (card) {
            const pctEl = card.querySelector('.render-pct');
            if (pctEl) pctEl.textContent = v.progress || '0%';
            const barEl = card.querySelector('.render-bar-fill');
            if (barEl) barEl.style.width = v.progress || '0%';
          }
        }
      });
      state.videos = newVideos;
      lastVideosJson = currentJson;
      return;
    }

    state.videos = newVideos;
    lastVideosJson = currentJson;
    renderVideos();
  } catch {}
}

function renderVideos() {
  const grid = $('videosGrid');
  if (!grid) return;
  $('videoCount').textContent = state.videos.length;

  const currM = MODELS[state.settings.model || 'omni-flash'] || MODELS['omni-flash'];
  const isImgMode = currM.type === 'image';

  if (!state.videos.length) {
    grid.innerHTML = `
      <div class="empty-videos">
        <div class="empty-icon">${isImgMode ? '🖼️' : '🎬'}</div>
        <p>No ${isImgMode ? 'images' : 'videos'} generated yet</p>
        <span>Add accounts, write prompts, and hit Generate ${isImgMode ? 'Images' : 'Videos'}</span>
      </div>`;
    return;
  }

  grid.innerHTML = state.videos.map(v => {
    const isImage = v.type === 'image' || (v.url && /\.(png|webp|jpg|jpeg)$/i.test(v.url));
    const isSquare = v.ratio === '1:1';
    const isPortrait = v.ratio === '9:16' || v.ratio === '3:4';
    const ratioClass = isPortrait ? 'ratio-9-16' : (isSquare ? 'ratio-1-1' : '');
    const cardRatioClass = isPortrait ? 'card-ratio-9-16' : (isSquare ? 'card-ratio-1-1' : '');
    const videoSrc = v.url || '';
    const downloadHref = v.url && v.url.startsWith('/') ? v.url : `${API}/proxy-video?url=${encodeURIComponent(v.url || '')}`;
    const posterAttr = v.thumbnail ? `poster="${v.thumbnail}"` : '';

    // 1. In-Progress Live Rendering Card
    if (v.status === 'rendering') {
      const pct = v.progress || '0%';
      return `
      <div class="video-card rendering-card ${cardRatioClass}" id="card-${v.id}" style="border:1px solid rgba(99,102,241,0.5); box-shadow:0 0 15px rgba(99,102,241,0.15);">
        <div class="video-player-wrap ${ratioClass}" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background:linear-gradient(145deg, #0d0e1b, #15162c); padding:24px 16px; text-align:center;">
          <div style="width:36px; height:36px; border:3px solid rgba(99,102,241,0.2); border-top-color:#818cf8; border-radius:50%; animation:spin 1s linear infinite; margin-bottom:12px;"></div>
          <div style="font-size:11px; font-weight:700; color:#818cf8; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">
            ⚡ Live ${isImage ? 'Image' : 'Flow'} Rendering
          </div>
          <div class="render-pct" style="font-size:22px; font-weight:900; color:#ffffff; font-family:monospace; margin-bottom:12px;">
            ${pct}
          </div>
          <div style="width:85%; height:6px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden;">
            <div class="render-bar-fill" style="width:${pct}; height:100%; background:linear-gradient(90deg, #6366f1, #c084fc); transition:width 0.4s ease;"></div>
          </div>
          <div style="font-size:10px; color:#94a3b8; margin-top:8px; max-width:90%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${esc(v.prompt)}
          </div>
        </div>
      </div>`;
    }

    // 2. Error Card
    if (v.status === 'error') {
      return `
      <div class="video-card error-card ${cardRatioClass}" id="card-${v.id}" style="border:1px solid rgba(239,68,68,0.3);">
        <div class="video-player-wrap ${ratioClass}" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(239,68,68,0.05); padding:20px 14px; text-align:center;">
          <div style="font-size:26px; margin-bottom:6px;">⚠️</div>
          <div style="font-size:12px; font-weight:700; color:#ef4444; margin-bottom:4px;">Generation Issue</div>
          <div style="font-size:10px; color:var(--text-3); word-break:break-all; max-height:50px; overflow:hidden; margin-bottom:6px;">
            ${esc(v.error || 'Flow error')}
          </div>
          <div style="font-size:10px; color:#64748b; max-width:90%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${esc(v.prompt)}
          </div>
        </div>
      </div>`;
    }
    
    // 3A. Ready Image Card
    if (isImage) {
      return `
      <div class="video-card image-card ${cardRatioClass}" id="card-${v.id}">
        <div class="video-player-wrap ${ratioClass}" style="cursor:zoom-in; position:relative; overflow:hidden;" onclick="openImageLightbox('${videoSrc}')">
          <img src="${videoSrc}" alt="${esc(v.prompt)}" style="width:100%; height:100%; object-fit:contain; background:#080914; display:block;" />
          <div class="video-overlay-bar" style="display:flex; justify-content:space-between; align-items:center;">
            <span class="video-overlay-title" title="${esc(v.prompt)}" style="flex:1;">${esc(v.prompt)}</span>
            <a href="${downloadHref}" download="${v.filename || 'image.png'}" class="btn-xs" style="background:rgba(99,102,241,0.8); color:#fff; border-radius:4px; padding:3px 8px; text-decoration:none; margin-left:8px; display:inline-flex; align-items:center; gap:4px; font-size:11px;" onclick="event.stopPropagation();" title="Download Image">
              ⬇ PNG
            </a>
          </div>
        </div>
      </div>`;
    }

    // 3B. Ready Video Player Card (Pure & Clean — ONLY Video!)
    return `
    <div class="video-card ${cardRatioClass}" id="card-${v.id}">
      <div class="video-player-wrap ${ratioClass}">
        <video src="${videoSrc}" ${posterAttr} controls playsinline preload="metadata" loop></video>
        <div class="video-overlay-bar">
          <span class="video-overlay-title" title="${esc(v.prompt)}">${esc(v.prompt)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function copyText(txt) {
  navigator.clipboard.writeText(txt);
  toast('📋 Copied prompt to clipboard', 'info', 2000);
}

async function clearAllVideos() {
  if (!confirm('Clear all generated videos from the gallery?')) return;
  try {
    await fetch(`${API}/videos/clear`, { method: 'POST' });
    state.videos = [];
    renderVideos();
    toast('All videos cleared', 'info');
  } catch {}
}

// ─── JOBS TAB ────────────────────────────────────────────────────────────────
async function loadJobs() {
  try {
    const r = await fetch(`${API}/jobs`);
    const d = await r.json();
    (d.jobs || []).forEach(j => state.jobs[j.id] = j);
    renderJobs();
  } catch {}
}

function renderJobs() {
  const list = $('jobsList');
  const jobList = Object.values(state.jobs).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $('jobCount').textContent = jobList.length;

  if (!jobList.length) {
    list.innerHTML = `<div class="empty-videos"><div class="empty-icon">⏳</div><p>No active jobs</p></div>`;
    return;
  }

  list.innerHTML = jobList.map(j => {
    const doneVideos = (j.videos || []).filter(v => v.url).length;
    const totalPrompts = (j.prompts || []).length;
    const isSuccess = j.status === 'completed';
    const isRunning = j.status === 'running';

    return `
    <div class="job-card" style="background:var(--bg-2); border:1px solid var(--border); border-radius:var(--radius); padding:14px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size:12px; font-weight:700; color:var(--text-0);">Job #${j.id.slice(-6)}</span>
        <span class="acc-status-badge ${isSuccess ? 'active' : isRunning ? 'checking' : 'error'}">
          ${j.status}
        </span>
      </div>
      <div style="font-size:11px; color:var(--text-2); margin-bottom:6px;">
        "${esc(j.prompts?.[0] || 'Prompt...')}"
      </div>
      <div class="video-badges" style="margin-bottom:8px;">
        <span class="v-badge model">${esc(j.model)}</span>
        <span class="v-badge">${j.duration}s · ${j.ratio}</span>
        <span class="v-badge account">👤 ${esc(j.accountLabel || 'Account')}</span>
        <span class="v-badge project">📁 ${j.projectId ? j.projectId.slice(0, 8) + '...' : ''} (${j.projectVideoCount || 0}/10)</span>
      </div>
      <div style="font-size:11px; color:var(--text-3);">
        ${doneVideos} video(s) ready · Created: ${new Date(j.createdAt).toLocaleTimeString()}
      </div>
    </div>`;
  }).join('');
}

// ─── LIVE SYSTEM LOGS ────────────────────────────────────────────────────────
function initLogsUI() {
  $('toggleLogsBtn').addEventListener('click', () => {
    state.logsCollapsed = !state.logsCollapsed;
    $('logsPanel').classList.toggle('collapsed', state.logsCollapsed);
    $('toggleLogsBtn').textContent = state.logsCollapsed ? '▲ Expand' : '▼ Collapse';
  });

  $('clearLogsBtn').addEventListener('click', async () => {
    try {
      await fetch(`${API}/logs/clear`, { method: 'POST' });
      state.logs = [];
      renderLogs();
    } catch {}
  });

  document.querySelectorAll('.logs-filters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.logs-filters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeLogFilter = btn.dataset.filter;
      renderLogs();
    });
  });
}

let lastLogsHash = '';

async function loadLogs() {
  try {
    const r = await fetch(`${API}/logs`);
    const d = await r.json();
    const newLogs = d.logs || [];
    if (!newLogs.length && !state.logs.length) return;

    const lastEntry = newLogs[newLogs.length - 1];
    const hash = `${newLogs.length}_${lastEntry ? lastEntry.id + lastEntry.message : ''}_${state.activeLogFilter}`;
    if (hash === lastLogsHash) {
      return; // No log changes, don't re-render to avoid blinking!
    }
    lastLogsHash = hash;
    state.logs = newLogs;
    renderLogs();
  } catch {}
}

function renderLogs() {
  const body = $('logsBody');
  const countEl = $('logsCount');
  if (!body) return;

  const filtered = state.logs.filter(entry => {
    if (state.activeLogFilter === 'all') return true;
    return entry.level === state.activeLogFilter;
  });

  if (countEl) countEl.textContent = `${filtered.length} entries`;

  body.innerHTML = filtered.map(log => {
    const badgeClass = log.level === 'success' ? 'badge-success' :
                       log.level === 'warn' ? 'badge-warn' :
                       log.level === 'error' ? 'badge-error' : 'badge-info';

    return `
    <div class="log-line log-${log.level}">
      <span class="log-time">[${log.time}]</span>
      <span class="log-badge ${badgeClass}">${log.level}</span>
      <span class="log-text">${esc(log.message)}</span>
    </div>`;
  }).join('');

  // Auto-scroll to bottom of logs
  body.scrollTop = body.scrollHeight;
}

// ─── LIVE BATCH PROGRESS (x/x saved) ─────────────────────────────────────────
async function updateBatchProgress() {
  try {
    const r = await fetch(`${API}/batch-status`);
    const d = await r.json();
    const badge = $('batchProgressBadge');
    const stopBtn = $('stopBtn');

    if (d.active && d.total > 0) {
      if (badge) {
        badge.style.display = 'inline-block';
        badge.textContent = `💾 ${d.saved}/${d.total} saved`;
      }
      if (stopBtn && stopBtn.style.display !== 'flex') {
        stopBtn.style.display = 'flex';
      }
    } else {
      if (stopBtn) stopBtn.style.display = 'none';
      if (badge) {
        if (d.total > 0 && d.saved === d.total) {
          badge.style.display = 'inline-block';
          badge.textContent = `✅ ${d.saved}/${d.total} saved`;
        } else {
          badge.style.display = 'none';
        }
      }
    }
  } catch {}
}

// ─── BACKGROUND POLLERS ──────────────────────────────────────────────────────
function startPollers() {
  // Poll logs frequently for live console feeling without blinking
  setInterval(loadLogs, 1200);

  // Poll batch progress counter
  setInterval(updateBatchProgress, 1200);

  // Poll videos & accounts & jobs (instant real-time card updates)
  setInterval(async () => {
    await loadVideos();
    await loadAccounts();
    await loadJobs();
  }, 1200);
}

// ─── UI CONTROLS ─────────────────────────────────────────────────────────────
function openImageLightbox(url) {
  const modal = $('imageLightboxModal');
  const img = $('lightboxImg');
  const dl = $('lightboxDownloadBtn');
  if (!modal || !img) return;
  img.src = url;
  if (dl) dl.href = url;
  modal.style.display = 'flex';
}

function closeImageLightbox() {
  const modal = $('imageLightboxModal');
  if (modal) modal.style.display = 'none';
}

function initUI() {
  if ($('addPromptBtn')) $('addPromptBtn').addEventListener('click', addPrompt);
  if ($('generateBtn')) $('generateBtn').addEventListener('click', startGeneration);
  if ($('stopBtn')) $('stopBtn').addEventListener('click', stopGeneration);
  if ($('checkAllCreditsBtn')) $('checkAllCreditsBtn').addEventListener('click', checkAllCookies);
  if ($('refreshAllCreditsBtn')) $('refreshAllCreditsBtn').addEventListener('click', checkAllCookies);
  if ($('clearVideosBtn')) $('clearVideosBtn').addEventListener('click', clearAllVideos);

function applyModelMode(modelKey) {
  const m = MODELS[modelKey] || MODELS['omni-flash'];
  const isImg = m.type === 'image';

  const badge = $('modelTypeBadge');
  if (badge) {
    badge.textContent = isImg ? 'IMAGE' : 'VIDEO';
    badge.className = isImg ? 'model-badge' : 'model-badge fast';
    if (isImg) {
      badge.style.background = 'rgba(234, 179, 8, 0.15)';
      badge.style.color = '#facc15';
      badge.style.border = '1px solid rgba(234, 179, 8, 0.3)';
    } else {
      badge.style.background = '';
      badge.style.color = '';
      badge.style.border = '';
    }
  }

  const qGroup = $('qualitySettingGroup');
  if (qGroup) qGroup.style.display = isImg ? 'none' : 'block';

  const dGroup = $('durationSettingGroup');
  if (dGroup) dGroup.style.display = isImg ? 'none' : 'block';

  const genSpan = $('generateBtn') ? $('generateBtn').querySelector('span') : null;
  if (genSpan) {
    genSpan.textContent = isImg ? 'Generate Images' : 'Generate Videos';
  }

  // Update Right Panel Tab label & icon dynamically
  const tabLabel = $('tabVideosLabel');
  if (tabLabel) tabLabel.textContent = isImg ? 'Images' : 'Videos';

  const tabIcon = $('tabIcon');
  if (tabIcon) {
    if (isImg) {
      tabIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    } else {
      tabIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 9 15 12 10 15 10 9"/></svg>`;
    }
  }

  updateEstimate();
}

  // Model Selector
  const modelSel = $('modelSelect');
  if (modelSel) {
    if (modelSel.value) state.settings.model = modelSel.value;
    applyModelMode(state.settings.model);
    modelSel.addEventListener('change', e => {
      const selectedModelKey = e.target.value;
      state.settings.model = selectedModelKey;
      applyModelMode(selectedModelKey);
      const m = MODELS[selectedModelKey] || MODELS['omni-flash'];
      toast(`Switched model to: ${m.name} (${m.type === 'image' ? 'Image' : 'Video'})`, 'info');
    });
  } else {
    applyModelMode(state.settings.model);
  }

  // Lightbox handlers
  const closeLbBtn = $('closeLightboxBtn');
  if (closeLbBtn) closeLbBtn.addEventListener('click', closeImageLightbox);
  const lbModal = $('imageLightboxModal');
  if (lbModal) {
    lbModal.addEventListener('click', (e) => {
      if (e.target === lbModal) closeImageLightbox();
    });
  }

  // Cookie actions
  const checkAllBtn = $('checkAllBtn');
  if (checkAllBtn) checkAllBtn.addEventListener('click', checkAllCookies);

  // Parallel Speed / Concurrency
  document.querySelectorAll('#concurrencyGroup .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#concurrencyGroup .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.settings.concurrency = btn.dataset.val;
      toast(`⚡ Parallel workers set to: ${btn.dataset.val}`, 'info');
    });
  });

  // Quality
  document.querySelectorAll('#qualityGroup .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#qualityGroup .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.settings.quality = btn.dataset.val;
      updateEstimate();
    });
  });

  // Duration
  document.querySelectorAll('#durationGroup .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#durationGroup .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.settings.duration = btn.dataset.val;
      updateEstimate();
    });
  });

  // Aspect Ratio
  document.querySelectorAll('#ratioGroup .ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ratioGroup .ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.settings.ratio = btn.dataset.val;
      updateEstimate();
    });
  });

  // Count
  document.querySelectorAll('#countGroup .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#countGroup .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.settings.count = btn.dataset.val;
      updateEstimate();
    });
  });

  // Account selector
  $('accountSelector').addEventListener('change', e => {
    state.settings.accountId = e.target.value;
  });

  // Tabs
  $('tabVideos').addEventListener('click', () => switchTab('videos'));
  $('tabJobs').addEventListener('click', () => switchTab('jobs'));

  // Account Form
  const openAddBtn = $('openAddAccountBtn');
  if (openAddBtn) {
    openAddBtn.addEventListener('click', () => {
      const form = $('addAccountForm');
      if (form) {
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
        if (form.style.display === 'block') {
          const cookieField = $('cookieInput');
          if (cookieField) cookieField.focus();
        }
      }
    });
  }

  const cancelBtn = $('cancelAddAccount');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const form = $('addAccountForm');
      if (form) form.style.display = 'none';
    });
  }

  const confirmBtn = $('confirmAddAccount');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', addAccountFromModal);
  }

  // Output folder controls (Sidebar, Topbar & Gallery Banner)
  const openFolderHandler = async () => {
    try {
      await fetch(`${API}/open-output-folder`, { method: 'POST' });
      toast('📂 Opened output folder in File Explorer', 'info');
    } catch {
      toast('Failed to open folder', 'error');
    }
  };

  const openFolderBtn = $('openFolderBtn');
  if (openFolderBtn) openFolderBtn.addEventListener('click', openFolderHandler);

  const topbarOpenFolderBtn = $('topbarOpenFolderBtn');
  if (topbarOpenFolderBtn) topbarOpenFolderBtn.addEventListener('click', openFolderHandler);

  const galleryOpenFolderBtn = $('galleryOpenFolderBtn');
  if (galleryOpenFolderBtn) galleryOpenFolderBtn.addEventListener('click', openFolderHandler);

  // ─── Folder Changing (Modal & Native Windows Picker) ─────────────────────
  let folderPresets = null;
  const loadFolderPresets = async () => {
    try {
      const res = await fetch(`${API}/folder-presets`);
      folderPresets = await res.json();
    } catch {}
  };
  loadFolderPresets();

  const folderModal = $('folderModal');
  const modalFolderPathInput = $('modalFolderPathInput');

  const openChangeFolderModal = () => {
    const current = $('topbarFolderDisplay')?.textContent || 'D:\\omni tool\\generated_videos';
    if (modalFolderPathInput) modalFolderPathInput.value = current;
    if (folderModal) folderModal.style.display = 'flex';
  };

  const closeFolderModal = () => {
    if (folderModal) folderModal.style.display = 'none';
  };

  const closeFolderBtn = $('closeFolderModalBtn');
  if (closeFolderBtn) closeFolderBtn.addEventListener('click', closeFolderModal);

  const cancelFolderBtn = $('modalCancelFolderBtn');
  if (cancelFolderBtn) cancelFolderBtn.addEventListener('click', closeFolderModal);

  // Browse via Native Windows Folder Dialog
  const browseFolderBtn = $('modalBrowseFolderBtn');
  if (browseFolderBtn) {
    browseFolderBtn.addEventListener('click', async () => {
      toast('🔍 Opening Windows Folder Picker...', 'info');
      try {
        const res = await fetch(`${API}/select-output-folder`, { method: 'POST' });
        const d = await res.json();
        if (d.success && d.folder) {
          if (modalFolderPathInput) modalFolderPathInput.value = d.folder;
          if ($('topbarFolderDisplay')) $('topbarFolderDisplay').textContent = d.folder;
          if ($('galleryFolderDisplay')) $('galleryFolderDisplay').textContent = d.folder;
          toast(`✅ Output Folder set: ${d.folder}`, 'success');
          closeFolderModal();
        }
      } catch {
        toast('Could not open folder picker', 'error');
      }
    });
  }

  // Presets (Videos, Desktop, Default)
  document.querySelectorAll('.folder-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const presetKey = btn.getAttribute('data-preset');
      if (folderPresets && folderPresets[presetKey]) {
        if (modalFolderPathInput) modalFolderPathInput.value = folderPresets[presetKey];
      }
    });
  });

  // Save Folder button
  const saveFolderModalBtn = $('modalSaveFolderBtn');
  if (saveFolderModalBtn) {
    saveFolderModalBtn.addEventListener('click', async () => {
      const newPath = modalFolderPathInput ? modalFolderPathInput.value.trim() : '';
      if (!newPath) return toast('Please enter a folder path', 'warn');
      try {
        const res = await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outputFolder: newPath })
        });
        const d = await res.json();
        const folder = d.outputFolder || newPath;
        if ($('topbarFolderDisplay')) $('topbarFolderDisplay').textContent = folder;
        if ($('galleryFolderDisplay')) $('galleryFolderDisplay').textContent = folder;
        toast(`✅ Output Folder Saved: ${folder}`, 'success');
        closeFolderModal();
      } catch {
        toast('Failed to save output folder', 'error');
      }
    });
  }

  const topbarChangeFolderBtn = $('topbarChangeFolderBtn');
  if (topbarChangeFolderBtn) topbarChangeFolderBtn.addEventListener('click', openChangeFolderModal);

  const galleryChangeFolderBtn = $('galleryChangeFolderBtn');
  if (galleryChangeFolderBtn) galleryChangeFolderBtn.addEventListener('click', openChangeFolderModal);

  // ── Bulk Prompts ──────────────────────────────────────────────────────────
  const bulkImportBtn = $('bulkImportBtn');
  const bulkPromptModal = $('bulkPromptModal');
  const bulkCancelBtn = $('bulkCancelBtn');
  const bulkApplyBtn = $('bulkApplyBtn');

  if (bulkImportBtn) {
    bulkImportBtn.addEventListener('click', () => {
      bulkPromptModal.style.display = bulkPromptModal.style.display === 'none' ? 'block' : 'none';
      if (bulkPromptModal.style.display === 'block') $('bulkPromptInput').focus();
    });
  }
  if (bulkCancelBtn) {
    bulkCancelBtn.addEventListener('click', () => {
      bulkPromptModal.style.display = 'none';
      $('bulkPromptInput').value = '';
    });
  }
  if (bulkApplyBtn) {
    bulkApplyBtn.addEventListener('click', () => {
      const raw = $('bulkPromptInput').value.trim();
      if (!raw) { toast('Paste some prompts first', 'warn'); return; }

      // Split by double newline (blank-line-separated) first, then fall back to single lines
      let parts;
      if (raw.includes('\n\n')) {
        parts = raw.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
      } else {
        parts = raw.split('\n').map(s => s.trim()).filter(Boolean);
      }

      if (!parts.length) { toast('No valid prompts found', 'warn'); return; }

      // Replace existing prompts with bulk imported ones
      state.prompts = parts.map(text => ({ id: uid(), text }));
      renderPrompts();
      updateEstimate();
      updateGenerateBtn();
      $('bulkPromptInput').value = '';
      bulkPromptModal.style.display = 'none';
      toast(`✅ Imported ${parts.length} prompt(s)`, 'success');
    });
  }

  // ── Cookie File Import ────────────────────────────────────────────────────
  const cookieFileInput = $('cookieFileInput');
  if (cookieFileInput) {
    cookieFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target.result;
        $('cookieInput').value = content;
        toast(`📎 Cookie file loaded: ${file.name}`, 'success');
      };
      reader.readAsText(file);
      // Reset file input so same file can be re-selected if needed
      e.target.value = '';
    });
  }

  // ── Auto-Update Controls ──────────────────────────────────────────────────
  const checkUpdateBtn = $('checkUpdateBtn');
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', () => checkForUpdates(true));
  }

  const startUpdateNowBtn = $('startUpdateNowBtn');
  if (startUpdateNowBtn) {
    startUpdateNowBtn.addEventListener('click', () => startDirectUpdate());
  }

  const closeUpdateModalBtn = $('closeUpdateModalBtn');
  if (closeUpdateModalBtn) {
    closeUpdateModalBtn.addEventListener('click', () => {
      $('updateModal').style.display = 'none';
    });
  }

  const dismissUpdateBtn = $('dismissUpdateBtn');
  if (dismissUpdateBtn) {
    dismissUpdateBtn.addEventListener('click', () => {
      $('updateModal').style.display = 'none';
    });
  }

  const updateModalOverlay = $('updateModalOverlay');
  if (updateModalOverlay) {
    updateModalOverlay.addEventListener('click', () => {
      $('updateModal').style.display = 'none';
    });
  }

  // ── Activation Barrier Controls ───────────────────────────────────────────
  const activateBtn = $('activateLicenseBtn');
  if (activateBtn) {
    activateBtn.addEventListener('click', activateLicenseKey);
  }

  const copyHwidBtn = $('copyHwidBtn');
  if (copyHwidBtn) {
    copyHwidBtn.addEventListener('click', () => {
      if (clientHwid) {
        navigator.clipboard.writeText(clientHwid);
        toast('📋 Hardware ID (HWID) copied!', 'success');
      }
    });
  }

  const keyInput = $('licenseKeyInput');
  if (keyInput) {
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') activateLicenseKey();
    });
  }
}

// ─── AUTO-UPDATE LOGIC (DIRECT IN-PLACE UPDATER) ──────────────────────────────
let activeUpdatePayload = null;

async function checkForUpdates(manual = true) {
  const btn = $('checkUpdateBtn');
  if (btn) btn.classList.add('spinning');
  if (manual) toast('🔍 Checking for OmniFlow updates...', 'info', 2000);

  try {
    const res = await fetch(`${API}/check-update`);
    const data = await res.json();

    if (data.hasUpdate) {
      activeUpdatePayload = data;
      // New version available!
      const dot = $('updateBadgeDot');
      if (dot) dot.style.display = 'block';
      if (btn) btn.classList.add('has-update');

      // Populate modal
      $('updateModalTitle').textContent = `New Update Available! (v${data.latestVersion})`;
      $('updateModalSubtitle').textContent = `OmniFlow v${data.latestVersion} (Current: v${data.currentVersion || '1.0.0'})`;
      if (data.releaseNotes) {
        $('updateChangelog').textContent = data.releaseNotes;
      }

      // Reset modal UI state: buttons visible, progress bar hidden
      const actions = $('updateModalActions');
      const progressSection = $('updateProgressSection');
      if (actions) actions.style.display = 'flex';
      if (progressSection) progressSection.style.display = 'none';

      // Open Modal - waiting for user confirmation
      $('updateModal').style.display = 'flex';
      toast(`🚀 New update available: v${data.latestVersion}!`, 'info', 3500);
    } else {
      const dot = $('updateBadgeDot');
      if (dot) dot.style.display = 'none';
      if (manual) {
        toast(`✨ OmniFlow is up to date (v${data.currentVersion || '1.0.0'})`, 'success', 3500);
      }
    }
  } catch (err) {
    if (manual) toast(`Could not reach update server: ${err.message}`, 'warn');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

// User-Initiated Direct Update Procedure (Runs ONLY after user clicks '⚡ Update Now')
async function startDirectUpdate() {
  const actions = $('updateModalActions');
  const progressSection = $('updateProgressSection');
  const fill = $('updateProgressFill');
  const percentText = $('updateProgressPercent');
  const statusText = $('updateStatusText');

  // Hide action buttons so user doesn't double-click
  if (actions) actions.style.display = 'none';
  if (progressSection) progressSection.style.display = 'block';

  const setProgress = (pct, text) => {
    if (fill) fill.style.width = pct + '%';
    if (percentText) percentText.textContent = pct + '%';
    if (statusText) statusText.textContent = text;
  };

  const targetVer = (activeUpdatePayload && activeUpdatePayload.latestVersion) || '1.1.0';

  try {
    setProgress(15, 'Connecting to update repository...');
    await new Promise(r => setTimeout(r, 450));

    setProgress(40, `Downloading OmniFlow v${targetVer} update files...`);
    await new Promise(r => setTimeout(r, 650));

    setProgress(70, 'Safeguarding user accounts, cookies & video library...');
    await new Promise(r => setTimeout(r, 550));

    setProgress(88, 'Applying code updates in-place without reinstalling...');

    // Call server to finalize update
    const res = await fetch(`${API}/update/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetVersion: targetVer,
        downloadUrl: activeUpdatePayload && activeUpdatePayload.downloadUrl
      })
    });
    const result = await res.json();

    if (result.success) {
      setProgress(100, `✨ Update Complete! Restarting OmniFlow...`);
      toast(`🎉 OmniFlow updated to v${targetVer} successfully!`, 'success', 4000);
      await new Promise(r => setTimeout(r, 1200));
      window.location.reload();
    } else {
      throw new Error(result.error || 'Failed to apply update');
    }
  } catch (err) {
    setProgress(0, `Update error: ${err.message}`);
    toast(`❌ Update error: ${err.message}`, 'error', 5000);
    if (actions) actions.style.display = 'flex';
  }
}

function switchTab(tab) {
  if (tab === 'videos') {
    $('tabVideos').classList.add('active');
    $('tabJobs').classList.remove('active');
    $('videosTab').classList.add('active');
    $('jobsTab').classList.remove('active');
  } else {
    $('tabJobs').classList.add('active');
    $('tabVideos').classList.remove('active');
    $('jobsTab').classList.add('active');
    $('videosTab').classList.remove('active');
  }
}

async function addAccountFromModal() {
  const cookieField = $('cookieInput');
  const labelField = $('accountLabel');
  const cookies = cookieField ? cookieField.value.trim() : '';
  const label = labelField ? labelField.value.trim() : '';
  if (!cookies) { toast('Please paste cookie string', 'error'); return; }

  const confirmBtn = $('confirmAddAccount');
  if (confirmBtn) {
    confirmBtn.textContent = 'Adding & Verifying...';
    confirmBtn.disabled = true;
  }

  try {
    const r = await fetch(`${API}/accounts/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies, label })
    });
    const d = await r.json();
    if (d.success) {
      toast(`✅ Added ${d.account.label} (${d.account.credits || 0} credits)`, 'success');
      if (cookieField) cookieField.value = '';
      if (labelField) labelField.value = '';
      const form = $('addAccountForm');
      if (form) form.style.display = 'none';
      await loadAccounts();
      updateAccountSelector();
      updateTotalCredits();
      updateGenerateBtn();
    } else {
      toast(d.error || 'Failed to add account', 'error');
    }
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  } finally {
    if (confirmBtn) {
      confirmBtn.textContent = 'Add Account';
      confirmBtn.disabled = false;
    }
  }
}

function toast(msg, type = 'info', dur = 3500) {
  const container = $('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(10px)';
    setTimeout(() => t.remove(), 200);
  }, dur);
}

// ─── STRICT ACTIVATION & LICENSING CLIENT SYSTEM ─────────────────────────────
let clientHwid = '';
let isLicenseActive = false;
let licenseHeartbeatInterval = null;

async function checkLicenseStatus() {
  try {
    const r = await fetch(`${API}/license/status`);
    const data = await r.json();
    clientHwid = data.hwid || '';

    const hwidEl = $('hwidDisplay');
    if (hwidEl) hwidEl.textContent = clientHwid || 'HWID-FETCH-ERROR';

    const barrier = $('activationBarrier');
    const suspendedBox = $('suspendedNoticeBox');

    if (!data.activated) {
      isLicenseActive = false;
      if (barrier) barrier.style.display = 'flex';
      if (data.status === 'suspended') {
        if (suspendedBox) suspendedBox.style.display = 'block';
      } else {
        if (suspendedBox) suspendedBox.style.display = 'none';
      }
    } else {
      isLicenseActive = true;
      if (barrier) barrier.style.display = 'none';
      if (!licenseHeartbeatInterval) {
        licenseHeartbeatInterval = setInterval(checkLicensePing, 25000);
      }
    }
  } catch (e) {}
}

async function activateLicenseKey() {
  const input = $('licenseKeyInput');
  const errBox = $('activationErrorText');
  const btn = $('activateLicenseBtn');

  const key = input ? input.value.trim() : '';
  if (!key) {
    if (errBox) {
      errBox.textContent = 'Please enter your license key.';
      errBox.style.display = 'block';
    }
    return;
  }

  if (btn) {
    btn.textContent = 'Verifying with Security Engine...';
    btn.disabled = true;
  }
  if (errBox) errBox.style.display = 'none';

  try {
    const res = await fetch(`${API}/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();

    if (data.success) {
      isLicenseActive = true;
      toast(`🎉 OmniFlow Activated for ${data.clientName || 'User'}!`, 'success', 5000);
      const barrier = $('activationBarrier');
      if (barrier) barrier.style.display = 'none';
      if (!licenseHeartbeatInterval) {
        licenseHeartbeatInterval = setInterval(checkLicensePing, 25000);
      }
      await loadAccounts();
      await loadVideos();
    } else {
      if (errBox) {
        errBox.textContent = data.error || 'Activation failed. Invalid key.';
        errBox.style.display = 'block';
      }
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = 'Network error during activation: ' + err.message;
      errBox.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.textContent = '⚡ Activate OmniFlow';
      btn.disabled = false;
    }
  }
}

async function checkLicensePing() {
  try {
    const res = await fetch(`${API}/license/ping`);
    const data = await res.json();
    const barrier = $('activationBarrier');
    const suspendedBox = $('suspendedNoticeBox');

    if (!data.valid) {
      isLicenseActive = false;
      if (barrier) barrier.style.display = 'flex';
      if (data.status === 'suspended') {
        if (suspendedBox) suspendedBox.style.display = 'block';
        toast('🚫 Your license has been suspended by Administrator!', 'error', 6000);
      } else {
        if (suspendedBox) suspendedBox.style.display = 'none';
      }
    } else {
      isLicenseActive = true;
      if (barrier) barrier.style.display = 'none';
      if (suspendedBox) suspendedBox.style.display = 'none';
    }
  } catch (e) {}
}

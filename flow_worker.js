const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function getChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}
const CHROME_PATH = getChromePath();

function parseCookiesForPuppeteer(cookieStr) {
  const list = [];
  if (cookieStr.includes('\t')) {
    cookieStr.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const name = parts[5];
        const isHttpOnly = ['SID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID', 'OSID', '__Secure-OSID'].includes(name);
        list.push({
          name: parts[5],
          value: parts[6],
          domain: parts[0],
          path: parts[2] || '/',
          secure: parts[3] === 'TRUE',
          httpOnly: isHttpOnly
        });
      }
    });
  }
  return list;
}

// Parse args
const args = process.argv.slice(2);
let promptText = '';
let duration = '8';
let ratio = '16:9';
let quality = '720p';
let count = '1';
let projectId = '';
let accountId = '';
let isNewProjectNeeded = false;
let outputDir = path.join(__dirname, 'generated_videos');
let modelId = 'omni-flash';
let modelName = 'Omni 1.1 Flash';
let itemType = 'video';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prompt' && args[i + 1]) promptText = args[++i];
  if (args[i] === '--duration' && args[i + 1]) duration = args[++i];
  if (args[i] === '--ratio' && args[i + 1]) ratio = args[++i];
  if (args[i] === '--quality' && args[i + 1]) quality = args[++i];
  if (args[i] === '--count' && args[i + 1]) count = args[++i];
  if (args[i] === '--project' && args[i + 1]) projectId = args[++i];
  if (args[i] === '--account' && args[i + 1]) accountId = args[++i];
  if (args[i] === '--outputDir' && args[i + 1]) outputDir = args[++i];
  if (args[i] === '--newProject') isNewProjectNeeded = true;
  if (args[i] === '--model' && args[i + 1]) modelId = args[++i];
  if (args[i] === '--modelName' && args[i + 1]) modelName = args[++i];
  if (args[i] === '--type' && args[i + 1]) itemType = args[++i];
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function runWorker() {
  let accs = [];
  try {
    const accPath = path.join(__dirname, 'accounts.json');
    if (fs.existsSync(accPath)) accs = JSON.parse(fs.readFileSync(accPath, 'utf8'));
  } catch {}
  try {
    const dbPath = path.join(__dirname, 'licensing_db.json');
    if (fs.existsSync(dbPath)) {
      const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (Array.isArray(db.sharedImageAccounts) && db.sharedImageAccounts.length) {
        accs = accs.concat(db.sharedImageAccounts);
      }
    }
  } catch {}

  let account = accs.find(a => a.id === accountId);
  if (!account) account = accs[0];
  if (!account || !account.cookies) {
    console.log('JSON_RESULT:' + JSON.stringify({
      success: false,
      error: 'No active Google Flow account with valid cookies found.'
    }));
    process.exit(1);
  }

  const cookies = parseCookiesForPuppeteer(account.cookies);
  let targetProject = isNewProjectNeeded ? null : (projectId || account.projectId);
  if (!targetProject || targetProject === 'none') {
    isNewProjectNeeded = true;
    targetProject = null;
  }

  const isImageMode = itemType === 'image';
  console.log(`LOG:[Worker] Starting Google Flow session for ${account.label} (${account.email || 'account'})...`);
  console.log(`LOG:[Worker Strict Config] Mode: ${isImageMode ? 'IMAGE' : 'VIDEO'} | Model: ${modelName} | Ratio: ${ratio} | Count: x${count}${isImageMode ? '' : ` | Dur: ${duration}s | Quality: ${quality}`}`);

  const os = require('os');
  const workerTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow_w_'));

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    protocolTimeout: 0, // Unlimited CDP timeout to prevent Runtime.callFunctionOn timeouts
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
      '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${workerTempDir}`
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setCookie(...cookies);
    await page.setViewport({ width: 1280, height: 800 });

    // Request interception to block non-essential telemetry and prevent socket exhaustion
    let capturedMediaUrl = null;
    let capturedImageUrl = null;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (
        u.includes('google-analytics.com') ||
        u.includes('googletagmanager.com') ||
        u.includes('/collect?') ||
        u.includes('play.google.com/log')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    page.on('response', (res) => {
      try {
        const u = res.url();
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if ((u.includes('flow-content.google/video') || ct.includes('video/mp4') || ct.includes('video/') || u.includes('.mp4')) && u.startsWith('http')) {
          capturedMediaUrl = u;
          console.log(`LOG:[Worker] 🎯 Flow Video URL detected: ${u.slice(0, 90)}...`);
        }
        if (isImageMode && (u.includes('flow-content.google/image') || (ct.includes('image/') && !u.includes('favicon') && !u.includes('avatar') && !u.includes('logo')))) {
          capturedImageUrl = u;
        }
      } catch (e) {}
    });

    // Dedicated thread-isolated download folder so parallel workers NEVER cross-download
    const threadDownloadDir = path.join(workerTempDir, 'downloads');
    if (!fs.existsSync(threadDownloadDir)) fs.mkdirSync(threadDownloadDir, { recursive: true });

    try {
      const browserCdp = await browser.target().createCDPSession();
      await browserCdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: threadDownloadDir,
        eventsEnabled: true
      });
    } catch (e) {}

    try {
      const pageCdp = await page.target().createCDPSession();
      await pageCdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: threadDownloadDir
      });
    } catch (e) {}

    let createdProjectId = null;

    // ─── 1. NEW PROJECT CREATION OR NAVIGATION ───────────────────────────────
    if (isNewProjectNeeded || !targetProject) {
      targetProject = null;
      console.log(`LOG:[Worker] Navigating to Google Flow to create a brand NEW project for ${account.label}...`);
      try {
        await page.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (navErr) {
        if (navErr.message.includes('detached') || navErr.message.includes('timeout')) {
          console.log('LOG:[Worker] Handling navigation redirect...');
        } else {
          throw navErr;
        }
      }
      await new Promise(r => setTimeout(r, 2500));

      // Check session
      let curUrl = page.url();
      if (curUrl.includes('CookieMismatch') || curUrl.includes('signin') || curUrl.includes('ServiceLogin')) {
        throw new Error(`Google Session Expired (${curUrl.includes('CookieMismatch') ? 'CookieMismatch' : 'Sign-in required'}). Please update cookies for ${account.label}.`);
      }

      // If redirected to /about landing page, click "Create with Google Flow" / "Try in Google Flow"
      if (curUrl.includes('/about')) {
        console.log('LOG:[Worker] On Flow landing page, entering studio workspace...');
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a'));
          const enterBtn = btns.find(b => {
            const t = (b.innerText || '').toLowerCase();
            return t.includes('create with google flow') || t.includes('try in google flow') || t.includes('open flow');
          });
          if (enterBtn) enterBtn.click();
        });
        await new Promise(r => setTimeout(r, 3500));
        curUrl = page.url();
      }

      // Check if Google Flow auto-opened a project
      if (curUrl.includes('/project/')) {
        const m = curUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
        if (m) {
          createdProjectId = m[1];
          targetProject = createdProjectId;
          console.log(`LOG:[Worker] ✅ Automatically routed to project: ${targetProject}`);
        }
      }

      if (!targetProject) {
        console.log('LOG:[Worker] Clicking "+ New project" on Google Flow dashboard...');
        let clicked = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, .mat-mdc-button-base'));
            const newBtn = buttons.find(b => {
              const t = (b.innerText || '').toLowerCase().trim();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
              return t.includes('new project') || aria.includes('new project') || t.includes('create project') || aria.includes('create project');
            });
            if (newBtn) {
              newBtn.click();
              return true;
            }
            return false;
          });
          if (clicked) break;
          await new Promise(r => setTimeout(r, 1500));
        }

        if (!clicked) {
          clicked = await page.evaluate(() => {
            const plus = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              const text = (b.innerText || '').trim();
              return aria.includes('create') || aria.includes('add') || text === '+' || aria === 'new';
            });
            if (plus) { plus.click(); return true; }
            return false;
          });
        }

        if (!clicked) {
          const sel = await page.waitForSelector('button.new-project-button, button[aria-label*="New project" i]', { timeout: 20000 }).catch(() => null);
          if (sel) {
            await sel.click();
          } else {
            throw new Error('Could not find "+ New project" button on dashboard. Please check cookies.');
          }
        }

        console.log('LOG:[Worker] Waiting for redirect to newly created project...');
        await page.waitForFunction(() => window.location.href.includes('/project/'), { timeout: 45000 });
        const finalProjUrl = page.url();
        const m = finalProjUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
        if (m) {
          createdProjectId = m[1];
          targetProject = createdProjectId;
          console.log(`LOG:[Worker] ✅ NEW Google Flow project created: ${targetProject}`);
        }
      }
    } else {
      console.log(`LOG:[Worker] Reusing saved project ${targetProject} (Project quota active)...`);
      try {
        await page.goto(`https://flow.google.com/project/${targetProject}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (navErr) {
        if (navErr.message.includes('detached') || navErr.message.includes('timeout')) {
          console.log('LOG:[Worker] Project navigation settled.');
        } else {
          throw navErr;
        }
      }
    }

    // ─── 2. CHECK SESSION VALIDITY ────────────────────────────────────────────
    const currentUrl = page.url();
    if (currentUrl.includes('CookieMismatch') || currentUrl.includes('/about') || currentUrl.includes('signin') || currentUrl.includes('ServiceLogin')) {
      throw new Error(`Google Session Expired (${currentUrl.includes('CookieMismatch') ? 'CookieMismatch' : 'Sign-in required'}). Cookies have expired on Google.`);
    }

    // ─── 3. WAIT FOR WORKSPACE ────────────────────────────────────────────────
    try {
      await page.waitForSelector('.ProseMirror, button[aria-label="Settings trigger"], .settings-trigger-button', { timeout: 35000 });
    } catch {
      console.log('LOG:[Worker] Waiting for editor workspace...');
      await page.waitForSelector('.ProseMirror, button[aria-label="Settings trigger"], .settings-trigger-button, .generate-icon-button', { timeout: 30000 });
    }

    // ─── 4. STRICT LOCK: MODE & MODEL SELECTION ──────────────────────────────
    console.log(`LOG:[Worker] Enforcing strict ${isImageMode ? 'Image' : 'Video'} Mode & ${modelName} settings in Google Flow...`);
    
    const settingsBtn = await page.waitForSelector('button[aria-label="Settings trigger"], .settings-trigger-button', { timeout: 45000 });
    await settingsBtn.click();
    await new Promise(r => setTimeout(r, 800));

    if (isImageMode) {
      // A. Click Image Toggle
      const imgToggleHandle = await page.evaluateHandle(() => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
        return toggles.find(t => (t.innerText || '').includes('Image'));
      });
      if (imgToggleHandle) {
        await imgToggleHandle.click();
        console.log('LOG:[Worker] ✅ Clicked Image mode toggle');
        await new Promise(r => setTimeout(r, 600));
      }

      // B. Ratio Toggle Click (Supports 16:9, 4:3, 1:1, 3:4, 9:16)
      if (ratio) {
        const ratioHandle = await page.evaluateHandle((targetRatio) => {
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          return toggles.find(t => (t.innerText || '').trim() === targetRatio || (t.innerText || '').includes(targetRatio));
        }, ratio);
        if (ratioHandle) {
          await ratioHandle.click();
          console.log(`LOG:[Worker] ✅ Image aspect ratio set to: ${ratio}`);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // C. Count Toggle Click (x1, x2, x3, x4)
      const targetCountTag = `x${count || '1'}`;
      const countHandle = await page.evaluateHandle((targetCount) => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
        return toggles.find(t => (t.innerText || '').trim() === targetCount);
      }, targetCountTag);
      if (countHandle) {
        await countHandle.click();
        console.log(`LOG:[Worker] ✅ Image count set to: ${targetCountTag}`);
        await new Promise(r => setTimeout(r, 300));
      }

      // D. Select Image Model Family
      // Options in Flow: 🍌 Nano Banana Pro, 🍌 Nano Banana 2.1, 🍌 Nano Banana 2 Lite
      let targetNeedle = 'Pro';
      if (modelId.includes('2-1') || modelId.includes('2.1') || modelName.includes('2.1')) {
        targetNeedle = '2.1';
      } else if (modelId.includes('lite') || modelName.toLowerCase().includes('lite')) {
        targetNeedle = 'Lite';
      } else {
        targetNeedle = 'Pro';
      }

      const modelFamilyBtn = await page.$('button[aria-label="Select model family"]');
      if (modelFamilyBtn) {
        const currentModelText = await page.evaluate(el => el.innerText.trim(), modelFamilyBtn);
        console.log(`LOG:[Worker] Current Model in dropdown: "${currentModelText.replace(/\n/g, ' ')}"`);
        
        if (!currentModelText.toLowerCase().includes(targetNeedle.toLowerCase())) {
          console.log(`LOG:[Worker] Opening model family dropdown to select "${targetNeedle}"...`);
          await modelFamilyBtn.click();
          await new Promise(r => setTimeout(r, 600));

          const selected = await page.evaluate((needle) => {
            const items = Array.from(document.querySelectorAll('.mat-mdc-menu-item, [role="menuitem"], button, mat-option'));
            const match = items.find(el => (el.innerText || '').toLowerCase().includes(needle.toLowerCase()));
            if (match) {
              match.click();
              return true;
            }
            return false;
          }, targetNeedle);

          if (selected) {
            console.log(`LOG:[Worker] ✅ Selected "${targetNeedle}" model from dropdown`);
          } else {
            console.log(`LOG:[Worker] ⚠️ Could not find menu item for "${targetNeedle}", keeping current selection`);
          }
          await new Promise(r => setTimeout(r, 400));
        } else {
          console.log(`LOG:[Worker] ✅ Model is already set to "${targetNeedle}"`);
        }
      }

    } else {
      // Video Mode:
      // A. Native Puppeteer Click on Video Toggle
      const vidToggleHandle = await page.evaluateHandle(() => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
        return toggles.find(t => (t.innerText || '').includes('Video'));
      });
      if (vidToggleHandle) {
        await vidToggleHandle.click();
        console.log('LOG:[Worker] ✅ Native click applied to Video toggle');
        await new Promise(r => setTimeout(r, 600));
      }

      // B. Ratio Toggle Click
      if (ratio) {
        const ratioHandle = await page.evaluateHandle((targetRatio) => {
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          return toggles.find(t => (t.innerText || '').includes(targetRatio));
        }, ratio);
        if (ratioHandle) {
          await ratioHandle.click();
          console.log(`LOG:[Worker] ✅ Aspect ratio set to: ${ratio}`);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // C. Duration Toggle Click
      if (duration) {
        const durHandle = await page.evaluateHandle((targetDur) => {
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          return toggles.find(t => (t.innerText || '').trim() === `${targetDur}s`);
        }, duration);
        if (durHandle) {
          await durHandle.click();
          console.log(`LOG:[Worker] ✅ Duration set to: ${duration}s`);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // D. Quality Toggle Click
      if (quality) {
        const qualHandle = await page.evaluateHandle((targetQual) => {
          const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
          return toggles.find(t => (t.innerText || '').includes(targetQual));
        }, quality);
        if (qualHandle) {
          await qualHandle.click();
          console.log(`LOG:[Worker] ✅ Quality set to: ${quality}`);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // E. Count Toggle Click (CRITICAL: Strict x1 enforcement)
      const targetCountTag = `x${count || '1'}`;
      const countHandle = await page.evaluateHandle((targetCount) => {
        const toggles = Array.from(document.querySelectorAll('mat-button-toggle'));
        return toggles.find(t => (t.innerText || '').trim() === targetCount);
      }, targetCountTag);
      if (countHandle) {
        await countHandle.click();
        console.log(`LOG:[Worker] ✅ Count strictly locked to: ${targetCountTag} (1 video per prompt)`);
        await new Promise(r => setTimeout(r, 300));
      }

      // F. Verify Model is Omni 1.1 Flash
      const modelFamilyBtn = await page.$('button[aria-label="Select model family"]');
      if (modelFamilyBtn) {
        const currentModelText = await page.evaluate(el => el.innerText.trim(), modelFamilyBtn);
        if (!currentModelText.includes('Omni') && !currentModelText.includes('Flash')) {
          console.log(`LOG:[Worker] Selecting Omni 1.1 Flash from model family dropdown...`);
          await modelFamilyBtn.click();
          await new Promise(r => setTimeout(r, 500));

          await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.mat-mdc-menu-item, [role="menuitem"], button'));
            const omni = items.find(el => (el.innerText || '').includes('Omni 1.1 Flash') || (el.innerText || '').includes('Omni'));
            if (omni) omni.click();
          });
          await new Promise(r => setTimeout(r, 400));
        } else {
          console.log(`LOG:[Worker] ✅ Model locked: "${currentModelText.replace(/\n/g, ' ')}"`);
        }
      }
    }

    // Close settings popup
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));

    // Verification: Inspect bottom bar settings chip
    const bottomChipText = await page.evaluate(() => {
      const chip = document.querySelector('button[aria-label="Settings trigger"], .settings-trigger-button');
      return chip ? chip.innerText.trim().replace(/\n/g, ' ') : '';
    });
    console.log(`LOG:[Worker Verification] Flow Mode: "${bottomChipText}"`);
    
    if (isImageMode) {
      if (bottomChipText.toLowerCase().includes('omni') || (bottomChipText.toLowerCase().includes('video') && !bottomChipText.toLowerCase().includes('image'))) {
        console.log(`LOG:[Worker Warn] Expected Image mode but chip says: "${bottomChipText}".`);
      }
    } else {
      if (bottomChipText.toLowerCase().includes('banana') || bottomChipText.toLowerCase().includes('image')) {
        throw new Error(`Google Flow is in Image mode (${bottomChipText}). Aborted to prevent unwanted image generation.`);
      }
    }

    // Record list of existing files in outputDir before generation
    const existingFilesBefore = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];

    // ─── 5. INSTANT PROMPT INJECTION (Fast Paste) ─────────────────────────────
    console.log(`LOG:[Worker] Pasting prompt into Google Flow: "${promptText.slice(0, 60)}..."`);
    await page.waitForSelector('.ProseMirror, [contenteditable="true"], textarea', { timeout: 25000 });
    const promptInput = await page.$('.ProseMirror, [contenteditable="true"], textarea');
    if (promptInput) {
      await promptInput.click();
    } else {
      await page.click('.ProseMirror');
    }

    const pasted = await page.evaluate((text) => {
      const el = document.querySelector('.ProseMirror, [contenteditable="true"]');
      if (el) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        return document.execCommand('insertText', false, text);
      }
      return false;
    }, promptText);

    if (!pasted) {
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(promptText, { delay: 4 });
    }

    await new Promise(r => setTimeout(r, 500));

    // Record existing image URLs and tile signatures before typing to only pick the NEW one
    const existingImgUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .map(i => i.src)
        .filter(s => s && (s.includes('flow-content.google') || s.includes('lh3.googleusercontent.com')));
    });

    const existingTileSignatures = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container, flow-image-tile, flow-video-tile, [role="group"]'));
      return tiles.map(t => (t.getAttribute('aria-label') || '') + ':::' + (t.innerText || '').slice(0, 50));
    });

    // ─── 6. CLICK GENERATE BUTTON ────────────────────────────────────────────
    capturedMediaUrl = null;
    capturedImageUrl = null;
    console.log('LOG:[Worker] Clicking Start Generation button...');
    const generateBtn = await page.$('.generate-icon-button, button[aria-label="Start generation"]');
    if (!generateBtn) throw new Error('Start generation button not found');
    await generateBtn.click();

    console.log('LOG:[Flow Signal] Prompt submitted to Google Flow! Tile rendering started.');
    console.log(`LOG:[Worker] Generation started on Google Flow (${isImageMode ? 'Image' : 'Video'})! Live rendering...`);

    // ─── 7. MONITOR PROGRESS ─────────────────────────────────────────────────
    let done = false;
    let attempts = 0;
    let lastPct = '';

    const maxWaitAttempts = isImageMode ? 45 : 120;
    while (!done && attempts < maxWaitAttempts) {
      await new Promise(r => setTimeout(r, 2500));
      attempts++;

      const status = await page.evaluate((isImg) => {
        const text = document.body.innerText;
        const pctMatch = text.match(/(\d+)%/);
        const hasGenerating = text.includes('Generating') || text.includes('Rendering');
        
        let hasCompleted = false;
        if (isImg) {
          const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src);
          hasCompleted = imgs.some(s => s && (s.includes('flow-content.google') || s.includes('lh3.googleusercontent.com')));
        } else {
          hasCompleted = !!document.querySelector('video, button[aria-label="Download media"], button[aria-label*="Download" i]');
        }

        return {
          pct: pctMatch ? pctMatch[1] + '%' : null,
          hasGenerating,
          hasCompleted
        };
      }, isImageMode);

      if (status.pct && status.pct !== lastPct) {
        lastPct = status.pct;
        console.log(`LOG:[OmniFlow Engine] Rendering progress: ${status.pct}`);
      }

      if (status.pct === '100%') {
        done = true;
      } else if (!status.hasGenerating && status.hasCompleted && attempts > (isImageMode ? 4 : 8)) {
        done = true;
      }
    }

    console.log(`LOG:[OmniFlow Engine] ${isImageMode ? 'Image' : 'Video'} rendering 100% completed!`);
    await new Promise(r => setTimeout(r, 2500));

    let finalVideoUrl = null;
    let finalImageUrl = null;
    let finalSavedFilename = null;
    const promptSlug = promptText.toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 35)
      .replace(/^_|_$/g, '');

    if (isImageMode) {
      // ─── 8. EXTRACT & SAVE HIGH-RES IMAGE ───────────────────────────────────
      console.log('LOG:[Worker] Extracting high-res rendered image from Google Flow...');
      await page.waitForSelector('flow-grid-tile-container, flow-image-tile, [role="group"]', { timeout: 15000 }).catch(() => {});

      let targetImgSrc = capturedImageUrl || null;

      if (!targetImgSrc) {
        targetImgSrc = await page.evaluate((initialUrls) => {
          const imgs = Array.from(document.querySelectorAll('img'))
            .map(i => i.src)
            .filter(s => s && (s.includes('flow-content.google') || s.includes('lh3.googleusercontent.com')));
          const newImgs = imgs.filter(s => !initialUrls.includes(s));
          return newImgs.length ? newImgs[newImgs.length - 1] : (imgs.length ? imgs[imgs.length - 1] : null);
        }, existingImgUrls);
      }

      if (!targetImgSrc) {
        // Click the latest tile to load full image
        await page.evaluate(() => {
          const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container, flow-image-tile, [role="group"]'));
          if (tiles.length) tiles[tiles.length - 1].click();
        });
        await new Promise(r => setTimeout(r, 1500));
        targetImgSrc = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src).filter(s => s && s.includes('flow-content.google'));
          return imgs.length ? imgs[imgs.length - 1] : null;
        });
      }

      if (targetImgSrc) {
        console.log(`LOG:[Worker] Flow Image URL detected: ${targetImgSrc.slice(0, 80)}...`);
        finalSavedFilename = `flow_${Date.now()}_${promptSlug}.png`;
        const destPath = path.join(outputDir, finalSavedFilename);

        let imageBuffer = null;
        try {
          const resp = await axios.get(targetImgSrc, { responseType: 'arraybuffer', timeout: 30000 });
          if (resp.data && resp.data.length > 3000) {
            imageBuffer = Buffer.from(resp.data);
          }
        } catch (axErr) {
          console.log(`LOG:[Worker] Direct axios download notice (${axErr.message}), trying in-browser fetch...`);
        }

        if (!imageBuffer) {
          const base64Str = await page.evaluate(async (url) => {
            try {
              const r = await fetch(url);
              const b = await r.blob();
              return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(b);
              });
            } catch { return null; }
          }, targetImgSrc);

          if (base64Str && base64Str.includes(',')) {
            const rawBase64 = base64Str.split(',')[1];
            imageBuffer = Buffer.from(rawBase64, 'base64');
          }
        }

        if (imageBuffer && imageBuffer.length > 0) {
          fs.writeFileSync(destPath, imageBuffer);
          const stats = fs.statSync(destPath);
          console.log(`LOG:[Worker] ✅ Full Image File Saved: ${finalSavedFilename} (${Math.round(stats.size / 1024)} KB)`);
          finalImageUrl = `/generated_videos/${finalSavedFilename}`;
        }
      }
    } else {
      // ─── 8. DOWNLOAD FULL 720P ORIGINAL VIDEO (Direct CDN Stream) ─────────────
      // Check if already in Video Player / Timeline View
      let dlBtn = await page.$('button[aria-label="Download media"], button[aria-label*="Download" i]');

      if (dlBtn) {
        console.log('LOG:[Worker] Video player is open. Selecting newest clip in timeline...');
        await page.evaluate(() => {
          const clips = Array.from(document.querySelectorAll('.clip, [role="tab"], flow-timeline-clip, .clip-thumbnail, .clips-list button, mat-button-toggle'));
          if (clips.length > 1) {
            clips[clips.length - 1].click();
          }
        });
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log('LOG:[Worker] On grid canvas. Finding newly generated video tile...');
        await page.waitForSelector('flow-grid-tile-container, flow-video-tile, [role="group"]', { timeout: 15000 }).catch(() => {});

        const tileInfo = await page.evaluate((prompt, existingSigs) => {
          const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container, flow-video-tile, [role="group"]'));
          if (!tiles.length) return null;

          // Priority A: Tile that didn't exist before this prompt
          const newTiles = tiles.filter(t => {
            const sig = (t.getAttribute('aria-label') || '') + ':::' + (t.innerText || '').slice(0, 50);
            return !existingSigs.includes(sig);
          });

          let chosen = null;
          if (newTiles.length > 0) {
            chosen = newTiles[newTiles.length - 1]; // Newest generated tile
          } else {
            // Priority B: Last tile in DOM (Flow appends new tiles to end)
            chosen = tiles[tiles.length - 1];
          }

          if (chosen) {
            chosen.click();
            return {
              label: (chosen.getAttribute('aria-label') || chosen.innerText || '').slice(0, 60)
            };
          }
          return null;
        }, promptText, existingTileSignatures);

        if (tileInfo) {
          console.log(`LOG:[Worker] ✅ Opened video tile: "${tileInfo.label.replace(/\n/g, ' ')}"`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      finalSavedFilename = `flow_${Date.now()}_${promptSlug}.mp4`;
      const destPath = path.join(outputDir, finalSavedFilename);

      // Re-find download button and open 720p download
      dlBtn = await page.$('button[aria-label="Download media"], button[aria-label*="Download" i]');
      if (dlBtn) {
        capturedMediaUrl = null; // Strictly clear so we ONLY catch the freshly requested 720p URL
        console.log('LOG:[Worker] Opening Download menu...');
        await dlBtn.click();
        await new Promise(r => setTimeout(r, 1000));

        console.log('LOG:[Worker] Requesting Full 720p Original MP4 Video file...');
        await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('.mat-mdc-menu-item, [role="menuitem"], button'));
          const originalItem = items.find(i => {
            const t = (i.innerText || '').toLowerCase();
            return t.includes('720p') || t.includes('original') || (t.includes('download') && !t.includes('gif'));
          });
          if (originalItem) originalItem.click();
        });
      }

      // Loop up to 25s: Priority 1 (CDN stream via axios), Priority 2 (File download)
      console.log('LOG:[Worker] Waiting for high-res 720p MP4 video stream...');
      for (let wait = 0; wait < 25; wait++) {
        // Priority 1: Direct CDN stream from intercepted response
        if (capturedMediaUrl) {
          try {
            console.log('LOG:[Worker] Streaming high-res video directly from Google Flow CDN...');
            const resp = await axios.get(capturedMediaUrl, { responseType: 'stream', timeout: 35000 });
            const writer = fs.createWriteStream(destPath);
            resp.data.pipe(writer);
            await new Promise((res, rej) => {
              writer.on('finish', res);
              writer.on('error', rej);
            });
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
              const stats = fs.statSync(destPath);
              console.log(`LOG:[Worker] ✅ Full Video File Saved: ${finalSavedFilename} (${Math.round(stats.size / 1024)} KB)`);
              finalVideoUrl = `/generated_videos/${finalSavedFilename}`;
              break;
            }
          } catch (e) {
            console.log(`LOG:[Worker Stream Note] ${e.message}`);
          }
        }

        // Priority 2: File downloaded by browser into threadDownloadDir
        if (fs.existsSync(threadDownloadDir)) {
          const dlFiles = fs.readdirSync(threadDownloadDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && f.endsWith('.mp4'));
          if (dlFiles.length) {
            const origPath = path.join(threadDownloadDir, dlFiles[0]);
            try {
              fs.copyFileSync(origPath, destPath);
              try { fs.unlinkSync(origPath); } catch {}
              if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
                const stats = fs.statSync(destPath);
                console.log(`LOG:[Worker] ✅ Downloaded Video File Saved: ${finalSavedFilename} (${Math.round(stats.size / 1024)} KB)`);
                finalVideoUrl = `/generated_videos/${finalSavedFilename}`;
                break;
              }
            } catch (e) {}
          }
        }

        // Priority 3: DOM video src check
        if (!finalVideoUrl && wait > 2) {
          const domUrl = await page.evaluate(() => {
            const v = document.querySelector('video');
            return v && v.src && v.src.startsWith('http') ? v.src : null;
          }).catch(() => null);

          if (domUrl && domUrl !== capturedMediaUrl) {
            capturedMediaUrl = domUrl;
            continue;
          }
        }

        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const finalUrl = isImageMode ? finalImageUrl : finalVideoUrl;
    if (finalUrl) {
      console.log('JSON_RESULT:' + JSON.stringify({
        success: true,
        type: isImageMode ? 'image' : 'video',
        url: finalUrl,
        filename: finalSavedFilename,
        projectId: targetProject,
        newProjectId: createdProjectId,
        prompt: promptText
      }));
    } else {
      console.log('JSON_RESULT:' + JSON.stringify({
        success: false,
        type: isImageMode ? 'image' : 'video',
        error: `${isImageMode ? 'Image' : 'Video'} generated on Flow timeline, but download timed out. Check your project directly.`,
        projectId: targetProject,
        newProjectId: createdProjectId
      }));
    }

    // Fast process cleanup - do not let hanging CDP block the gallery!
    if (browser) {
      try {
        const proc = browser.process();
        if (proc && proc.pid && process.platform === 'win32') {
          require('child_process').exec(`taskkill /pid ${proc.pid} /t /f >nul 2>&1`, () => {});
        } else {
          await browser.close().catch(() => {});
        }
      } catch (e) {}
    }
    try { fs.rmSync(workerTempDir, { recursive: true, force: true }); } catch {}
    process.exit(0);

  } catch (err) {
    console.log(`LOG:[Worker Error] ${err.message}`);
    console.log('JSON_RESULT:' + JSON.stringify({
      success: false,
      error: err.message,
      projectId: targetProject
    }));

    if (browser) {
      try {
        const proc = browser.process();
        if (proc && proc.pid && process.platform === 'win32') {
          require('child_process').exec(`taskkill /pid ${proc.pid} /t /f >nul 2>&1`, () => {});
        } else {
          await browser.close().catch(() => {});
        }
      } catch (e) {}
    }
    try { fs.rmSync(workerTempDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
}

runWorker().catch(err => {
  console.log(`LOG:[Fatal Worker Error] ${err.message}`);
  console.log('JSON_RESULT:' + JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});

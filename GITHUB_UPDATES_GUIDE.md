# 🚀 OmniFlow — GitHub Auto-Update & Releases Guide
*Created by Hammad | Support: 03198662419*

Yeh guide batati hai ke jab aap OmniFlow ka naya version release karein, to GitHub ke zariye tamam users ke paas update ka popup kaise bhejein.

---

### 1️⃣ GitHub Repository Setup (One-Time Setup)
1. Apne GitHub account me aik new repository banayein (e.g. `omniflow-updates`).
2. Is repository me `version.json` file upload kar dein.
3. `version.json` par click karein aur **"Raw"** button dabayein.
   - Aapko aisi link milegi:
     `https://raw.githubusercontent.com/YourUsername/omniflow-updates/main/version.json`
4. Yeh link aapke `server.js` me `DEFAULT_UPDATE_FEED` ke tore par set ho sakti hai.

---

### 2️⃣ Nayi Update Release Karne Ka Tareeqa (Jab bhi new feature aye)

#### Step 1: Nayi Files Ka Zip Banayein
Jo files aapne update ki hain (e.g. `server.js`, `script.js`, `index.html`, `style.css`, `flow_worker.js`) unka aik zip bana lein aur naam rakhein:
👉 **`update.zip`**

#### Step 2: GitHub Par Release Banayein
1. Apni GitHub repository par ja kar **Releases** par click karein -> **Draft a new release**.
2. Tag version likhein: `v1.1.0`
3. Release title: `OmniFlow v1.1.0 Release`
4. Apni banayi hui **`update.zip`** file yahan drop kar dein aur **Publish release** kar dein.
5. `update.zip` par right-click karke **Copy Link Address** karein (e.g. `https://github.com/.../releases/download/v1.1.0/update.zip`).

#### Step 3: `version.json` Update Karein
GitHub par `version.json` file ko edit karein:
```json
{
  "version": "1.1.0",
  "releaseNotes": "• New faster rendering\n• 9:16 Shorts full-screen fix\n• Performance improvements",
  "downloadUrl": "PASTE_YOUR_COPIED_ZIP_LINK_HERE"
}
```
Aur **Commit Changes** kar dein!

---

### 3️⃣ User Ke PC Par Kya Hoga?
- Jaise hi user apna OmniFlow kholega ya topbar me **`🔄 Check for Updates`** icon dabayega, app GitHub se `version.json` check karegi.
- User ke samne **"🚀 New Update Available (v1.1.0)"** ka popup khul jayega with What's New changelog!
- User **"⚡ Update Now"** dabayega to app direct in-place update ho kar automatically restart ho jayegi!

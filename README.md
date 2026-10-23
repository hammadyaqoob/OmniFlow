# 🎬 OmniFlow — Multi-Account Video & Image Generator
*Ultra-fast, multi-threaded Google Flow automation platform with Master Admin Licensing & Free Image Engine.*

---

## ⚡ Key Features
- **Multi-Account Automation:** Concurrent batch generation across multiple Google Flow accounts.
- **Direct 720p CDN Video Streaming:** High-res MP4 extraction in 1-2 seconds.
- **100% Free Unlimited Image Engine:** Powered by Google Flow Nano Banana models (0 credit cost).
- **Master Admin Control Panel (`/admin`):**
  - Instant license key generation (trial, 30 days, 90 days, lifetime).
  - Hardware Lock (HWID) enforcement with 1-click remote reset.
  - Real-time video & image telemetry analytics.
  - Shared Admin Account Pool for free client image generation.
- **Smart Rotation & Quota Management:** Automatically handles 10/10 project limits with automated new project creation.
- **Auto-Update Engine:** In-app updates via GitHub releases.

---

## 🚀 Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start OmniFlow:
   ```bash
   npm start
   ```
   Or double-click `Start-Tool.bat` / run `OmniFlow.exe`.

3. Open Client Tool: `http://localhost:3000`
4. Open Admin Control Panel: `http://localhost:3000/admin` (Default password: `admin`)

---

## 🔒 Security Note
* Sensitive files (`accounts.json`, `licensing_db.json`, `client_license.json`) are automatically excluded via `.gitignore`.

# CoreSense Commercial Release, Signing & Distribution Guide

## 1. Desktop Distribution (Tauri v2 — Windows, macOS, Linux)

Configuration file: `apps/desktop/src-tauri/tauri.conf.json`
Bundle identifier: `com.coresense.desktop` | Version: `1.0.0`

### Windows (.exe NSIS & .msi)
- Build locally: `npm run build:desktop:installer`
- Output directory: `apps/desktop/src-tauri/target/release/bundle/nsis/` and `msi/`
- **Commercial Code Signing (Required before public release):**
  - Acquire an EV Authenticode certificate or Azure Trusted Signing profile.
  - Set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for signed auto-update manifests.
  - Configure `bundle.windows.certificateThumbprint` and `timestampUrl` (`http://timestamp.digicert.com`).
- **Safe Updates & Uninstallation:**
  - User workspace data lives in server sync + OS AppData / browser storage, preserved across installer upgrades.

### macOS (.dmg / .app) & Linux (.AppImage / .deb)
- Build on macOS runner with `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` for Gatekeeper notarization.
- Build on Ubuntu runner with `libwebkit2gtk-4.1-dev` for `.deb` and `.AppImage`.

## 2. Mobile Store Distribution (Capacitor 7 — Android & iOS)

Configuration file: `apps/mobile/capacitor.config.ts`
Bundle ID / Application ID: `com.coresense.mobile` | Version: `1.0.0`

### Android (Google Play Store)
1. `npm --workspace @coresense/mobile run build`
2. `npm --workspace @coresense/mobile run cap:android` (generates native Gradle Android project)
3. Open `apps/mobile/android` in Android Studio, configure Play App Signing keystore (`release.keystore`), set `versionCode` & `versionName`, and build signed `.aab` bundle.
4. Declared permissions: `CAMERA` (hardware photo inspection), `RECORD_AUDIO` (voice copilot & microphone check), `ACCESS_NETWORK_STATE` (connectivity checks).

### iOS (Apple App Store)
1. On macOS with Xcode: `npm --workspace @coresense/mobile run build && npm --workspace @coresense/mobile run cap:ios`
2. Set Apple Developer Team & Provisioning Profile for `com.coresense.mobile`.
3. Provide required `Info.plist` usage descriptions:
   - `NSCameraUsageDescription`: "CoreSense uses the camera to inspect electronic boards, connectors, and error messages."
   - `NSMicrophoneUsageDescription`: "CoreSense uses the microphone for hands-free voice troubleshooting and microphone hardware tests."
   - `NSPhotoLibraryUsageDescription`: "CoreSense accesses selected photos to analyze hardware images and attach them to your personal repair cases."
4. Archive and submit via Xcode Organizer / Transporter.

## 3. External Cloud Credentials Checklist

| Variable | Purpose | Behavior When Unset |
|---|---|---|
| `GEMINI_API_KEY` | Live Gemini 4 multimodal reasoning, board photo vision & `gemini-embedding-2` | CoreSense runs on its built-in **CoreSense Local Diagnostic Engine** (offline-capable, transparently labeled) |
| `OPENAI_API_KEY` | Optional OpenAI or local Ollama (`OPENAI_BASE_URL`) provider | Unused unless configured server-wide or via per-user encrypted BYOK |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | Live commercial subscription billing & verified webhooks | Local sandbox billing mode active for development & testing |
| `JWT_SECRET` & `OWNER_JWT_SECRET` | Separate customer vs owner token signing secrets | Must be rotated to unique 64-byte secrets in production |
| `ENCRYPTION_KEY` | AES-256-GCM encryption for stored BYOK provider keys | Must be stored in secret manager (AWS KMS / Vault / Vercel Env) |

# CoreSense Architecture & Technical Specification

> **"Understand what's happening beneath the surface."**
> Commercial AI-Powered Electronics Diagnostics & Repair Intelligence Platform

## 1. System Topology

CoreSense is architected as a modular monorepo powering three genuinely connected yet properly bounded applications backed by a unified Fastify API with strict dual-database / schema and route-module privacy isolation:

```
┌──────────────────────────────────┐   ┌──────────────────────────────────────┐
│  CoreSense Desktop (Tauri v2)    │   │  CoreSense Mobile (Vite + Capacitor) │
│  Rust Native Diagnostics Core +  │   │  Signed Android APK + Mobile Web PWA │
│  React 19 + Offline Cache + Sync │   │  Phone Checks + Camera + Voice       │
└────────────────┬─────────────────┘   └────────────────┬─────────────────────┘
                 │ HTTPS / JWT (Customer Auth)          │
                 └──────────────────┬───────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CoreSense Backend API (Fastify / TS)                 │
│  ┌────────────────────────────────┐  ┌───────────────────────────────┐  │
│  │  Customer Workspace Plane      │  │  Owner Observability Plane    │  │
│  │  /api/v1/*                     │  │  /owner-api/v1/*              │  │
│  │  - Customer JWT / Supabase Auth│  │  - Separate Owner JWT Secret  │  │
│  │  - AI Copilot & Safety Engine  │  │  - TOTP MFA Support           │  │
│  │  - Hybrid RAG (FTS + Vectors)  │  │  - Privacy-Scrubbed Telemetry │  │
│  │  - Delta Sync Engine           │  │  - AI Token & Cost Ledger     │  │
│  │  - Validated Tool Registry     │  │  - Zero Customer Data Access  │  │
│  └───────────────┬────────────────┘  └───────────────┬───────────────┘  │
└──────────────────┼───────────────────────────────────┼──────────────────┘
                   ▼                                   ▼
   ┌───────────────────────────────┐   ┌───────────────────────────────┐
   │  customer_workspace /         │   │  owner_observability /        │
   │  coresense_customer.db        │   │  coresense_owner.db           │
   │  (Private Customer Data)      │   │  (Aggregate Product Metrics)  │
   │  Users, Devices, Chats, Docs, │   │  Downloads, Activations, DAU, │
   │  Photos, Repair Cases, Sync   │   │  Token/Cost Ledger, Crashes   │
   └───────────────────────────────┘   └───────────────────────────────┘
                                                       ▲
                                                       │ Separate Owner JWT
                                       ┌───────────────┴───────────────┐
                                       │  CoreSense Owner Console      │
                                       │  (Standalone Private Web App) │
                                       └───────────────────────────────┘
```

## 2. Core Engineering Decisions

1. **Native Desktop via Tauri v2 (Rust + React 19)**:
   - Produces lightweight commercial native installers (Windows `.msi`/`.exe` NSIS, macOS `.dmg`, Linux `.AppImage`/`.deb`) using the OS WebView rather than bundling Chromium.
   - Native Rust diagnostics module (`sysinfo` + platform-specific probes) executes strictly enumerated, read-only hardware diagnostics directly on the user's machine with zero arbitrary shell execution, and syncs snapshots to the API via `/api/v1/diagnostics/ingest` or `clientSnapshot`.
   - Includes seamless fallback to the `@coresense/diagnostics-core` local host collector when running a local development API (`ALLOW_HOST_DIAGNOSTICS` is disabled by default in cloud production so remote servers never probe their own container).
2. **Cross-Platform Mobile via React 19 + Vite + Capacitor 7**:
   - Portable repair companion distributed as a cryptographically signed native Android APK (`apps/mobile/android`) and installable Mobile Web PWA (for iOS and any mobile browser).
   - Implements legitimate permitted mobile APIs (battery, network latency/jitter probe, WebGL SoC/GPU profile, active-compute SoC stability benchmark, interactive microphone/speaker/display/touch/camera/motion checks) with transparent OS restriction disclosures.
   - Shares the exact same customer account, device library, manuals, repair cases, and delta sync protocol as Desktop.
3. **Dual-Database / Schema & Route-Module Privacy Boundary**:
   - Private customer content lives exclusively in `coresense_customer.db` (local SQLite) or the `customer_workspace` PostgreSQL schema (`CUSTOMER_DATABASE_URL` supports placing it on an entirely separate database server in production).
   - Product telemetry, AI token/cost ledgers, installer downloads, and scrubbed crash reports live exclusively in `coresense_owner.db` or the `owner_observability` PostgreSQL schema (`OWNER_DATABASE_URL`).
   - Every telemetry write passes through a strict allowlist privacy scrubber that strips emails, prompt text, photos, file paths, and device notes.
   - The Owner Console API (`ownerRoutes.ts`) never imports or receives `customerDb`, has zero SQL access, zero API endpoints, and zero UI views into customer workspaces.
4. **Structured AI Repair Copilot & Safety Architecture**:
   - Multi-provider AI router: Google Gemini (`@google/genai` Interactions API using `gemini-4-hydrogen` / `gemini-4-argon` / `gemini-4-neon` + `gemini-embedding-2`), OpenAI-compatible / Ollama, and a built-in **CoreSense Local Diagnostic Engine** for fully functional offline/no-key operation (always transparently labeled).
   - Enforces evidence separation (User Symptoms, Measured Diagnostics, User Measurements, Visual Observations, Manual Citations), evidence-linked hypotheses without fabricated confidence percentages, hardware safety guardrails (high voltage, mains, PSU capacitors, damaged lithium batteries, soldering), prompt-injection isolation for uploaded manuals, and 5-state before-vs-after Resolution Verification.
5. **Validated Diagnostic Tool Registry**:
   - AI models can only request predefined tool IDs with Zod-validated parameters.
   - Every measurement carries explicit provenance: `measurementType` (`measured` | `user_reported` | `inferred` | `unavailable` | `simulated`), `source`, `os`, `collectedAt`, and `limitations`.
   - State-changing operations require explicit user confirmation with clear risk disclosure.

## 3. Commercial Distribution & External Setup

- **Desktop Installers**: Built with `npm run build:desktop:installer` via Tauri v2 (`apps/desktop/src-tauri/tauri.conf.json`). Ed25519 updater signing (`TAURI_SIGNING_PRIVATE_KEY`) and CI release automation publish signed installers and `latest.json` directly to GitHub Releases.
- **Android APK & Mobile Web PWA**: Built in CI via Vite + Capacitor (`npx cap sync android` + Gradle `assembleRelease` signed with `ANDROID_KEYSTORE_BASE64`) for direct APK distribution, alongside static PWA hosting for iOS and mobile web browsers.
- **External Integrations (Ready, Credential-Gated)**:
  - `GEMINI_API_KEY` — Enables live Gemini 4 multimodal vision, structured tool-calling reasoning, and multimodal embeddings.
  - `OPENAI_API_KEY` (optional) — Enables OpenAI or local Ollama (`OPENAI_BASE_URL`) models.
  - `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `DATABASE_URL` — Enables production Supabase Auth (email confirmation & password recovery) and PostgreSQL storage.

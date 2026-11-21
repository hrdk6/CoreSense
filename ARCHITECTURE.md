# CoreSense Architecture & Technical Specification

> **"Understand what's happening beneath the surface."**
> Commercial AI-Powered Electronics Diagnostics & Repair Intelligence Platform

## 1. System Topology

CoreSense is architected as a modular monorepo powering three genuinely connected yet properly bounded applications backed by a unified API with hard physical privacy isolation:

```
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│  CoreSense Desktop (Tauri v2)    │   │  CoreSense Mobile (Expo / RN)    │
│  Rust Native Diagnostics Core +  │   │  iOS / Android / Web Companion   │
│  React 19 + Offline Cache + Sync │   │  Phone Checks + Camera + Voice   │
└────────────────┬─────────────────┘   └────────────────┬─────────────────┘
                 │ HTTPS / JWT (Customer Auth)          │
                 └──────────────────┬───────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CoreSense Backend API (Fastify / TS)                 │
│  ┌────────────────────────────────┐  ┌───────────────────────────────┐  │
│  │  Customer Workspace Plane      │  │  Owner Observability Plane    │  │
│  │  /api/v1/*                     │  │  /owner-api/v1/*              │  │
│  │  - Customer JWT Secret         │  │  - Separate Owner JWT Secret  │  │
│  │  - AI Copilot & Safety Engine  │  │  - TOTP MFA Support           │  │
│  │  - RAG Manual Indexer (FTS5)   │  │  - Privacy-Scrubbed Telemetry │  │
│  │  - Delta Sync Engine           │  │  - AI Token & Cost Ledger     │  │
│  │  - Validated Tool Registry     │  │  - Zero Customer Data Access  │  │
│  └───────────────┬────────────────┘  └───────────────┬───────────────┘  │
└──────────────────┼───────────────────────────────────┼──────────────────┘
                   ▼                                   ▼
   ┌───────────────────────────────┐   ┌───────────────────────────────┐
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
   - Native Rust diagnostics module (`sysinfo` + platform-specific probes) executes strictly enumerated, read-only hardware diagnostics with zero arbitrary shell execution.
   - Includes seamless fallback to the `@coresense/diagnostics-core` local host collector when running in web preview mode.
2. **Cross-Platform Mobile via Expo / React Native**:
   - Portable repair companion for iOS, Android, and mobile web.
   - Implements legitimate third-party mobile APIs (battery, network latency/reachability, interactive microphone/speaker/display/touch/camera/motion tests) with transparent OS restriction disclosures.
   - Shares the exact same customer account, device library, manuals, repair cases, and delta sync protocol as Desktop.
3. **Dual-Database Privacy Boundary**:
   - Private customer content lives exclusively in `coresense_customer.db` (or separate PostgreSQL database in production).
   - Product telemetry, AI token/cost ledgers, installer downloads, and scrubbed crash reports live exclusively in `coresense_owner.db`.
   - Every telemetry write passes through a strict allowlist privacy scrubber that strips emails, prompt text, photos, file paths, and device notes.
   - The Owner Console has zero SQL access, zero API endpoints, and zero UI views into customer workspaces.
4. **Structured AI Repair Copilot & Safety Architecture**:
   - Multi-provider AI router: Google Gemini (`@google/genai` Interactions API using `gemini-4-hydrogen` / `gemini-4-neon` + `gemini-embedding-2`), OpenAI-compatible / Ollama, and a built-in **CoreSense Local Diagnostic Engine** for fully functional offline/no-key operation (always transparently labeled).
   - Enforces evidence separation (User Symptoms, Measured Diagnostics, User Measurements, Visual Observations, Manual Citations), evidence-linked hypotheses without fabricated confidence percentages, hardware safety guardrails (high voltage, mains, PSU capacitors, damaged lithium batteries, soldering), prompt-injection isolation for uploaded manuals, and 5-state before-vs-after Resolution Verification.
5. **Validated Diagnostic Tool Registry**:
   - AI models can only request predefined tool IDs with Zod-validated parameters.
   - Every measurement carries explicit provenance: `measurementType` (`measured` | `user_reported` | `inferred` | `unavailable` | `simulated`), `source`, `os`, `collectedAt`, and `limitations`.
   - State-changing operations require explicit user confirmation with clear risk disclosure.

## 3. Commercial Distribution & External Setup

- **Desktop Installers**: Built with `npm run build:desktop:installer` via Tauri v2 (`apps/desktop/src-tauri/tauri.conf.json`). Code-signing certificate (`TAURI_SIGNING_PRIVATE_KEY` + Windows EV Authenticode / Apple Developer ID) required for production public release.
- **Mobile Store Packaging**: Configured via `apps/mobile/app.json` and `apps/mobile/eas.json` for EAS Build (`eas build --platform android|ios`). Requires Apple Developer / Google Play Console signing credentials for store submission.
- **External Integrations (Ready, Credential-Gated)**:
  - `GEMINI_API_KEY` — Enables live Gemini 4 multimodal vision, structured tool-calling reasoning, and multimodal embeddings.
  - `OPENAI_API_KEY` (optional) — Enables OpenAI or local Ollama (`OPENAI_BASE_URL`) models.

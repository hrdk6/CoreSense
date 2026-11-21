# CoreSense

> **"Understand what's happening beneath the surface."**
> Commercial AI-powered electronics diagnostics and repair intelligence platform for individual users (Desktop + Mobile) plus a physically isolated Private Owner Observability Console.

## Product Architecture

| Workspace | Purpose | Runtime / Stack | Default Port |
|---|---|---|---|
| `packages/shared` | Domain schemas (Zod), validated Diagnostic Tool Registry, Hardware Safety Policy, Privacy Telemetry Scrubber | TypeScript | Library |
| `packages/diagnostics-core` | Read-only cross-platform OS collectors (CPU, RAM, Storage/SMART, Network/DNS/Wi-Fi, OS Event Logs, Battery) + clearly labeled Simulation Fixtures | TypeScript / OS Native CIM / POSIX | Library |
| `apps/api` | Unified Backend with physically isolated `coresense_customer.db` and `coresense_owner.db`, AI Copilot (Gemini 4 Interactions API / OpenAI / Local Engine), FTS5+Vector RAG, Delta Sync, Billing | Fastify + Node 24 SQLite + `@google/genai` | `http://127.0.0.1:4000` |
| `apps/desktop` | Installable Native Desktop Application with Rust `sysinfo` diagnostic commands, AI Copilot Workbench, Live Diagnostics, Device Library, Manuals, Repair Cases, Offline Cache & Sync | Tauri v2 (Rust) + React 19 + Tailwind v4 + Recharts | `http://127.0.0.1:5173` |
| `apps/mobile` | Portable Repair Companion for iOS, Android & Mobile Web — Permitted Phone Checks (Battery, Network, Mic, Speaker, Display/Touch, Camera, Motion), Camera Board Capture, Voice Copilot & Sync | Capacitor 7 (iOS/Android) + React 19 + Tailwind v4 | `http://127.0.0.1:8081` |
| `apps/owner-console` | Completely separate Private Owner Observability Console — Downloads vs Activations, DAU/WAU/MAU, Retention, Funnel, MRR/ARR, AI Cost Ledger, Crashes, Feedback, Dynamic Plan Editor & TOTP MFA | Standalone React 19 + Tailwind v4 + Recharts | `http://127.0.0.1:5175` |

## Quick Start

1. Copy `.env.example` to `.env` (optional: add `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `STRIPE_SECRET_KEY`; CoreSense works fully offline with its built-in **CoreSense Local Diagnostic Engine** when no external keys are set).
2. Install & build all packages:
   ```bash
   npm install
   npm run build
   ```
3. Run the automated E2E + 17-Scenario AI Diagnostic Evaluation Suite:
   ```bash
   npm test
   ```
4. Launch the connected applications (in separate terminals):
   ```bash
   npm run dev:api       # Backend API on :4000
   npm run dev:desktop   # Desktop App UI on :5173 (or `npm run dev:desktop:tauri` for native window)
   npm run dev:mobile    # Mobile Companion on :8081
   npm run dev:owner     # Private Owner Console on :5175
   ```
5. Build native Windows commercial desktop binary & installer:
   ```bash
   npm run build:desktop:installer
   ```

## Default Local Owner Console Credentials (Change via `.env` in Production)

- **URL:** `http://127.0.0.1:5175`
- **Email:** `owner@coresense.app` (configurable via `OWNER_INITIAL_EMAIL`)
- **Password:** `CoreSenseOwner#2026!` (configurable via `OWNER_INITIAL_PASSWORD`)
- Supports RFC 6238 TOTP Multi-Factor Authentication under **Product Config & MFA**.

## Privacy & Safety Guarantees

- **Zero Arbitrary Shell Execution:** AI models can only request predefined tool IDs from `@coresense/shared`. State-modifying actions (such as `flush_dns_cache`) require explicit per-action user approval.
- **Physical Privacy Isolation:** `coresense_customer.db` and `coresense_owner.db` are physically separate databases. Owner API routes never receive a reference to the customer database, and all telemetry passes through a strict allowlist scrubber.
- **Hardware Safety Gate:** Swollen/damaged lithium batteries, mains/PSU high-voltage capacitors, live liquid damage, and hazardous DIY board rework trigger mandatory safety interventions.
- **Honest Provenance:** Real hardware measurements (`measured`), user manual readings (`user_reported`), OS/platform limitations (`unavailable`), and test fixtures (`simulated`) are strictly separated and never conflated.

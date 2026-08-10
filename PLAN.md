# Door Knocking Notes — Implementation Plan

## 1. Vision

A privacy-first, cross-browser smartphone web app (PWA) for political door knockers.
It records audio of doorstep conversations and transcribes speech to text
**entirely on-device**, with rule-based PII redaction before anything is stored.
**No data ever leaves the device.**

## 2. Hard Constraints (Non-Negotiable)

| Constraint | Rationale |
|---|---|
| 100% local processing | Legal/ethical requirement: no cloud, no analytics, no telemetry |
| Cross-browser (iOS Safari, Android Chrome) | Door knockers use their own phones |
| Runs as a web app (PWA) | No app-store distribution friction; installable to home screen |
| Offline-capable after first load | Canvassing happens in areas with poor signal |
| PII stripped before storage | Only non-identifying transcripts are retained |

## 3. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| App shell | Vanilla TS + Vite | Keep bundle tiny; PWA plugin (`vite-plugin-pwa`) |
| Audio capture | `MediaRecorder` API (`getUserMedia`) | Fallback mime-type negotiation: `audio/webm;codecs=opus` → `audio/mp4` (iOS) |
| Transcription | [whisper-web / transformers.js](https://github.com/xenova/whisper-web) (`@xenova/transformers`) | Whisper `tiny`/`base` quantized ONNX in a Web Worker, WASM backend (WebGPU where available) |
| Storage | IndexedDB (`idb`) | Audio blobs (optional), redacted transcripts |
| PII handling | Rule-based redaction | See §7 |

## 4. Architecture

```mermaid
flowchart LR
    A[Microphone<br/>MediaRecorder] --> B[Audio Buffer<br/>16kHz PCM]
    B --> C[Whisper Worker<br/>transcription]
    C --> D[Transcript]
    D --> E[PII Redaction<br/>rules]
    E --> F[Transcript Store<br/>IndexedDB]
    D -.optional encrypted.-> G[Audio Store<br/>IndexedDB]
```

**Key architectural decisions**

- **Web Workers for heavy work**: Whisper runs in a dedicated worker. Main thread stays responsive for recording UI.
- **Model caching**: The Whisper model (~40–80 MB quantized) is downloaded once, then served from Cache Storage / IndexedDB. First-run requires Wi-Fi; afterwards fully offline.
- **Progressive enhancement**: Detect WebGPU → WASM SIMD → WASM baseline. Degrade model size accordingly and warn the user.
- **No backend**: Static hosting only (GitHub Pages / Netlify). This *is* the security model.

## 5. Feature Breakdown

### 5.1 Session Recording
- Start/stop recording per doorstep visit; sessions grouped into "canvassing runs".
- Chunked recording (e.g. 30 s segments) so a crash loses at most one chunk.
- Lock-screen / background behaviour on mobile is limited — document "keep screen on" guidance; consider Wake Lock API.
- Visual indicator that recording is active (required for two-party-consent jurisdictions).

### 5.2 On-Device Transcription
- Feed recorded chunks to Whisper (16 kHz mono) in a worker.
- Show incremental transcript during/after the session.
- Model picker: `whisper-tiny` (fast, rough) vs `whisper-base` (default) — trade-off shown to user.

### 5.3 PII Stripping (see §7)

### 5.4 Session Review & Export
- List of past sessions with redacted transcript.
- Export redacted transcripts as CSV/JSON; **raw audio exportable only behind an explicit, warned action** (data-controller responsibility).

## 6. Data Model (IndexedDB)

| Store | Contents | PII? |
|---|---|---|
| `sessions` | id, startedAt, duration, status, model versions | No |
| `audioChunks` | sessionId, seq, blob, duration | **Yes** — optional retention, auto-delete after transcription (default) |
| `transcripts` | sessionId, text (post-redaction), createdAt | Should be No — redacted before write |

## 7. Privacy & Security Plan

1. **PII redaction before persistence**
   - Rule-based pass: names ("my name is X"), addresses (house numbers, postcodes), phone numbers, emails via regex/NER-style patterns.
   - Transcript stored only **after** redaction; raw transcript exists in memory only.
2. **Audio retention**: default = delete audio immediately after successful transcription. Toggleable per-org policy.
3. **Data at rest**: IndexedDB is per-origin; document device-encryption/OS-passcode reliance. Optional passphrase encryption (WebCrypto AES-GCM) for stored data.
4. **Consent UX**: recording banner + spoken-consent prompt script displayed to the canvasser.
5. **No network at runtime**: after model caching, assert zero network calls (CSP `connect-src 'self'` + service worker audit).
6. **CSP + permissions**: strict CSP; only `microphone` permission requested.

## 8. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| M1 | Scaffold | Vite + TS + PWA shell, installs offline, mic permission flow |
| M2 | Recording | MediaRecorder sessions, chunking, IndexedDB storage, playback |
| M3 | Transcription | Whisper worker, model download/cache UX, incremental transcript |
| M4 | PII hardening | Redaction pipeline, audio auto-delete, encryption option, CSP lockdown |
| M5 | Polish | CSV export, battery/perf tuning, field testing |

## 9. Testing Strategy

- **Unit**: redaction rules (golden PII corpus).
- **Integration**: record → transcribe pipeline with canned audio fixtures (run headless in Playwright on Chromium + WebKit).
- **Device matrix**: iOS Safari (latest − 1), Android Chrome (latest − 1).
- **Privacy audit**: service-worker network interception test proving zero third-party requests during a full session.

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Background recording killed by OS | Lost audio | Wake Lock + foreground-service-like UX guidance; chunking limits loss |
| Whisper accuracy on doorstep noise | Poor transcripts | `base` model default; optional VAD pre-filter; manual transcript edit UI |
| PII leaks into stored text | Legal breach | Redact-before-write, audit log of redactions, never store raw |
| Legal consent variance by jurisdiction | Compliance issue | In-app consent script + admin-configurable jurisdiction notice |

## 11. Open Questions

- Is audio ever retained (e.g. for dispute resolution), and under what retention window?
- Multi-language support beyond English for transcription?
- Who is the data controller, and what is the deletion workflow if a resident requests it?

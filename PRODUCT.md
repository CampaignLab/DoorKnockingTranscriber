# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Political canvassers (volunteers and campaign staff) knocking on doors in the field, using their own smartphones (iOS Safari, Android Chrome). Their job: capture what was said at each doorstep without typing, then hand the day's notes to their campaign in one message. Often working in areas with poor signal, one-handed, in short bursts between doors.

## Product Purpose

Door Knocking Notes is a privacy-first, fully on-device web app (PWA) that records doorstep conversations and transcribes them locally. The first recording of a day creates a *block*; every start/stop adds a session to it. At the end of the run, the canvasser taps "Finish block & share" to get a formatted list of transcribed conversations (with dates/times), shares it via the native share sheet or clipboard, and the block is wiped from the device. Success means a canvasser captures a whole day's conversations with near-zero friction and zero data exposure.

## Positioning

Two claims a neighboring product could not truthfully copy:

1. **100% on-device processing** — no backend, no accounts, no analytics; audio never leaves memory, transcripts are PII-redacted before storage, and everything is deleted after a successful share.
2. **Radical workflow simplicity** — one-tap record → automatic block grouping → single share → automatic wipe. No app store, no setup beyond a one-time model download.

## Operating Context

- Used outdoors, on foot, on personal phones, frequently with poor or no connectivity (must work offline after first model download).
- Recording happens at the doorstep during live conversations; screen-on time and battery matter.
- Legal context: two-party-consent jurisdictions require a visible recording indicator; an in-app consent script supports the canvasser.
- Canvassers act under an organization that is the data controller; the app's redact-before-store and wipe-after-share model minimizes the controller's exposure.

## Capabilities and Constraints

**Confirmed functionality:**
- Audio recording via `MediaRecorder`/`getUserMedia` with cross-browser mime-type fallback (`audio/webm;codecs=opus` → `audio/mp4` on iOS).
- On-device transcription with Whisper (transformers.js, quantized ONNX in a Web Worker; WASM with WebGPU where available). Model (~40–80 MB) downloads once, then cached; fully offline afterward.
- Rule-based PII redaction (names, addresses, phone numbers, postcodes, emails) applied **before** anything is persisted; raw transcripts exist in memory only.
- Session/block model in IndexedDB (`idb`): sessions grouped into blocks; sessions viewable and individually deletable mid-block.
- Share via Web Share API with clipboard fallback; block and all sessions deleted from the device after a successful share.
- PWA: installable to home screen, offline after initial setup, static hosting (GitHub Pages), no server.

**Hard constraints (non-negotiable):**
- No cloud, no analytics, no telemetry, no network calls after the model is cached (CSP `connect-src 'self'`).
- Cross-browser on iOS Safari and Android Chrome.
- Only the `microphone` permission is requested.

**Decided product facts:**
- Audio is never retained — discarded in memory after transcription; not a toggle.
- Transcription targets English only for now; multi-language is undecided.

**Open decisions:**
- Who the data controller is in each deployment and the deletion workflow if a resident requests it.

## Brand Commitments

- Name: **Door Knocking Notes**.
- Voice: direct, plain-spoken, privacy-forward; the onboarding screen explains the privacy model in plain language.

## Evidence on Hand

- [README.md](README.md) — product description, features, tech stack, usage flows.
- [PLAN.md](PLAN.md) — vision, hard constraints, architecture, privacy/security plan, milestones, risks.
- Working implementation in [src/](src/main.ts): recording, Whisper worker transcription, redaction pipeline, IndexedDB storage, and the onboarding/record/sessions/share/detail views.
- No testimonials, customer logos, benchmarks, or press — future work must not fabricate any.

## Product Principles

1. **Privacy is the product, not a policy.** Every feature decision is subordinate to "nothing leaves the device"; when in doubt, collect less.
2. **Field-speed over feature depth.** The canvasser is standing on a doorstep; every core action must be one-handed, one-tap, and forgiving of interruption.
3. **Offline is the default, not a fallback.** Canvassing happens where signal dies; the app must be fully functional without a network.
4. **The device is the only database.** Storage is per-origin IndexedDB, redacted before write, and wiped after share; retention is a bug, not a feature.
5. **No friction to adopt.** No accounts, no app store, no backend — open a URL, install, download the model once, knock.

## Accessibility & Inclusion

- Used one-handed on phones outdoors: large touch targets, high-contrast recording state, and a clear active-recording indicator (a legal requirement in two-party-consent jurisdictions, not just an affordance).

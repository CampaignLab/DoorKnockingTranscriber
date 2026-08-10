# Door Knocking Notes

A **privacy-first, fully on-device web app** for door knockers to record conversations and transcribe them locally — then share the day's notes as one message. Nothing is ever sent to the cloud by the app itself.

## Features

🎙️ **Record & Transcribe**
- Record audio of doorstep conversations on any smartphone (iOS Safari, Android Chrome)
- Transcribe speech to text entirely on-device using Whisper Base (~80 MB, downloads once)
- Works offline after the first model download

🗂️ **Session Blocks**
- The first recording creates a *block*; every start/stop adds a session to it
- Each session is transcribed individually
- Tap **Finish block & share** to see a nicely formatted list of every transcribed conversation with its date and time

📤 **Share & Wipe**
- Share to any app via the native share sheet (WhatsApp, Notes, email, …) — or copy to the clipboard
- After a successful share, the block and all of its sessions are **deleted from the device**

🛡️ **Privacy & Security**
- ✅ **100% on-device processing** — no audio or transcripts ever leave your device via the app
- ✅ **Automatic PII redaction** — names, addresses, phone numbers, postcodes are stripped before anything is stored
- ✅ **No audio retention** — audio is discarded in memory after transcription
- ✅ **No backend, no accounts, no analytics**

📱 **Progressive Web App (PWA)**
- Install to home screen like a native app
- Works offline after initial setup
- No app store friction

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| **Frontend** | TypeScript + Vite | Fast dev experience, tiny bundle |
| **Recording** | `MediaRecorder` API + `getUserMedia` | Cross-browser audio capture |
| **Transcription** | [whisper-web](https://github.com/xenova/whisper-web) / `@xenova/transformers` | Whisper Base, WASM + WebGPU |
| **Storage** | IndexedDB (`idb`) | On-device blocks, sessions & transcripts |
| **Sharing** | Web Share API | Native share sheet; clipboard fallback |
| **Hosting** | Static (GitHub Pages) | No server at all |

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Development

```bash
npm install
npm run dev
```

Opens https://localhost:5173 with HTTPS (required for microphone access on phones).

### Build for Production

```bash
npm run build
npm run preview
```

Output in `dist/` ready for static hosting. Pushes to `main` deploy automatically via GitHub Pages.

## Architecture

```
┌────────────────────────────────────────┐
│ Smartphone Browser (iOS Safari /       │
│ Android Chrome)                        │
├────────────────────────────────────────┤
│ PWA Frontend                           │
│ ┌──────────────────────────────────┐   │
│ │ Microphone → Audio Recording     │   │
│ └──────────────────────────────────┘   │
│ ┌──────────────────────────────────┐   │
│ │ Whisper Worker → Transcription   │   │
│ │ (Runs in Web Worker, keeps UI    │   │
│ │  responsive)                     │   │
│ └──────────────────────────────────┘   │
│ ┌──────────────────────────────────┐   │
│ │ PII Redaction (rules)            │   │
│ └──────────────────────────────────┘   │
│ ┌──────────────────────────────────┐   │
│ │ IndexedDB → Blocks, Sessions,    │   │
│ │ Redacted Transcripts             │   │
│ └──────────────────────────────────┘   │
│ ┌──────────────────────────────────┐   │
│ │ Web Share API → formatted notes  │   │
│ │ then delete block locally        │   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
         (no backend, no network calls
          after the model is cached)
```

## Usage

### First run
1. Welcome screen explains the privacy model
2. Download the Whisper transcription model (~80 MB) — required, happens once

### A day of door knocking
1. Tap **● Record** at the first door — this creates a session block
2. Stop when the conversation ends; the session is transcribed and saved
3. Repeat at each door — every recording joins the current block
4. When finished, tap **Finish block & share**
5. Review the formatted notes, then share to any app (or copy)
6. After sharing, everything is deleted from the device automatically

### Reviewing mid-block
- The **Sessions** view lists recorded sessions with timestamps
- Tap one to see its redacted transcript or delete it individually

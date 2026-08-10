# Door Knocking Notes

A **privacy-first, fully on-device web app** for political door knockers to record conversations, transcribe them locally, and extract structured insights—all without sending any data to the cloud.

## Features

🎙️ **Record & Transcribe**
- Record audio of doorstep conversations on any smartphone (iOS Safari, Android Chrome)
- Transcribe speech to text entirely on-device using Whisper (tiny/base models)
- Works offline after first model download

🧠 **Extract Insights**
- Local LLM (Llama 3.2 3B) identifies:
  - Party support (labour, conservative, lib dem, green, reform, SNP, Plaid Cymru, other, undecided)
  - Voter sentiment (supportive, leaning, undecided, hostile, not home)
  - Key issues mentioned (NHS, cost of living, housing, etc.)
  - Follow-up requests
- **Zero cloud processing**—models run directly on your device via WebGPU

🛡️ **Privacy & Security**
- ✅ **100% on-device processing** — no audio, transcripts, or insights ever leave your device
- ✅ **Automatic PII redaction** — names, addresses, phone numbers, postcodes are stripped before analysis
- ✅ **Optional audio retention** — audio deleted immediately after transcription by default
- ✅ **End-to-end transparent** — you control all data

📧 **Summary Notifications** (Optional)
- Receive email summaries when new insights are created
- Powered by Resend for reliable delivery
- Only the insight summary is sent to your backend—never raw audio or transcripts

📱 **Progressive Web App (PWA)**
- Install to home screen like a native app
- Works offline after initial setup
- No app store friction

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| **Frontend** | TypeScript + Vite | Fast dev experience, tiny bundle |
| **Recording** | `MediaRecorder` API + `getUserMedia` | Cross-browser audio capture |
| **Transcription** | [whisper-web](https://github.com/xenova/whisper-web) / `@xenova/transformers` | Whisper tiny/base, WASM + WebGPU |
| **LLM** | [WebLLM](https://github.com/mlc-ai/web-llm) | Llama 3.2 3B, WASM/WebGPU |
| **Storage** | IndexedDB | On-device session & insight persistence |
| **Backend** (Optional) | Node.js + Express | Email notifications via Resend |
| **Hosting** | Static (GitHub Pages, Netlify, Vercel) | Backend can run on Heroku, Railway, Render, etc. |

## Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn

### 1. Development

```bash
npm install
npm run dev
```

Opens https://localhost:5173 with HTTPS (required for microphone access on phones).

### 2. Setup Email Notifications (Optional)

See [QUICKSTART_EMAIL.md](QUICKSTART_EMAIL.md) for a 5-minute setup.

```bash
cd backend
npm install
cp .env.example .env
# Add your Resend API key
npm run dev
```

### 3. Build for Production

```bash
npm run build
npm preview
```

Output in `dist/` ready for static hosting.

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
│ │ PII Redaction (regex + LLM)      │   │
│ └──────────────────────────────────┘   │
│ ┌──────────────────────────────────┐   │
│ │ WebLLM → Insight Extraction      │   │
│ │ (Llama 3.2 3B, strict JSON)      │   │
│ └──────────────────────────────────┘   │
│ ┌──────────────────────────────────┐   │
│ │ IndexedDB → Persist Insights     │   │
│ │ (Audio deleted by default)       │   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
                    ↓ (optional)
            POST /api/notify-summary
                    ↓
┌────────────────────────────────────────┐
│ Backend Server (Node.js + Express)     │
│ ┌──────────────────────────────────┐   │
│ │ Receive Insight + Email Address  │   │
│ │ Format HTML Email Template       │   │
│ │ Call Resend API                  │   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
```

## Usage

### Onboarding
1. Welcome screen explains the app's privacy model
2. Download Whisper model (~80 MB) — required for recording
3. Optionally download Llama 3.2 3B (~2 GB) for insights
4. Enter your campaign email and notification email (optional)

### Recording a Session
1. Tap **● Record**
2. Record the conversation (visual indicator shows recording is active)
3. Tap **Stop** when done
4. App automatically:
   - Transcribes audio (live progress)
   - Redacts PII (shows redaction count)
   - Extracts structured insights
   - Sends summary email (if configured)
   - Deletes audio (by default)

### Viewing Results
- **Sessions** view lists all past recordings with timestamps
- **Session Details** shows transcript, extracted insights, and options to:
  - Edit notes
  - Delete session
  - Export as JSON/CSV

### Settings
- **Setup** screen allows:
  - Campaign email management
  - Notification email configuration
  - Model reloading / cache status
  - Storage details

## Data Model (IndexedDB)

| Store | Contents | Retention | PII? |
|---|---|---|---|
| `sessions` | Session metadata (duration, status, timestamps) | Permanent | No |
| `transcripts` | Redacted text only | Permanent | No |
| `insights` | Extracted JSON (party, sentiment, issues) | Permanent | No |
| `audioChunks` | Raw audio blobs | **Deleted after transcription** (configurable) | Yes |
| `settings` | Campaign email, notification email, LLM enabled | Permanent | Depends on user |

## Privacy & Security

### Data Never Leaves Your Device
- Recording, transcription, and LLM extraction all run in your browser
- Models (~80 MB Whisper + ~2 GB Llama) are cached locally after first download
- IndexedDB stores all data per-origin, scoped to your device

### PII Stripping (Defense in Depth)
1. **Rule-based redaction** (regex/pattern matching):
   - Names ("my name is X")
   - Addresses (house numbers, postcodes)
   - Phone numbers
   - Email addresses
2. **LLM-constrained extraction**:
   - Prompt instructs model to ignore PII
   - Output schema contains no PII fields
   - Only non-identifying insights are captured

### Secure Defaults
- Audio **not** retained by default (delete after transcription)
- Transcripts stored **only after** redaction
- Optional passphrase encryption via WebCrypto AES-GCM (future)

### Email Notifications
- Only the final insight summary is sent to your backend
- Raw audio and transcripts **never** leave the device
- Backend has no access to PII or raw transcripts

## Testing

```bash
npm run test          # Run test suite once
npm run test:watch   # Watch mode
```

## Building & Deployment

### Frontend (Static)
```bash
npm run build
# Upload `dist/` to GitHub Pages, Netlify, Vercel, etc.
```

### Backend (Optional Email Service)
```bash
cd backend
npm run build
npm start
# Deploy to Heroku, Railway, Render, Fly.io, etc.
# Set environment variables:
#   RESEND_API_KEY=your_api_key
#   RESEND_FROM_EMAIL=noreply@domain.com
#   PORT=3001
```

See [EMAIL_SETUP.md](EMAIL_SETUP.md) for full backend deployment instructions.

## Development

### Project Structure
```
.
├── src/
│   ├── main.ts                    # App entry point
│   ├── pipeline.ts                # Orchestration (record → transcribe → extract)
│   ├── audio/
│   │   └── recorder.ts            # MediaRecorder wrapper + mono16k conversion
│   ├── transcription/
│   │   ├── transcriber.ts         # Whisper worker interface
│   │   ├── whisper.worker.ts      # Web Worker for transcription
│   │   └── transcription-protocol.ts
│   ├── llm/
│   │   └── extractor.ts           # WebLLM insight extraction
│   ├── privacy/
│   │   └── redact.ts              # PII redaction rules
│   ├── storage/
│   │   └── db.ts                  # IndexedDB schema + operations
│   ├── email/
│   │   └── notify.ts              # Email notification client
│   ├── ui/
│   │   ├── app.ts                 # App shell + routing
│   │   ├── record-view.ts         # Recording UI
│   │   ├── sessions-view.ts       # Session list
│   │   ├── session-detail-view.ts # Session details + insights
│   │   ├── setup-view.ts          # Settings & model management
│   │   └── onboarding-view.ts     # First-run setup
│   ├── styles.css                 # Global styles
│   └── vite-env.d.ts
├── backend/
│   ├── server.ts                  # Express API for email notifications
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── tests/
│   └── redact.test.ts             # PII redaction tests
├── public/
│   └── icons/                     # PWA icons
├── index.html
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
└── package.json
```

### Key Design Decisions

1. **Web Workers for Heavy Lifting**: Whisper runs in a dedicated worker; WebLLM has its own thread. Main thread stays responsive for recording UI.
2. **Progressive Enhancement**: Detect WebGPU → WASM SIMD → WASM fallback. Graceful degradation if features unavailable.
3. **Model Caching**: Cache Storage + IndexedDB for fast second loads. First run requires Wi-Fi.
4. **Strict JSON Output from LLM**: Uses JSON schema guidance to ensure parseable output.
5. **No Backend Required**: App is fully functional without email notifications. Backend is optional.

## FAQ

**Q: Can I use this on desktop?**  
A: Yes, it's a web app. Works on any browser with MediaRecorder + WebGPU/WASM.

**Q: How large are the models?**  
A: Whisper tiny/base ~40–80 MB. Llama 3.2 3B ~2 GB. Downloaded once, cached thereafter.

**Q: Does this work offline?**  
A: Yes, after initial setup. Models are cached; all processing is on-device.

**Q: Can I delete my data?**  
A: Yes. Delete sessions in the app, and all associated data (transcript, insights) is removed. Audio is already gone by default.

**Q: Is this GDPR compliant?**  
A: It doesn't send data to the cloud, so GDPR obligations are minimal. You're the data controller of your own device. Consult legal advice for your jurisdiction.

## Contributing

Contributions welcome! Areas for improvement:
- [ ] Passphrase encryption for stored data
- [ ] Export/import sessions
- [ ] Custom LLM model selection
- [ ] Batch processing multiple recordings
- [ ] Multilingual transcription support
- [ ] Audio waveform visualization
- [ ] Session tagging/filtering

## License

MIT

## Support

- **Issues**: File on GitHub
- **Email Setup**: See [EMAIL_SETUP.md](EMAIL_SETUP.md)
- **Quick Start**: See [QUICKSTART_EMAIL.md](QUICKSTART_EMAIL.md)
- **Architecture**: See [PLAN.md](PLAN.md)
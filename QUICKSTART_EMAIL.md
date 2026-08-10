# Quick Start: Email Notifications

This is a quick guide to get email notifications working. For detailed information, see [EMAIL_SETUP.md](EMAIL_SETUP.md).

## TL;DR Setup (5 minutes)

### 1. Get Resend API Key
- Go to https://resend.com (free)
- Sign up and get your API key

### 2. Set Up Backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env and add your Resend API key
npm run dev
```

### 3. Run Frontend
In a new terminal:
```bash
npm run dev
```

### 4. Configure Email
1. Open http://localhost:5173 (or whatever Vite shows)
2. Go through onboarding
3. When asked, enter your email to receive summaries
4. Or update it later in Settings ⚙

### 5. Test It
1. Record a short session (say a few sentences)
2. End the session
3. Wait for transcription and analysis (~10 seconds)
4. Check your email!

## Architecture

```
┌─────────────────────────────────────────┐
│ Frontend (on-device)                    │
│ • Record audio                          │
│ • Transcribe (Whisper)                  │
│ • Extract insights (Llama)              │
│ • Strip PII                             │
└────────────┬────────────────────────────┘
             │
             │ POST /api/notify-summary
             │ {insight, recipient_email}
             │
┌────────────▼────────────────────────────┐
│ Backend (Node.js + Express)             │
│ • Receive insight + email               │
│ • Format HTML email                     │
│ • Call Resend API                       │
└────────────┬────────────────────────────┘
             │
             │ API call
             │
┌────────────▼────────────────────────────┐
│ Resend (Email Service)                  │
│ • Send email to recipient               │
└─────────────────────────────────────────┘
```

## Key Files

- **Frontend**: `src/email/notify.ts` - Email client
- **Backend**: `backend/server.ts` - Express API
- **Setup**: `src/ui/onboarding-view.ts` - Email capture
- **Settings**: `src/ui/setup-view.ts` - Email management

## Troubleshooting

**Email not received?**
- Check backend logs for errors
- Verify Resend API key is valid
- Check spam folder
- Ensure domain is verified in Resend

**"Backend not responding"?**
- Make sure backend is running: `npm run dev` in `/backend`
- Check it's on port 3001: `curl http://localhost:3001/health`
- Frontend should proxy `/api` to it automatically

**TypeScript errors?**
- Run: `npm run build` (already confirmed working)
- All dependencies are installed

## Environment Variables

### Frontend
- Uses backend at `http://localhost:3001/api/notify-summary` (dev)
- For production, update `sendSummaryNotification()` call in `src/ui/app.ts`

### Backend
```env
RESEND_API_KEY=re_xxx...
RESEND_FROM_EMAIL=noreply@domain.com
PORT=3001
```

## Files Changed

**Frontend:**
- `src/email/notify.ts` (new)
- `src/storage/db.ts` (added notificationEmail setting)
- `src/ui/app.ts` (added onInsight event handler)
- `src/ui/onboarding-view.ts` (added email input)
- `src/ui/setup-view.ts` (added settings UI)
- `vite.config.ts` (added API proxy)
- `package.json` (added resend dep)

**Backend:**
- `backend/server.ts` (new)
- `backend/package.json` (new)
- `backend/tsconfig.json` (new)
- `backend/.env.example` (new)
- `backend/README.md` (new)

**Documentation:**
- `EMAIL_SETUP.md` (new)
- `.gitignore` (added backend env)

## Next Steps

1. Customize email template in `backend/server.ts` if desired
2. Deploy frontend to production hosting
3. Deploy backend to Node.js hosting (Heroku, Railway, etc.)
4. Update API endpoint for production deployment
5. Monitor delivery in Resend dashboard

See [EMAIL_SETUP.md](EMAIL_SETUP.md) for full documentation.

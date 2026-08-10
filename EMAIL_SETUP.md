# Email Notifications Setup Guide

This guide walks you through setting up automatic email notifications when new summaries are added to your Door Knocking Notes app.

## Overview

When you finish recording a session, the app:
1. Transcribes the audio (on your device)
2. Extracts structured insights (party support, key issues, sentiment)
3. **Sends an email summary** to your registered email address
4. Deletes the audio (by default)

**All processing happens on-device.** Only the summary email is sent to your server.

## Prerequisites

- A running instance of the backend server (see [backend/README.md](backend/README.md))
- A Resend account (free at [resend.com](https://resend.com))
- A verified domain in Resend

## Setup Steps

### Step 1: Set Up the Backend

The backend service handles sending emails securely using the Resend API.

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your Resend API key and domain
npm run dev
```

See [backend/README.md](backend/README.md) for detailed instructions.

### Step 2: Configure the Frontend

When you first open the app, onboarding will ask for two email addresses:

1. **Campaign Email** (required): The email of the councillor/MP you're campaigning for. This helps organize your data.
2. **Notification Email** (optional): Your email address where summaries will be sent.

You can also update the notification email later in Settings.

### Step 3: Test It Out

1. Start a recording session
2. Speak a few sentences (e.g., "I support your healthcare plan, especially on the NHS")
3. End the session
4. Wait for transcription and analysis (a few seconds)
5. Check your email for the summary

## Email Content

The summary email includes:

- **Party Support**: Which party the person supports (or undecided)
- **Sentiment**: Their attitude (supportive, leaning, undecided, hostile, etc.)
- **Key Issues**: Topics they mentioned (NHS, cost of living, housing, etc.)
- **Follow-up**: Whether they requested follow-up contact
- **Notes**: A short, non-identifying summary from the LLM

Example:

```
📋 New Summary Available
Session ended: Aug 10, 2024, 3:45 PM

Party Support: Labour

Sentiment: ✅ Supportive

Key Issues:
  • nhs
  • cost_of_living

Follow-up: ✓ Follow-up requested

Notes: Expressed strong support for NHS funding increase...
```

## Disabling Email Notifications

To disable email summaries:

1. Go to Settings
2. Clear the notification email field
3. Save

Notifications will stop being sent, but you can re-enable them at any time.

## Troubleshooting

**Email not arriving:**
- Check spam/junk folder
- Verify the notification email is correct in Settings
- Check backend logs: `npm run dev`
- Ensure backend server is running: `curl http://localhost:3001/health`

**Backend not running:**
```bash
cd backend
npm run dev
```

**Resend API error:**
- Check your RESEND_API_KEY is correct
- Verify your domain is approved in Resend dashboard
- Check Resend logs at https://resend.com/logs

**CORS errors in console:**
- Make sure the frontend is calling the correct backend URL
- By default, it tries `/api/notify-summary` (same origin)
- For development on different ports, update the API endpoint in app.ts

## Deployment

When you deploy the app:

1. Deploy the frontend to your hosting (GitHub Pages, Netlify, Vercel, etc.)
2. Deploy the backend to a Node.js hosting (Heroku, Railway, Render, etc.)
3. Update the API endpoint in the frontend if the backend is on a different domain
4. Set environment variables on your backend hosting (RESEND_API_KEY, RESEND_FROM_EMAIL, PORT)

## Privacy & Security

- **On-device processing**: Recording, transcription, and extraction all happen on your device. No audio or transcripts leave your device.
- **Email only**: Only the final summary (no audio, no PII) is sent to your backend.
- **PII stripped**: Before extraction, names, addresses, phone numbers, and postcodes are removed.
- **Secure API**: The backend uses HTTPS and validates all requests.

## Support

For issues with:
- **Resend emails**: Visit https://resend.com/support
- **Backend**: See [backend/README.md](backend/README.md)
- **App**: File an issue on GitHub

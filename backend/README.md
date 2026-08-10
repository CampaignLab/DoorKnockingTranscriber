# Door Knocking Notes Backend — Email Notifications

This backend service handles sending summary notifications via Resend whenever new insights are extracted from door knocking sessions.

## Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the backend directory (copy from `.env.example`):

```bash
cp .env.example .env
```

Then edit `.env` with your configuration:

```env
RESEND_API_KEY=your_api_key_from_resend
RESEND_FROM_EMAIL=noreply@yourdomain.com
PORT=3001
```

### 3. Get a Resend API Key

1. Visit [resend.com](https://resend.com)
2. Sign up for a free account
3. Navigate to **API Keys** section
4. Create a new API key and copy it to `RESEND_API_KEY` in `.env`

### 4. Verify Your Domain

You need to verify your sending domain in Resend:

1. Go to **Domains** in your Resend dashboard
2. Add your domain and follow the verification steps
3. Update `RESEND_FROM_EMAIL` in `.env` to use your verified domain (e.g., `noreply@yourdomain.com`)

For development/testing, you can use `noreply@doorknockingnotes.local` as a placeholder, but Resend will need a verified domain for production.

## Running the Server

### Development

```bash
npm run dev
```

The server will start on `http://localhost:3001` and watch for file changes.

### Production

```bash
npm run build
npm start
```

## API Endpoint

### POST `/api/notify-summary`

Send a summary notification email when a new insight is created.

**Request body:**

```json
{
  "recipientEmail": "user@example.com",
  "sessionId": "session-uuid",
  "session": {
    "id": "session-uuid",
    "startedAt": 1692374400000,
    "endedAt": 1692374460000,
    "durationMs": 60000,
    "status": "analysed",
    "whisperModel": "tiny",
    "llmModel": "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    "createdAt": 1692374401000
  },
  "insight": {
    "party_support": "labour",
    "key_issues": ["nhs", "cost_of_living"],
    "sentiment": "supportive",
    "follow_up_requested": false,
    "notes": "Supportive of housing policy"
  },
  "transcriptSummary": "The resident expressed support for the party's position on..."
}
```

**Response:**

```json
{
  "success": true,
  "messageId": "email-id-from-resend"
}
```

**Error response:**

```json
{
  "error": "Failed to send email",
  "details": "Error message from Resend API"
}
```

## Health Check

GET `/health` returns:

```json
{
  "status": "ok"
}
```

## Email Template

The email includes:

- Session summary with party support and sentiment
- Key issues identified
- Notes from the LLM extraction
- Session duration
- Privacy notice (data processed on-device, no cloud)

## Integration with Frontend

The frontend sends a POST request to this endpoint when a new insight is created. The endpoint URL can be configured in the app (defaults to `/api/notify-summary`).

For development, update the API endpoint in the frontend when calling `sendSummaryNotification()`:

```typescript
await sendSummaryNotification(payload, 'http://localhost:3001/api/notify-summary');
```

## Deployment

### Netlify Functions

For serverless deployment on Netlify:

1. Move `backend/server.ts` to `netlify/functions/notify-summary.ts`
2. Update the handler to work with Netlify's function format
3. Set environment variables in Netlify dashboard

### Heroku / Railway / Other Platforms

The service can be deployed to any Node.js hosting:

```bash
npm run build
npm start
```

Make sure to set the environment variables on your hosting platform.

## Troubleshooting

**Email not sending:**
- Check that `RESEND_API_KEY` is correctly set
- Verify your domain is approved in Resend
- Check Resend dashboard for delivery status

**CORS errors:**
- Ensure the frontend and backend are on the same origin or CORS is configured
- CORS is enabled by default for all origins; restrict as needed in production

**Port already in use:**
- Change `PORT` environment variable to a different port
- Or kill the process using the port: `lsof -ti:3001 | xargs kill`

import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';
import type { Insight } from '../src/llm/extractor';
import type { SessionRecord } from '../src/storage/db';

const app = express();
const port = process.env.PORT || 3001;
const resendApiKey = process.env.RESEND_API_KEY;

if (!resendApiKey) {
  console.error('RESEND_API_KEY environment variable is not set');
  process.exit(1);
}

const resend = new Resend(resendApiKey);

app.use(cors());
app.use(express.json());

interface NotificationRequest {
  recipientEmail: string;
  sessionId: string;
  session: SessionRecord;
  insight: Insight;
  transcriptSummary?: string;
}

/**
 * Generate an HTML email template for the summary notification
 */
function generateEmailHTML(
  recipientEmail: string,
  session: SessionRecord,
  insight: Insight,
  transcriptSummary?: string,
): string {
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const partyLabel = insight.party_support
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const sentimentEmoji: Record<string, string> = {
    supportive: '✅',
    leaning: '🤔',
    undecided: '❓',
    hostile: '❌',
    not_home: '🚪',
    not_stated: '-',
  };

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; }
      .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
      .header { border-bottom: 2px solid #0066cc; padding-bottom: 15px; margin-bottom: 20px; }
      h1 { color: #0066cc; font-size: 24px; margin: 0; }
      .timestamp { color: #666; font-size: 12px; margin-top: 5px; }
      .insight-box { background: #f9f9f9; border-left: 4px solid #0066cc; padding: 15px; margin: 15px 0; }
      .insight-label { color: #666; font-size: 12px; text-transform: uppercase; font-weight: bold; }
      .insight-value { font-size: 16px; color: #333; margin-top: 5px; }
      .issues-list { list-style: none; padding-left: 0; }
      .issues-list li { display: inline-block; background: #e8f0ff; color: #0066cc; padding: 5px 10px; margin: 3px 3px 3px 0; border-radius: 4px; font-size: 12px; }
      .summary-box { background: #fff9e6; border-left: 4px solid #ffa500; padding: 15px; margin: 15px 0; }
      .footer { color: #999; font-size: 12px; margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>📋 New Summary Available</h1>
        <div class="timestamp">Session ended: ${formatDate(session.endedAt || Date.now())}</div>
      </div>

      <div class="insight-box">
        <div class="insight-label">Party Support</div>
        <div class="insight-value">${sentimentEmoji[insight.sentiment] || ''} ${partyLabel}</div>
      </div>

      <div class="insight-box">
        <div class="insight-label">Sentiment</div>
        <div class="insight-value">${sentimentEmoji[insight.sentiment] || '-'} ${insight.sentiment.replace(/_/g, ' ').charAt(0).toUpperCase() + insight.sentiment.replace(/_/g, ' ').slice(1)}</div>
      </div>

      ${insight.key_issues.length > 0 ? `
      <div class="insight-box">
        <div class="insight-label">Key Issues</div>
        <ul class="issues-list">
          ${insight.key_issues.map((issue) => `<li>${issue}</li>`).join('')}
        </ul>
      </div>
      ` : ''}

      ${insight.follow_up_requested ? `
      <div class="insight-box" style="border-left-color: #ffa500; background: #fff9e6;">
        <div class="insight-label">Follow-up</div>
        <div class="insight-value">✓ Follow-up requested</div>
      </div>
      ` : ''}

      ${insight.notes ? `
      <div class="summary-box">
        <div class="insight-label">Notes</div>
        <div class="insight-value">${insight.notes}</div>
      </div>
      ` : ''}

      ${transcriptSummary ? `
      <div class="summary-box">
        <div class="insight-label">Transcript Summary</div>
        <div class="insight-value">${transcriptSummary}</div>
      </div>
      ` : ''}

      <div class="footer">
        <p>This is an automated notification from Door Knocking Notes. This session was processed entirely on your device and PII has been automatically removed before analysis.</p>
        <p><strong>Session Duration:</strong> ${(session.durationMs / 1000 / 60).toFixed(1)} minutes</p>
      </div>
    </div>
  </body>
</html>
  `.trim();
}

/**
 * POST /api/notify-summary
 * Send a summary notification email
 */
app.post('/api/notify-summary', async (req, res) => {
  const payload = req.body as NotificationRequest;

  if (!payload.recipientEmail || !payload.session || !payload.insight) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const html = generateEmailHTML(
      payload.recipientEmail,
      payload.session,
      payload.insight,
      payload.transcriptSummary,
    );

    const result = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'noreply@doorknockingnotes.local',
      to: payload.recipientEmail,
      subject: `📋 Door Knocking Notes: New Summary – ${payload.insight.party_support.replace(/_/g, ' ')}`,
      html,
    });

    if (result.error) {
      console.error('Resend API error:', result.error);
      return res.status(500).json({
        error: 'Failed to send email',
        details: result.error.message,
      });
    }

    res.json({
      success: true,
      messageId: result.data?.id,
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`📧 Email notification server running on port ${port}`);
  console.log(`   API endpoint: http://localhost:${port}/api/notify-summary`);
});

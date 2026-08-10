/**
 * Email notification client.
 *
 * Sends summary notifications to the registered email address when new
 * insights are created. This calls a backend API that uses Resend for
 * secure email delivery.
 */

import type { Insight } from '../llm/extractor';
import type { SessionRecord } from '../storage/db';

export interface EmailNotificationPayload {
  recipientEmail: string;
  sessionId: string;
  session: SessionRecord;
  insight: Insight;
  transcriptSummary?: string;
}

/**
 * Send a summary notification email for a new insight.
 * @param payload The notification details
 * @param apiEndpoint The backend API endpoint (default: /api/notify-summary)
 * @returns true if sent successfully, false otherwise
 */
export async function sendSummaryNotification(
  payload: EmailNotificationPayload,
  apiEndpoint = '/api/notify-summary',
): Promise<boolean> {
  try {
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        `Email notification failed: ${response.status} ${response.statusText}`,
        await response.text(),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to send email notification:', error);
    return false;
  }
}

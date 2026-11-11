export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, such as List-Unsubscribe for marketing mail. */
  headers?: Record<string, string>;
}

export interface MailSender {
  /** Throws AppError('smtp_send_failed') (or similar) on failure; the message never carries the recipient. */
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');

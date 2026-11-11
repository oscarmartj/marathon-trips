import { createTransport, Transporter } from 'nodemailer';
import { AppError } from '../errors/safe-error';
import { MailMessage, MailSender } from './mail-sender';

/** SMTP through nodemailer. Locally it talks to Mailpit (docker compose service "mail"). */
export class SmtpMailSender implements MailSender {
  private readonly transport: Transporter;

  constructor(host: string, port: number) {
    // Plain SMTP with no credentials is for the local mail catcher only; the real provider is wired at deployment.
    this.transport = createTransport({ host, port, secure: false, ignoreTLS: true, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  }

  async send(message: MailMessage): Promise<{ providerMessageId: string }> {
    try {
      const info = await this.transport.sendMail({
        from: message.from, to: message.to, subject: message.subject, text: message.text, html: message.html, headers: message.headers,
      });
      return { providerMessageId: String(info.messageId) };
    } catch {
      // The original error can quote the recipient; keep only a fixed code.
      throw new AppError('smtp_send_failed', 'The mail server could not accept the message');
    }
  }

  close(): void {
    this.transport.close();
  }
}

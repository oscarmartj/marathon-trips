import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../errors/safe-error';

export interface RenderContext {
  /** The send step's transaction. Mint one-time tokens here: the token and its hash commit (or roll back) with the send. */
  tx: Prisma.TransactionClient;
  email: { id: string; to: string; locale: string; customerId: string | null; relatedEntityType: string | null; relatedEntityId: string | null };
  /** HMAC of the email id for unsubscribe links. */
  unsubscribeToken: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html?: string;
}

export interface MailTemplate {
  key: string;
  version: number;
  /** Builds the message from ids at send time. The result is never stored; only its SHA-256 is. */
  render(ctx: RenderContext): Promise<RenderedMail>;
  /**
   * Task 7.fix-2: `all` = a transactional email of this template is checked at send time too, and an `all` suppression
   * (bounce, complaint) that came in after it was queued stops it (`suppressed`, never retried). Marketing email is
   * always checked against any suppression. Left out for sign-in, booking and payment emails that must still go out.
   */
  suppressedBy?: 'all';
}

@Injectable()
export class MailTemplateRegistry {
  private readonly templates = new Map<string, MailTemplate>();

  register(t: MailTemplate): void {
    const id = `${t.key}@${t.version}`;
    if (this.templates.has(id)) throw new AppError('mail_template_duplicate', `Template ${id} is already registered`);
    this.templates.set(id, t);
  }

  get(key: string, version: number): MailTemplate | undefined {
    return this.templates.get(`${key}@${version}`);
  }
}

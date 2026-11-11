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

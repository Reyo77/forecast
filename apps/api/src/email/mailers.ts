import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../config/logger';
import type { EmailMessage, Mailer } from './types';

/** Development default: records the message (to + subject only; links stay out of logs) and sends nothing. */
export class LogMailer implements Mailer {
  readonly delivers: boolean = false;
  readonly outbox: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 100) this.outbox.shift();
    logger.info({ to: message.to, subject: message.subject }, 'email (log driver, not delivered)');
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export class SmtpMailer implements Mailer {
  readonly delivers = true;
  private readonly transport: Transporter;
  constructor(
    private readonly config: Pick<SmtpConfig, 'from'> & Partial<SmtpConfig>,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      });
  }
  async send(m: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
  }
}

/**
 * Sends without ever throwing: email is a convenience on top of the copy-link flows, so a mail
 * outage must not fail an invite or signup. Returns true only when a delivering mailer accepted it.
 */
export async function trySend(mailer: Mailer, message: EmailMessage): Promise<boolean> {
  try {
    await mailer.send(message);
    return mailer.delivers;
  } catch (err) {
    logger.error({ err, to: message.to }, 'email delivery failed');
    return false;
  }
}

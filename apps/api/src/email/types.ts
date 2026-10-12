export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** False for drivers that only record messages (nothing reaches an inbox). */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<void>;
}

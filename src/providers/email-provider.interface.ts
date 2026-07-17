export interface SendEmailParams {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  html: string;
  replyTo?: string;
  /** Extra RFC 5322 headers, e.g. List-Unsubscribe / List-Unsubscribe-Post. */
  headers?: Record<string, string>;
}

/**
 * Sending-only provider abstraction. Identity/domain verification is managed
 * directly in the provider's console (AWS SES) and is intentionally not part
 * of this interface.
 */
export interface EmailProvider {
  /**
   * Dispatches a single transactional or campaign email
   */
  sendEmail(params: SendEmailParams): Promise<{ messageId: string }>;
}

export interface SendEmailParams {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  html: string;
  replyTo?: string;
}

export interface VerifyDomainResult {
  verificationToken: string;
  dkimTokens: string[];
}

export interface DomainStatusResult {
  verificationStatus: "Pending" | "Success" | "Failed" | "NotFound";
  dkimStatus: "Pending" | "Success" | "Failed" | "NotFound";
}

export interface EmailProvider {
  /**
   * Dispatches a single transactional or campaign email
   */
  sendEmail(params: SendEmailParams): Promise<{ messageId: string }>;

  /**
   * Initiates verification for a custom sending domain (SPF/DKIM tokens)
   */
  verifyDomain(domain: string): Promise<VerifyDomainResult>;

  /**
   * Retrieves the current DNS validation status for a domain from the provider
   */
  getDomainVerificationStatus(domain: string): Promise<DomainStatusResult>;

  /**
   * Triggers a verification email for an individual sender email identity
   */
  verifyEmailIdentity(email: string): Promise<void>;

  /**
   * Returns verification status for a single email address
   */
  getEmailIdentityVerificationStatus(email: string): Promise<"Pending" | "Success" | "Failed" | "NotFound">;
}

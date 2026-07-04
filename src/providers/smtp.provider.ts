import nodemailer from "nodemailer";
import { 
  EmailProvider, 
  SendEmailParams, 
  VerifyDomainResult, 
  DomainStatusResult 
} from "./email-provider.interface";

export class SMTPEmailProvider implements EmailProvider {
  private transporter: nodemailer.Transporter;

  constructor() {
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = parseInt(process.env.SMTP_PORT || "587");
    const secure = port === 465; // True for SSL, false for TLS/StartTLS
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? {
        user,
        pass,
      } : undefined,
    });
  }

  async sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
    const from = params.fromName 
      ? `"${params.fromName}" <${params.fromEmail}>` 
      : params.fromEmail;

    const info = await this.transporter.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      replyTo: params.replyTo,
    });

    return { messageId: info.messageId || `smtp-msg-${Date.now()}` };
  }

  async verifyDomain(domain: string): Promise<VerifyDomainResult> {
    console.log(`SMTP: Initiating mock domain verification for domain: ${domain}`);
    return {
      verificationToken: `smtp-verification-token-${domain}-${Math.random().toString(36).substring(2, 8)}`,
      dkimTokens: [
        `smtp-dkim-1.${domain}`,
        `smtp-dkim-2.${domain}`,
        `smtp-dkim-3.${domain}`,
      ],
    };
  }

  async getDomainVerificationStatus(domain: string): Promise<DomainStatusResult> {
    console.log(`SMTP: Querying verification status for domain: ${domain}`);
    return {
      verificationStatus: "Success",
      dkimStatus: "Success",
    };
  }

  async verifyEmailIdentity(email: string): Promise<void> {
    console.log(`SMTP: Initiating mock email verification for: ${email}`);
  }

  async getEmailIdentityVerificationStatus(email: string): Promise<"Pending" | "Success" | "Failed" | "NotFound"> {
    console.log(`SMTP: Querying verification status for email: ${email}`);
    return "Success";
  }
}

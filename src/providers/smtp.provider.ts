import nodemailer from "nodemailer";
import { EmailProvider, SendEmailParams } from "./email-provider.interface";

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
      headers: params.headers,
    });

    return { messageId: info.messageId || `smtp-msg-${Date.now()}` };
  }
}

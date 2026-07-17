import { EmailProvider, SendEmailParams } from "./email-provider.interface";

export class MockEmailProvider implements EmailProvider {
  async sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
    const mockMsgId = `mock-msg-${Math.random().toString(36).substring(2, 15)}`;

    console.log("======================================== MOCK EMAIL DISPATCH ========================================");
    console.log(`ID:      ${mockMsgId}`);
    console.log(`TO:      ${params.to}`);
    console.log(`FROM:    "${params.fromName}" <${params.fromEmail}>`);
    console.log(`SUBJECT: ${params.subject}`);
    if (params.headers) {
      console.log(`HEADERS: ${JSON.stringify(params.headers)}`);
    }
    console.log("----------------------------------------- HTML CONTENT -----------------------------------------");
    console.log(params.html.substring(0, 1000) + (params.html.length > 1000 ? "\n... (truncated)" : ""));
    console.log("=====================================================================================================");

    return { messageId: mockMsgId };
  }
}

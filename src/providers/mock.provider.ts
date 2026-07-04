import { 
  EmailProvider, 
  SendEmailParams, 
  VerifyDomainResult, 
  DomainStatusResult 
} from "./email-provider.interface";

export class MockEmailProvider implements EmailProvider {
  async sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
    const mockMsgId = `mock-msg-${Math.random().toString(36).substring(2, 15)}`;
    
    console.log("======================================== MOCK EMAIL DISPATCH ========================================");
    console.log(`ID:      ${mockMsgId}`);
    console.log(`TO:      ${params.to}`);
    console.log(`FROM:    "${params.fromName}" <${params.fromEmail}>`);
    console.log(`SUBJECT: ${params.subject}`);
    console.log("----------------------------------------- HTML CONTENT -----------------------------------------");
    console.log(params.html.substring(0, 1000) + (params.html.length > 1000 ? "\n... (truncated)" : ""));
    console.log("=====================================================================================================");

    return { messageId: mockMsgId };
  }

  async verifyDomain(domain: string): Promise<VerifyDomainResult> {
    console.log(`Mock: Initiating domain verification for domain: ${domain}`);
    return {
      verificationToken: `mock-verification-token-${domain}-${Math.random().toString(36).substring(2, 8)}`,
      dkimTokens: [
        `mock-dkim-1.${domain}`,
        `mock-dkim-2.${domain}`,
        `mock-dkim-3.${domain}`,
      ],
    };
  }

  async getDomainVerificationStatus(domain: string): Promise<DomainStatusResult> {
    console.log(`Mock: Querying verification status for domain: ${domain}`);
    return {
      verificationStatus: "Success",
      dkimStatus: "Success",
    };
  }

  async verifyEmailIdentity(email: string): Promise<void> {
    console.log(`Mock: Initiating identity verification for email: ${email}`);
  }

  async getEmailIdentityVerificationStatus(email: string): Promise<"Pending" | "Success" | "Failed" | "NotFound"> {
    console.log(`Mock: Querying verification status for email: ${email}`);
    return "Success";
  }
}

import { 
  SESv2Client, 
  SendEmailCommand, 
  CreateEmailIdentityCommand, 
  GetEmailIdentityCommand, 
  DeleteEmailIdentityCommand 
} from "@aws-sdk/client-sesv2";
import { 
  EmailProvider, 
  SendEmailParams, 
  VerifyDomainResult, 
  DomainStatusResult 
} from "./email-provider.interface";

export class AWSEmailProvider implements EmailProvider {
  private client: SESv2Client;

  constructor() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || process.env.SES_REGION || "ap-south-1";

    this.client = new SESv2Client({
      region,
      credentials: accessKeyId && secretAccessKey ? {
        accessKeyId,
        secretAccessKey,
      } : undefined, // Fallback to standard IAM role/credential provider chain
    });
  }

  async sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
    const source = params.fromName 
      ? `"${params.fromName}" <${params.fromEmail}>` 
      : params.fromEmail;

    // Matches the AWS SES v2 send payload exactly 1-to-1
    const command = new SendEmailCommand({
      FromEmailAddress: source,
      Destination: {
        ToAddresses: [params.to],
      },
      Content: {
        Simple: {
          Subject: {
            Data: params.subject,
            Charset: "UTF-8",
          },
          Body: {
            Html: {
              Data: params.html,
              Charset: "UTF-8",
            },
          },
        },
      },
      ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
    });

    const response = await this.client.send(command);
    
    if (!response.MessageId) {
      throw new Error("AWS SES failed to return a MessageId");
    }

    return { messageId: response.MessageId };
  }

  async verifyDomain(domain: string): Promise<VerifyDomainResult> {
    const command = new CreateEmailIdentityCommand({ EmailIdentity: domain });
    const response = await this.client.send(command);
    const dkimTokens = response.DkimAttributes?.Tokens || [];

    return {
      verificationToken: dkimTokens[0] || "",
      dkimTokens,
    };
  }

  async getDomainVerificationStatus(domain: string): Promise<DomainStatusResult> {
    try {
      const command = new GetEmailIdentityCommand({ EmailIdentity: domain });
      const response = await this.client.send(command);
      
      const verified = response.VerifiedForSendingStatus;
      const dkimStatus = response.DkimAttributes?.Status;

      const mapStatus = (isVerified: boolean, status?: string): "Pending" | "Success" | "Failed" | "NotFound" => {
        if (isVerified && status === "SUCCESS") return "Success";
        if (status === "FAILED") return "Failed";
        return "Pending";
      };

      return {
        verificationStatus: mapStatus(!!verified, dkimStatus),
        dkimStatus: dkimStatus === "SUCCESS" ? "Success" : dkimStatus === "FAILED" ? "Failed" : "Pending",
      };
    } catch (error: any) {
      if (error.name === "NotFoundException") {
        return { verificationStatus: "NotFound", dkimStatus: "NotFound" };
      }
      throw error;
    }
  }

  async verifyEmailIdentity(email: string): Promise<void> {
    const command = new CreateEmailIdentityCommand({ EmailIdentity: email });
    await this.client.send(command);
  }

  async getEmailIdentityVerificationStatus(email: string): Promise<"Pending" | "Success" | "Failed" | "NotFound"> {
    try {
      const command = new GetEmailIdentityCommand({ EmailIdentity: email });
      const response = await this.client.send(command);
      return response.VerifiedForSendingStatus ? "Success" : "Pending";
    } catch (error: any) {
      if (error.name === "NotFoundException") {
        return "NotFound";
      }
      throw error;
    }
  }

  async deleteIdentity(identity: string): Promise<void> {
    const command = new DeleteEmailIdentityCommand({ EmailIdentity: identity });
    await this.client.send(command);
  }
}

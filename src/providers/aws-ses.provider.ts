import { 
  SESClient, 
  SendEmailCommand, 
  VerifyDomainIdentityCommand, 
  VerifyEmailIdentityCommand, 
  GetIdentityVerificationAttributesCommand, 
  GetIdentityDkimAttributesCommand,
  DeleteIdentityCommand
} from "@aws-sdk/client-ses";
import { 
  EmailProvider, 
  SendEmailParams, 
  VerifyDomainResult, 
  DomainStatusResult 
} from "./email-provider.interface";

export class AWSEmailProvider implements EmailProvider {
  private client: SESClient;

  constructor() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || process.env.SES_REGION || "us-east-1";

    this.client = new SESClient({
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

    const command = new SendEmailCommand({
      Source: source,
      Destination: {
        ToAddresses: [params.to],
      },
      Message: {
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
      ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
    });

    const response = await this.client.send(command);
    
    if (!response.MessageId) {
      throw new Error("AWS SES failed to return a MessageId");
    }

    return { messageId: response.MessageId };
  }

  async verifyDomain(domain: string): Promise<VerifyDomainResult> {
    // 1. Verify domain identity (generates verification TXT token)
    const verifyCommand = new VerifyDomainIdentityCommand({ Domain: domain });
    const verifyResponse = await this.client.send(verifyCommand);
    const verificationToken = verifyResponse.VerificationToken || "";

    // 2. Fetch DKIM tokens (SES handles Easy DKIM automatic signing)
    // In SDK v3, we need to request Easy DKIM setup
    // Since AWS SES automatically generates DKIM tokens on domain creation or using a separate call, 
    // let's fetch verification DKIM attributes.
    const dkimCommand = new GetIdentityDkimAttributesCommand({ Identities: [domain] });
    const dkimResponse = await this.client.send(dkimCommand);
    const dkimTokens = dkimResponse.DkimAttributes?.[domain]?.DkimTokens || [];

    return {
      verificationToken,
      dkimTokens,
    };
  }

  async getDomainVerificationStatus(domain: string): Promise<DomainStatusResult> {
    const verifyCommand = new GetIdentityVerificationAttributesCommand({ Identities: [domain] });
    const verifyResponse = await this.client.send(verifyCommand);
    const rawVerifyStatus = verifyResponse.VerificationAttributes?.[domain]?.VerificationStatus;

    const dkimCommand = new GetIdentityDkimAttributesCommand({ Identities: [domain] });
    const dkimResponse = await this.client.send(dkimCommand);
    const rawDkimStatus = dkimResponse.DkimAttributes?.[domain]?.DkimVerificationStatus;

    const mapStatus = (status?: string): "Pending" | "Success" | "Failed" | "NotFound" => {
      switch (status) {
        case "Pending":
          return "Pending";
        case "Success":
          return "Success";
        case "Failed":
          return "Failed";
        default:
          return "NotFound";
      }
    };

    return {
      verificationStatus: mapStatus(rawVerifyStatus),
      dkimStatus: mapStatus(rawDkimStatus),
    };
  }

  async verifyEmailIdentity(email: string): Promise<void> {
    const command = new VerifyEmailIdentityCommand({ EmailAddress: email });
    await this.client.send(command);
  }

  async getEmailIdentityVerificationStatus(email: string): Promise<"Pending" | "Success" | "Failed" | "NotFound"> {
    const command = new GetIdentityVerificationAttributesCommand({ Identities: [email] });
    const response = await this.client.send(command);
    const rawStatus = response.VerificationAttributes?.[email]?.VerificationStatus;

    switch (rawStatus) {
      case "Pending":
        return "Pending";
      case "Success":
        return "Success";
      case "Failed":
        return "Failed";
      default:
        return "NotFound";
    }
  }

  async deleteIdentity(identity: string): Promise<void> {
    const command = new DeleteIdentityCommand({ Identity: identity });
    await this.client.send(command);
  }
}

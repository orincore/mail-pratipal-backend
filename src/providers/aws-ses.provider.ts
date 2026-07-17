import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailProvider, SendEmailParams } from "./email-provider.interface";

/**
 * AWS SES v2 sending provider. Identities (domains + senders) are managed
 * directly in the AWS console — this class only dispatches mail.
 */
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
          Headers: params.headers
            ? Object.entries(params.headers).map(([Name, Value]) => ({ Name, Value }))
            : undefined,
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
}

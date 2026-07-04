import { EmailProvider } from "./email-provider.interface";
import { AWSEmailProvider } from "./aws-ses.provider";
import { SMTPEmailProvider } from "./smtp.provider";
import { MockEmailProvider } from "./mock.provider";

let providerInstance: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (providerInstance) {
    return providerInstance;
  }

  const configuredProvider = process.env.EMAIL_PROVIDER?.toLowerCase();

  if (configuredProvider === "aws") {
    console.log("Email Service: Initializing AWS SES provider");
    providerInstance = new AWSEmailProvider();
  } else if (configuredProvider === "smtp") {
    console.log("Email Service: Initializing SMTP provider");
    providerInstance = new SMTPEmailProvider();
  } else if (configuredProvider === "mock") {
    console.log("Email Service: Initializing Mock developer provider");
    providerInstance = new MockEmailProvider();
  } else {
    // Auto-detect based on env variables
    const hasAwsKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    const hasSmtpConfig = !!(process.env.SMTP_HOST && process.env.SMTP_USER);
    if (hasAwsKeys) {
      console.log("Email Service: AWS keys detected. Auto-initializing AWS SES provider");
      providerInstance = new AWSEmailProvider();
    } else if (hasSmtpConfig) {
      console.log("Email Service: SMTP config detected. Auto-initializing SMTP provider");
      providerInstance = new SMTPEmailProvider();
    } else {
      console.log("Email Service: No AWS/SMTP credentials detected. Defaulting to Mock provider for local development");
      providerInstance = new MockEmailProvider();
    }
  }

  return providerInstance;
}

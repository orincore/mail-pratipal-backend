import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailDomain from "../models/EmailDomain";
import EmailSender from "../models/EmailSender";
import { getEmailProvider } from "../providers/provider-factory";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

// ==========================================
// DOMAIN ENDPOINTS
// ==========================================

// GET /api/domains - List domains
router.get("/domains", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const provider = getEmailProvider();
    const domains = await EmailDomain.find().sort({ created_at: -1 });

    const updatedDomains = [];
    
    // Sync verification status with provider in real time
    for (const d of domains) {
      try {
        const liveStatus = await provider.getDomainVerificationStatus(d.domain);
        
        const mapVerification = liveStatus.verificationStatus.toLowerCase();
        const mapDkim = liveStatus.dkimStatus.toLowerCase();
        
        d.verification_status = (
          mapVerification === "success" ? "verified" :
          mapVerification === "notfound" ? "failed" :
          mapVerification
        ) as any;
        
        d.dkim_status = (
          mapDkim === "success" ? "verified" :
          mapDkim === "notfound" ? "failed" :
          mapDkim
        ) as any;
        
        await d.save();
        updatedDomains.push(d);
      } catch (err) {
        console.error(`Failed to sync SES status for domain ${d.domain}:`, err);
        updatedDomains.push(d);
      }
    }

    return res.json(updatedDomains);
  } catch (error: any) {
    console.error("GET domains error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/domains - Create domain
router.post("/domains", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({ error: "Domain name is required" });
    }

    const cleanDomain = domain.toLowerCase().trim();

    // Check if domain is already registered
    const exists = await EmailDomain.exists({ domain: cleanDomain });
    if (exists) {
      return res.status(400).json({ error: "Domain is already registered" });
    }

    const provider = getEmailProvider();
    
    // Verify on AWS SES (gets verification TXT and CNAME Easy DKIM tokens)
    const sesVerification = await provider.verifyDomain(cleanDomain);

    const emailDomain = await EmailDomain.create({
      domain: cleanDomain,
      verification_token: sesVerification.verificationToken,
      dkim_tokens: sesVerification.dkimTokens,
      verification_status: "pending",
      dkim_status: "pending",
    });

    return res.json({ success: true, domain: emailDomain });
  } catch (error: any) {
    console.error("POST domain error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/domains - Delete domain
router.delete("/domains", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Domain ID is required" });
    }

    const emailDomain = await EmailDomain.findById(id);
    if (!emailDomain) {
      return res.status(404).json({ error: "Domain not found" });
    }

    const provider = getEmailProvider();
    
    // Attempt deleting domain from SES identity list
    if (typeof (provider as any).deleteIdentity === "function") {
      try {
        await (provider as any).deleteIdentity(emailDomain.domain);
      } catch (err) {
        console.warn(`Could not delete domain identity from SES service:`, err);
      }
    }

    await EmailDomain.findByIdAndDelete(id);

    return res.json({ success: true, message: "Domain deleted successfully" });
  } catch (error: any) {
    console.error("DELETE domain error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ==========================================
// SENDER ENDPOINTS
// ==========================================

// GET /api/senders - List senders
router.get("/senders", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const provider = getEmailProvider();
    const senders = await EmailSender.find().sort({ created_at: -1 });

    const updatedSenders = [];

    // Sync validation state with AWS SES in real time
    for (const s of senders) {
      try {
        const rawStatus = await provider.getEmailIdentityVerificationStatus(s.email);
        const lowerStatus = rawStatus.toLowerCase();
        s.verification_status = (
          lowerStatus === "success" ? "verified" :
          lowerStatus === "notfound" ? "failed" : 
          lowerStatus
        ) as any;
        await s.save();
        updatedSenders.push(s);
      } catch (err) {
        console.error(`Failed to sync SES status for email identity ${s.email}:`, err);
        updatedSenders.push(s);
      }
    }

    return res.json(updatedSenders);
  } catch (error: any) {
    console.error("GET senders error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/senders - Create sender identity
router.post("/senders", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email identity is required" });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check if email already exists
    const exists = await EmailSender.exists({ email: cleanEmail });
    if (exists) {
      return res.status(400).json({ error: "Email identity is already registered" });
    }

    const provider = getEmailProvider();
    
    // Request AWS SES verification email to be sent
    await provider.verifyEmailIdentity(cleanEmail);

    const emailSender = await EmailSender.create({
      email: cleanEmail,
      verification_status: "pending",
    });

    return res.json({ success: true, sender: emailSender });
  } catch (error: any) {
    console.error("POST sender error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/senders - Delete sender identity
router.delete("/senders", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Sender ID is required" });
    }

    const emailSender = await EmailSender.findById(id);
    if (!emailSender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    const provider = getEmailProvider();
    
    // Try to remove from SES identity list
    if (typeof (provider as any).deleteIdentity === "function") {
      try {
        await (provider as any).deleteIdentity(emailSender.email);
      } catch (err) {
        console.warn(`Could not delete email identity from SES service:`, err);
      }
    }

    await EmailSender.findByIdAndDelete(id);

    return res.json({ success: true, message: "Email identity deleted successfully" });
  } catch (error: any) {
    console.error("DELETE sender error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;

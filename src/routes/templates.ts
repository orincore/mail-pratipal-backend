import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailTemplate from "../models/EmailTemplate";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

// GET /api/templates - List templates
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const templates = await EmailTemplate.find().sort({ updated_at: -1 });
    return res.json(templates);
  } catch (error: any) {
    console.error("GET templates error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/templates - Save new template
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, subject, html_content, design_json, type = "builder" } = req.body;

    if (!name || !html_content) {
      return res.status(400).json({ error: "Name and HTML content are required" });
    }

    const template = await EmailTemplate.create({
      name,
      subject,
      html_content,
      design_json,
      type,
    });

    return res.json({ success: true, template });
  } catch (error: any) {
    console.error("POST template error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/templates/:id/duplicate - Clone an existing template
router.post("/:id/duplicate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const original = await EmailTemplate.findById(id);
    if (!original) {
      return res.status(404).json({ error: "Template not found" });
    }

    const copy = await EmailTemplate.create({
      name: `${original.name} (Copy)`,
      subject: original.subject,
      html_content: original.html_content,
      design_json: original.design_json,
      type: original.type,
    });

    return res.json({ success: true, template: copy });
  } catch (error: any) {
    console.error("Duplicate template error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/templates - Update existing template
router.put("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, name, subject, html_content, design_json, type } = req.body;

    if (!id || !name || !html_content) {
      return res.status(400).json({ error: "ID, name and HTML content are required" });
    }

    const template = await EmailTemplate.findByIdAndUpdate(
      id,
      { name, subject, html_content, design_json, type },
      { new: true }
    );

    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    return res.json({ success: true, template });
  } catch (error: any) {
    console.error("PUT template error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/templates - Delete template
router.delete("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Template ID is required" });
    }

    const template = await EmailTemplate.findByIdAndDelete(id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    return res.json({ success: true, message: "Template deleted successfully" });
  } catch (error: any) {
    console.error("DELETE template error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;

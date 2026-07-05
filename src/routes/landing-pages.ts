import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import LandingPage from "../models/LandingPage";

const router = Router();

router.use(authMiddleware);

// GET /api/landing-pages - List landing pages
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pages = await LandingPage.find().sort({ created_at: -1 });
    return res.json({ pages });
  } catch (error: any) {
    console.error("GET landing-pages error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/landing-pages - Create landing page
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, slug } = req.body;
    const cleanTitle = (title ?? "").trim();
    const cleanSlug = (slug ?? "").trim();

    if (!cleanTitle || !cleanSlug) {
      return res.status(400).json({ error: "Title and slug are required" });
    }

    const baseSlug = cleanSlug.replace(/-\d+$/, "");
    const existingPages = await LandingPage.find({
      slug: { $regex: `^${baseSlug}`, $options: "i" }
    }).select('slug');

    const existingSlugs = new Set(existingPages.map(p => p.slug));
    let finalSlug = cleanSlug;
    if (existingSlugs.has(finalSlug)) {
      let counter = 1;
      while (existingSlugs.has(`${baseSlug}-${counter}`)) {
        counter++;
      }
      finalSlug = `${baseSlug}-${counter}`;
    }

    const page = await LandingPage.create({
      title: cleanTitle,
      slug: finalSlug,
      content: req.body.content ?? {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: cleanTitle }],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Start editing your landing page here...",
              },
            ],
          },
        ],
      },
      theme: req.body.theme ?? {
        primary: "#0F8A5F",
        secondary: "#0B4F6C",
        accent: "#18A999",
        background: "#FFFFFF",
      },
      seo_title: req.body.seo_title ?? cleanTitle,
      seo_description: req.body.seo_description ?? "",
      status: req.body.status ?? "draft",
    });

    return res.status(201).json({ page });
  } catch (error: any) {
    console.error("POST landing-pages error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/landing-pages/:id/duplicate - Duplicate landing page
router.post("/:id/duplicate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const original = await LandingPage.findById(id);

    if (!original) {
      return res.status(404).json({ error: "Page not found" });
    }

    const baseSlug = original.slug.replace(/-\d+$/, "");
    const existingPages = await LandingPage.find({
      slug: new RegExp(`^${baseSlug}`, 'i')
    }).select('slug');

    const existingSlugs = new Set(existingPages.map(p => p.slug));
    let newSlug = `${baseSlug}-1`;
    let counter = 1;
    while (existingSlugs.has(newSlug)) {
      counter++;
      newSlug = `${baseSlug}-${counter}`;
    }

    const duplicated = await LandingPage.create({
      title: `${original.title} (Copy)`,
      slug: newSlug,
      content: original.content,
      theme: original.theme,
      seo_title: original.seo_title,
      seo_description: original.seo_description,
      status: "draft",
    });

    return res.status(201).json({ page: duplicated });
  } catch (error: any) {
    console.error("Duplicate landing-page error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /api/landing-pages/:id - Update page status or other fields
router.patch("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const payload: Record<string, any> = {};
    const editableFields = [
      "title",
      "slug",
      "content",
      "theme",
      "seo_title",
      "seo_description",
      "schema_type",
      "custom_schema",
      "status",
    ];

    for (const field of editableFields) {
      if (field in req.body) {
        payload[field] = req.body[field];
      }
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: "No valid fields provided" });
    }

    const page = await LandingPage.findByIdAndUpdate(id, payload, { new: true });

    if (!page) {
      return res.status(404).json({ error: "Page not found" });
    }

    return res.json({ page });
  } catch (error: any) {
    console.error("PATCH landing-page error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/landing-pages/:id - Delete landing page
router.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await LandingPage.findByIdAndDelete(id);

    if (!result) {
      return res.status(404).json({ error: "Page not found" });
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error("DELETE landing-page error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;

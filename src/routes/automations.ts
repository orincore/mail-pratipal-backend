import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailAutomation from "../models/EmailAutomation";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

// GET /api/automations - List automations
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const automations = await EmailAutomation.find().sort({ created_at: -1 });
    return res.json(automations);
  } catch (error: any) {
    console.error("GET automations error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/automations - Create new automation
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, trigger, steps = [] } = req.body;

    if (!name || !trigger) {
      return res.status(400).json({ error: "Name and trigger configuration are required" });
    }

    const automation = await EmailAutomation.create({
      name,
      trigger,
      steps,
      status: "draft",
      enrollments: [],
      stats: { enrolled: 0, completed: 0 }
    });

    return res.json({ success: true, automation });
  } catch (error: any) {
    console.error("POST automation error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/automations - Update properties or enroll subscriber manually
router.put("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, name, trigger, steps, status, enrollSubscriberId } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Automation ID is required" });
    }

    const automation = await EmailAutomation.findById(id);
    if (!automation) {
      return res.status(404).json({ error: "Automation not found" });
    }

    // Handle manual enrollment
    if (enrollSubscriberId) {
      if (automation.steps.length === 0) {
        return res.status(400).json({ error: "Cannot enroll in automation with no steps" });
      }

      // Check if subscriber is already enrolled
      const isEnrolled = automation.enrollments.some(
        (e: any) => e.subscriber_id.toString() === enrollSubscriberId && e.status === "active"
      );

      if (isEnrolled) {
        return res.status(400).json({ error: "Subscriber is already active in this automation" });
      }

      // Enroll subscriber at the first step
      const firstStepId = automation.steps[0].id;
      automation.enrollments.push({
        subscriber_id: enrollSubscriberId as any,
        current_step_id: firstStepId,
        next_run_at: new Date(),
        status: "active",
        history: [],
      });
      
      automation.stats.enrolled += 1;
      await automation.save();
      return res.json({ success: true, message: "Subscriber enrolled successfully", automation });
    }

    // Direct update of properties
    if (name) automation.name = name;
    if (trigger) automation.trigger = trigger;
    if (steps) automation.steps = steps;
    if (status) automation.status = status;

    await automation.save();
    return res.json({ success: true, automation });
  } catch (error: any) {
    console.error("PUT automation error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/automations - Delete automation
router.delete("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Automation ID is required" });
    }

    const automation = await EmailAutomation.findByIdAndDelete(id);
    if (!automation) {
      return res.status(404).json({ error: "Automation not found" });
    }

    return res.json({ success: true, message: "Automation deleted successfully" });
  } catch (error: any) {
    console.error("DELETE automation error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;

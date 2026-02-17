import express from "express";
import { Permission } from "../models/permission.model.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

router.post("/list", authenticate, async (req, res) => {
  try {
    const permissions = await Permission.find({})
      .select("key label description group")
      .sort({ group: 1, key: 1 })
      .lean();

    const grouped = {};
    for (const perm of permissions) {
      if (!grouped[perm.group]) grouped[perm.group] = [];
      grouped[perm.group].push({
        id: perm._id,
        key: perm.key,
        label: perm.label,
        description: perm.description,
      });
    }

    return res.json({ success: true, permissions, grouped, total: permissions.length });
  } catch (error) {
    console.error("List permissions error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;

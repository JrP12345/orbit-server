import express from "express";
import bcrypt from "bcryptjs";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Invite } from "../models/invite.model.js";
import { authenticate, buildUserResponse } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import { clearAuthCookies } from "../lib/auth.js";

const router = express.Router();

/* ─── POST /api/users/update — OWNER updates a member ─── */

router.post("/update", authenticate, requireRole("OWNER"), async (req, res) => {
  try {
    const { userId, name, role } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const user = await User.findOne({
      _id: userId,
      organizationId: req.user.organizationId,
    });

    if (!user) {
      return res.status(404).json({ message: "Member not found in your organization" });
    }

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      user.name = name.trim();
    }

    if (role !== undefined) {
      const validRoles = ["MEMBER"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: `Invalid role. Allowed: ${validRoles.join(", ")}` });
      }
      user.role = role;
    }

    await user.save();

    return res.json({
      success: true,
      message: "Member updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/users/delete — OWNER removes a member ─── */

router.post("/delete", authenticate, requireRole("OWNER"), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const user = await User.findOne({
      _id: userId,
      organizationId: req.user.organizationId,
    });

    if (!user) {
      return res.status(404).json({ message: "Member not found in your organization" });
    }

    // Delete the user
    await User.deleteOne({ _id: userId });

    // Clean up: Delete any accepted invites for this user's email
    await Invite.deleteMany({
      organizationId: req.user.organizationId,
      email: user.email,
      status: "ACCEPTED",
    });

    return res.json({
      success: true,
      message: `${user.name} has been removed from the organization`,
    });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/users/profile — Authenticated user updates own profile ─── */

router.post("/profile", authenticate, async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;

    if (!name && !newPassword) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    // Load entity from DB
    let entity, type;
    if (req.user.userType === "user") {
      entity = await User.findById(req.user.id);
      type = "user";
    } else {
      entity = await Organization.findById(req.user.id);
      type = "organization";
    }

    if (!entity) {
      return res.status(404).json({ message: "Account not found" });
    }

    // Update name
    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      if (type === "organization") {
        entity.ownerName = name.trim();
      } else {
        entity.name = name.trim();
      }
    }

    // Update password
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: "Current password is required to set a new password" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters" });
      }
      const valid = await bcrypt.compare(currentPassword, entity.password);
      if (!valid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }
      entity.password = await bcrypt.hash(newPassword, 10);
    }

    await entity.save();

    return res.json({
      success: true,
      message: "Profile updated successfully",
      user: buildUserResponse(entity, type),
    });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;

import express from "express";
import bcrypt from "bcryptjs";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Invite } from "../models/invite.model.js";
import { Role } from "../models/role.model.js";
import { authenticate, buildUserResponse, resolvePermissions } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permission.js";
import { BCRYPT_ROUNDS } from "../lib/validate.js";
import { cacheDelPattern } from "../db/redis.js";

const router = express.Router();

router.post("/update", authenticate, requirePermission("PAGE_SETTINGS"), requirePermission("USER_INVITE"), async (req, res) => {
  try {
    const { userId, name, role, roleId } = req.body;
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

    // Update RBAC role
    if (roleId !== undefined) {
      if (roleId === null) {
        user.roleId = null;
      } else {
        const roleDoc = await Role.findOne({
          _id: roleId,
          organizationId: req.user.organizationId,
        });
        if (!roleDoc) {
          return res.status(404).json({ message: "Role not found in your organization" });
        }
        if (roleDoc.isSystem && roleDoc.name === "OWNER") {
          return res.status(403).json({ message: "Cannot assign OWNER role to team members" });
        }
        user.roleId = roleDoc._id;
      }
    }

    await user.save();
    if (req.body.roleId !== undefined) await cacheDelPattern(`perms:${user._id}`);

    return res.json({
      success: true,
      message: "Member updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        roleId: user.roleId,
      },
    });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/delete", authenticate, requirePermission("PAGE_SETTINGS"), requirePermission("USER_INVITE"), async (req, res) => {
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

    // Clean up: Delete any lingering invites for this user's email
    await Invite.deleteMany({
      organizationId: req.user.organizationId,
      email: user.email,
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
      entity.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    }

    await entity.save();

    const resolved = await resolvePermissions(entity, type);
    return res.json({
      success: true,
      message: "Profile updated successfully",
      user: buildUserResponse(entity, type, resolved.permissions, resolved.roleName),
    });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;

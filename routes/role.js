import express from "express";
import { Role } from "../models/role.model.js";
import { Permission } from "../models/permission.model.js";
import { User } from "../models/user.model.js";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permission.js";
import { DEFAULT_ROLE_TEMPLATES } from "../lib/roles.js";
import { cacheDelPattern } from "../db/redis.js";

const router = express.Router();

router.post(
  "/",
  authenticate,
  requirePermission("PAGE_SETTINGS"),
  requirePermission("ROLE_MANAGE"),
  async (req, res) => {
    try {
      const { name, permissions } = req.body;
      const organizationId = req.user.organizationId;

      if (!name?.trim()) {
        return res.status(400).json({ message: "Role name is required" });
      }

      // Check for duplicate name within this org
      const existing = await Role.findOne({
        organizationId,
        name: name.trim(),
      });
      if (existing) {
        return res.status(409).json({ message: "A role with this name already exists" });
      }

      // Validate permission IDs
      let validPermIds = [];
      if (permissions && Array.isArray(permissions) && permissions.length > 0) {
        const validPerms = await Permission.find({
          _id: { $in: permissions },
        })
          .select("_id")
          .lean();
        validPermIds = validPerms.map((p) => p._id);
      }

      const role = await Role.create({
        organizationId,
        name: name.trim(),
        permissions: validPermIds,
        isSystem: false,
      });

      // Populate permissions for response
      const populated = await Role.findById(role._id)
        .populate("permissions", "key label description group")
        .lean();

      return res.status(201).json({
        success: true,
        message: "Role created successfully",
        role: formatRole(populated),
      });
    } catch (error) {
      console.error("Create role error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/list", authenticate, async (req, res) => {
  try {
    const organizationId = req.user.organizationId;

    const roles = await Role.find({ organizationId })
      .populate("permissions", "key label description group")
      .sort({ isSystem: -1, name: 1 })
      .lean();

    // Count users per role
    const userCounts = await User.aggregate([
      { $match: { organizationId: roles[0]?.organizationId || organizationId } },
      { $group: { _id: "$roleId", count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(
      userCounts.map((uc) => [uc._id?.toString(), uc.count])
    );

    const formatted = roles.map((r) => ({
      ...formatRole(r),
      userCount: countMap[r._id.toString()] || 0,
    }));

    return res.json({
      success: true,
      roles: formatted,
      total: formatted.length,
    });
  } catch (error) {
    console.error("List roles error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post(
  "/update",
  authenticate,
  requirePermission("PAGE_SETTINGS"),
  requirePermission("ROLE_MANAGE"),
  async (req, res) => {
    try {
      const { roleId, name, permissions } = req.body;
      const organizationId = req.user.organizationId;

      if (!roleId) {
        return res.status(400).json({ message: "roleId is required" });
      }

      const role = await Role.findOne({ _id: roleId, organizationId });
      if (!role) {
        return res.status(404).json({ message: "Role not found in your organization" });
      }

      // System roles: cannot rename, but CAN update MEMBER permissions
      if (role.isSystem && role.name === "OWNER") {
        return res.status(403).json({ message: "Cannot modify the system OWNER role" });
      }

      // Update name (skip for system roles)
      if (name !== undefined && !role.isSystem) {
        if (!name.trim()) {
          return res.status(400).json({ message: "Role name cannot be empty" });
        }
        // Check duplicate
        const dup = await Role.findOne({
          organizationId,
          name: name.trim(),
          _id: { $ne: roleId },
        });
        if (dup) {
          return res.status(409).json({ message: "A role with this name already exists" });
        }
        role.name = name.trim();
      }

      // Update permissions
      if (permissions !== undefined) {
        if (!Array.isArray(permissions)) {
          return res.status(400).json({ message: "permissions must be an array" });
        }
        const validPerms = await Permission.find({
          _id: { $in: permissions },
        })
          .select("_id")
          .lean();
        role.permissions = validPerms.map((p) => p._id);
      }

      await role.save();

      // Invalidate cached permissions for users with this role
      await cacheDelPattern("perms:*");

      const populated = await Role.findById(role._id)
        .populate("permissions", "key label description group")
        .lean();

      return res.json({
        success: true,
        message: "Role updated successfully",
        role: formatRole(populated),
      });
    } catch (error) {
      console.error("Update role error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post(
  "/delete",
  authenticate,
  requirePermission("PAGE_SETTINGS"),
  requirePermission("ROLE_MANAGE"),
  async (req, res) => {
    try {
      const { roleId } = req.body;
      const organizationId = req.user.organizationId;

      if (!roleId) {
        return res.status(400).json({ message: "roleId is required" });
      }

      const role = await Role.findOne({ _id: roleId, organizationId });
      if (!role) {
        return res.status(404).json({ message: "Role not found in your organization" });
      }

      if (role.isSystem) {
        return res.status(403).json({ message: "Cannot delete system roles" });
      }

      // Move users on this role to the default MEMBER role
      const memberRole = await Role.findOne({
        organizationId,
        name: "MEMBER",
        isSystem: true,
      });

      if (memberRole) {
        await User.updateMany(
          { organizationId, roleId: role._id },
          { $set: { roleId: memberRole._id } }
        );
      }

      await Role.deleteOne({ _id: role._id });
      await cacheDelPattern("perms:*");

      return res.json({
        success: true,
        message: `Role "${role.name}" deleted. Affected users moved to MEMBER role.`,
      });
    } catch (error) {
      console.error("Delete role error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post(
  "/assign",
  authenticate,
  requirePermission("PAGE_SETTINGS"),
  requirePermission("ROLE_MANAGE"),
  async (req, res) => {
    try {
      const { userId, roleId } = req.body;
      const organizationId = req.user.organizationId;

      if (!userId) return res.status(400).json({ message: "userId is required" });
      if (!roleId) return res.status(400).json({ message: "roleId is required" });

      // Verify role belongs to this org
      const role = await Role.findOne({ _id: roleId, organizationId });
      if (!role) {
        return res.status(404).json({ message: "Role not found in your organization" });
      }

      // Cannot assign OWNER system role to a User (Owner is always Organization entity)
      if (role.isSystem && role.name === "OWNER") {
        return res.status(403).json({ message: "Cannot assign the OWNER role to team members" });
      }

      // Verify user belongs to this org
      const user = await User.findOne({ _id: userId, organizationId });
      if (!user) {
        return res.status(404).json({ message: "User not found in your organization" });
      }

      user.roleId = role._id;
      await user.save();
      await cacheDelPattern(`perms:${user._id}`);

      return res.json({
        success: true,
        message: `Role "${role.name}" assigned to ${user.name}`,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          roleId: user.roleId,
        },
      });
    } catch (error) {
      console.error("Assign role error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post(
  "/reset-defaults",
  authenticate,
  requirePermission("PAGE_SETTINGS"),
  requirePermission("ROLE_MANAGE"),
  async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
      let created = 0;

      for (const template of DEFAULT_ROLE_TEMPLATES) {
        const exists = await Role.findOne({ organizationId, name: template.name });
        if (!exists) {
          const permDocs = await Permission.find({ key: { $in: template.permissions } })
            .select("_id")
            .lean();
          await Role.create({
            organizationId,
            name: template.name,
            permissions: permDocs.map((p) => p._id),
            isSystem: false,
          });
          created++;
        }
      }

      if (created === 0) {
        return res.json({
          success: true,
          message: "All default roles already exist. Nothing to restore.",
        });
      }

      return res.json({
        success: true,
        message: `Restored ${created} default role${created !== 1 ? "s" : ""}`,
      });
    } catch (error) {
      console.error("Reset defaults error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

/* ── Helpers ── */

function formatRole(role) {
  return {
    id: role._id,
    name: role.name,
    isSystem: role.isSystem,
    permissions: (role.permissions || []).map((p) => ({
      id: p._id,
      key: p.key,
      label: p.label || p.key,
      description: p.description,
      group: p.group,
    })),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export default router;

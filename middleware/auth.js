import jwt from "jsonwebtoken";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Client } from "../models/client.model.js";
import { Role } from "../models/role.model.js";
import { Permission } from "../models/permission.model.js";
import { issueTokens, setAuthCookies, clearAuthCookies } from "../lib/auth.js";
import { cacheGet, cacheSet } from "../db/redis.js";

export async function resolveEntity(decoded) {
  const { id, userType } = decoded || {};
  if (userType === "user") {
    const user = await User.findById(id);
    return user ? { entity: user, type: "user" } : null;
  }
  if (userType === "organization") {
    const org = await Organization.findById(id);
    return org ? { entity: org, type: "organization" } : null;
  }
  if (userType === "client") {
    const client = await Client.findById(id);
    return client ? { entity: client, type: "client" } : null;
  }
  // Legacy tokens without userType
  const org = await Organization.findById(id);
  if (org) return { entity: org, type: "organization" };
  const user = await User.findById(id);
  if (user) return { entity: user, type: "user" };
  return null;
}

export function buildUserPayload(entity, type) {
  if (type === "user") {
    return {
      id: entity._id, email: entity.email, name: entity.name,
      role: entity.role || "MEMBER", roleId: entity.roleId || null,
      organizationId: entity.organizationId, userType: "user",
    };
  }
  if (type === "client") {
    return {
      id: entity._id, email: entity.email,
      name: entity.contactName || entity.name, role: "CLIENT",
      roleId: null, organizationId: entity.organizationId,
      userType: "client", clientId: entity._id, clientName: entity.name,
    };
  }
  return {
    id: entity._id, email: entity.email,
    name: entity.ownerName || entity.name, role: "OWNER",
    roleId: null, organizationId: entity._id, userType: "organization",
  };
}

export function buildUserResponse(entity, type, permissions = [], roleName = "") {
  const p = buildUserPayload(entity, type);
  if (type === "client") {
    return {
      id: p.id, name: p.name, email: p.email, role: "CLIENT",
      roleId: null, roleName: "Client", organizationId: p.organizationId,
      userType: "client", clientId: p.clientId, clientName: p.clientName,
      permissions: [],
    };
  }
  return {
    id: p.id, name: p.name, email: p.email, role: p.role,
    roleId: p.roleId, roleName: type === "organization" ? "Owner" : roleName,
    organizationId: p.organizationId, permissions,
  };
}

export async function resolvePermissions(entity, type) {
  if (type === "client") return { permissions: [], roleName: "Client" };

  // Check Redis cache
  const cacheKey = `perms:${entity._id}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  let result;

  if (type === "organization") {
    const allPerms = await Permission.find({}).select("key").lean();
    result = { permissions: allPerms.map((p) => p.key), roleName: "Owner" };
  } else if (entity.roleId) {
    const role = await Role.findById(entity.roleId).populate("permissions", "key").lean();
    result = role?.permissions
      ? { permissions: role.permissions.map((p) => p.key), roleName: role.name || "Member" }
      : { permissions: [], roleName: "Member" };
  } else {
    // Fallback: system MEMBER role
    const memberRole = await Role.findOne({
      organizationId: entity.organizationId, name: "MEMBER", isSystem: true,
    }).populate("permissions", "key").lean();
    result = memberRole?.permissions
      ? { permissions: memberRole.permissions.map((p) => p.key), roleName: "Member" }
      : { permissions: [], roleName: "Member" };
  }

  await cacheSet(cacheKey, result, 300); // 5 min TTL
  return result;
}

export async function authenticate(req, res, next) {
  const { accessToken, refreshToken } = req.cookies || {};

  if (accessToken) {
    try {
      const decoded = jwt.decode(accessToken);
      if (decoded?.id) {
        const result = await resolveEntity(decoded);
        if (result?.entity?.publicKey) {
          jwt.verify(accessToken, result.entity.publicKey, { algorithms: ["RS256"] });
          if (refreshToken && result.entity.refreshToken !== refreshToken) {
            clearAuthCookies(res);
            return res.status(401).json({ message: "Session invalidated" });
          }
          req.user = buildUserPayload(result.entity, result.type);
          const resolved = await resolvePermissions(result.entity, result.type);
          req.user.permissions = resolved.permissions;
          return next();
        }
      }
    } catch (err) {
      // Access token invalid — try refresh below
      if (err.name !== 'JsonWebTokenError' && err.name !== 'TokenExpiredError') {
        console.error('Auth middleware access token error:', err);
      }
    }
  }

  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(401).json({ message: "No valid tokens" });
  }

  try {
    const decoded = jwt.decode(refreshToken);
    if (!decoded?.id) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const result = await resolveEntity(decoded);
    if (!result?.entity?.publicKey || !result?.entity?.privateKey) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "User not found" });
    }

    const { entity, type } = result;
    jwt.verify(refreshToken, entity.publicKey, { algorithms: ["RS256"] });

    if (entity.refreshToken !== refreshToken || !entity.refreshTokenExpires || entity.refreshTokenExpires < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "Refresh token expired" });
    }

    const rememberMe = !!entity.rememberMe;
    const payload = buildUserPayload(entity, type);
    const tokens = issueTokens(entity.privateKey, payload, rememberMe);
    entity.refreshToken = tokens.refreshToken;
    entity.refreshTokenExpires = tokens.refreshExpires;
    await entity.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);
    req.user = payload;
    const resolved = await resolvePermissions(entity, type);
    req.user.permissions = resolved.permissions;
    return next();
  } catch (err) {
    if (err.name !== 'JsonWebTokenError' && err.name !== 'TokenExpiredError') {
      console.error('Auth middleware refresh token error:', err);
    }
    clearAuthCookies(res);
    return res.status(401).json({ message: "Authentication failed" });
  }
}

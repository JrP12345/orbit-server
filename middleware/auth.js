import jwt from "jsonwebtoken";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import {
  issueTokens,
  setAuthCookies,
  clearAuthCookies,
} from "../lib/auth.js";

/**
 * Resolve entity + type from decoded JWT.
 * Handles old tokens (no userType) by checking both collections.
 */
export async function resolveEntity(decoded) {
  if (decoded?.userType === "user") {
    const user = await User.findById(decoded.id);
    return user ? { entity: user, type: "user" } : null;
  }
  if (decoded?.userType === "organization") {
    const org = await Organization.findById(decoded.id);
    return org ? { entity: org, type: "organization" } : null;
  }
  // Old token without userType — try Organization first, then User
  const org = await Organization.findById(decoded.id);
  if (org) return { entity: org, type: "organization" };
  const user = await User.findById(decoded.id);
  if (user) return { entity: user, type: "user" };
  return null;
}

/** Build a consistent user payload from entity + type */
export function buildUserPayload(entity, type) {
  if (type === "user") {
    return {
      id: entity._id,
      email: entity.email,
      name: entity.name,
      role: entity.role || "MEMBER",
      organizationId: entity.organizationId,
      userType: "user",
    };
  }
  // Organization → owner
  return {
    id: entity._id,
    email: entity.email,
    name: entity.ownerName || entity.name,
    role: "OWNER",
    organizationId: entity._id,
    userType: "organization",
  };
}

/** Build a safe user response (no sensitive fields) */
export function buildUserResponse(entity, type) {
  const p = buildUserPayload(entity, type);
  return { id: p.id, name: p.name, email: p.email, role: p.role, organizationId: p.organizationId };
}

export async function authenticate(req, res, next) {
  const { accessToken, refreshToken } = req.cookies || {};

  // 1) Try access token
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
          return next();
        }
      }
    } catch {
      // Access token invalid/expired, try refresh below
    }
  }

  // 2) Try refresh token
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

    // Issue new tokens using shared helper
    const rememberMe = !!entity.rememberMe;
    const payload = buildUserPayload(entity, type);
    const tokens = issueTokens(entity.privateKey, payload, rememberMe);

    entity.refreshToken = tokens.refreshToken;
    entity.refreshTokenExpires = tokens.refreshExpires;
    await entity.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);

    req.user = payload;
    return next();
  } catch {
    clearAuthCookies(res);
    return res.status(401).json({ message: "Authentication failed" });
  }
}

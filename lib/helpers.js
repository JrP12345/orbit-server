import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Client } from "../models/client.model.js";
import {
  issueTokens,
  setAuthCookies,
} from "./auth.js";
import {
  buildUserPayload,
  buildUserResponse,
  resolvePermissions,
} from "../middleware/auth.js";

// Check email uniqueness across all entity types
export async function checkEmailAvailable(email, excludeClientId = null) {
  if (await Organization.findOne({ email })) return "This email is already in use";
  if (await User.findOne({ email })) return "This email is already in use";
  const clientFilter = { email };
  if (excludeClientId) clientFilter._id = { $ne: excludeClientId };
  if (await Client.findOne(clientFilter)) return "This email is already in use by another client";
  return null;
}

// Shared login flow — authenticate entity + issue tokens + set cookies
export async function loginEntity(res, entity, type, rememberMe, generateKeysFn) {
  if (!entity.privateKey || !entity.publicKey) {
    const { privateKey, publicKey } = generateKeysFn();
    entity.privateKey = privateKey;
    entity.publicKey = publicKey;
  }

  const payload = buildUserPayload(entity, type);
  const tokens = issueTokens(entity.privateKey, payload, rememberMe);
  entity.refreshToken = tokens.refreshToken;
  entity.refreshTokenExpires = tokens.refreshExpires;
  entity.rememberMe = !!rememberMe;
  await entity.save();

  setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);
  const perms = await resolvePermissions(entity, type);

  return {
    success: true,
    message: "Login successful",
    user: buildUserResponse(entity, type, perms.permissions, perms.roleName),
  };
}

// Resolve a single user/org name by ID
export async function resolveActorName(userId) {
  const user = await User.findById(userId).select("name").lean();
  if (user) return user.name;
  const org = await Organization.findById(userId).select("ownerName").lean();
  return org?.ownerName || "Unknown";
}

// Batch-resolve user/org names by IDs → { [id]: { name, email } }
export async function resolveActorNames(ids) {
  if (!ids || ids.length === 0) return {};
  const users = await User.find({ _id: { $in: ids } }).select("name email").lean();
  const map = Object.fromEntries(users.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));

  const missingIds = ids.filter((id) => !map[id.toString()]);
  if (missingIds.length > 0) {
    const orgs = await Organization.find({ _id: { $in: missingIds } }).select("ownerName email").lean();
    for (const org of orgs) {
      map[org._id.toString()] = { name: org.ownerName, email: org.email };
    }
  }
  return map;
}

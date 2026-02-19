/**
 * Shared test helpers — factory functions for creating test entities,
 * plus helper to make authenticated requests via supertest.
 */
import supertest from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app.js";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Client } from "../models/client.model.js";
import { Plan } from "../models/plan.model.js";
import { Permission } from "../models/permission.model.js";
import { Role } from "../models/role.model.js";
import { Invite } from "../models/invite.model.js";
import { Task } from "../models/task.model.js";
import { Requirement } from "../models/requirement.model.js";
import { generateKeys, issueTokens } from "../lib/auth.js";
import { buildUserPayload } from "../middleware/auth.js";
import { bootstrapOrgRoles } from "../lib/roles.js";
import { generateToken, hashToken } from "../lib/crypto.js";

// Suppress noisy logs during tests
const origWarn = console.warn;
const origErr = console.error;
const origLog = console.log;

export function suppressLogs() {
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
}

export function restoreLogs() {
  console.warn = origWarn;
  console.error = origErr;
  console.log = origLog;
}

/** Singleton app instance */
let _app;
export function getApp() {
  if (!_app) _app = createApp();
  return _app;
}

/** Create a supertest agent attached to the app */
export function agent() {
  return supertest(getApp());
}

/**
 * Wipe all non-seed collections between tests.
 * Keeps Permission and Plan docs (seeded globally).
 */
export async function cleanDb() {
  const collections = ["organizations", "users", "clients", "roles", "invites", "tasks", "requirements"];
  for (const name of collections) {
    const col = (await import("mongoose")).default.connection.collection(name);
    try { await col.deleteMany({}); } catch { /* collection may not exist yet */ }
  }
}

// ────────────────── Factory helpers ──────────────────

const BCRYPT_ROUNDS = 4; // fast for tests

/**
 * Create an Organization + bootstrap its roles.
 * Returns { org, ownerTokens, ownerCookies }
 */
export async function createTestOrg(overrides = {}) {
  const { privateKey, publicKey } = generateKeys();
  const password = await bcrypt.hash("Test1234", BCRYPT_ROUNDS);
  const defaultPlan = await Plan.findOne({ name: "FREE" });

  const org = await Organization.create({
    name: overrides.name || "TestOrg",
    ownerName: overrides.ownerName || "Owner",
    email: overrides.email || `org-${Date.now()}@test.com`,
    password,
    address: "",
    phone: overrides.phone || "1234567890",
    privateKey,
    publicKey,
    planId: defaultPlan?._id || null,
    ...overrides,
  });

  // suppress logs during role bootstrap
  suppressLogs();
  await bootstrapOrgRoles(org._id);
  restoreLogs();

  const payload = buildUserPayload(org, "organization");
  const tokens = issueTokens(org.privateKey, payload, false);
  org.refreshToken = tokens.refreshToken;
  org.refreshTokenExpires = tokens.refreshExpires;
  await org.save();

  const cookies = `accessToken=${tokens.accessToken}; refreshToken=${tokens.refreshToken}`;
  return { org, tokens, cookies };
}

/**
 * Create a User within an organization.
 * Returns { user, tokens, cookies }
 */
export async function createTestUser(organizationId, overrides = {}) {
  const { privateKey, publicKey } = generateKeys();
  const password = await bcrypt.hash(overrides.plainPassword || "Test1234", BCRYPT_ROUNDS);

  // Get role
  let roleId = overrides.roleId || null;
  if (!roleId) {
    const role = await Role.findOne({ organizationId, name: "MEMBER", isSystem: true });
    if (role) roleId = role._id;
  }

  const user = await User.create({
    organizationId,
    name: overrides.name || "TestUser",
    email: overrides.email || `user-${Date.now()}@test.com`,
    password,
    role: "MEMBER",
    roleId,
    privateKey,
    publicKey,
  });

  const payload = buildUserPayload(user, "user");
  const tokens = issueTokens(user.privateKey, payload, false);
  user.refreshToken = tokens.refreshToken;
  user.refreshTokenExpires = tokens.refreshExpires;
  await user.save();

  const cookies = `accessToken=${tokens.accessToken}; refreshToken=${tokens.refreshToken}`;
  return { user, tokens, cookies };
}

/**
 * Create a User with a specific role (by name).
 */
export async function createTestUserWithRole(organizationId, roleName, overrides = {}) {
  const role = await Role.findOne({ organizationId, name: roleName });
  return createTestUser(organizationId, { ...overrides, roleId: role?._id || null });
}

/**
 * Create a Client within an organization.
 * Returns { client }
 */
export async function createTestClient(organizationId, overrides = {}) {
  const client = await Client.create({
    organizationId,
    name: overrides.name || "TestClient",
    contactName: overrides.contactName || "Contact Person",
    email: overrides.email || `client-${Date.now()}@test.com`,
    status: overrides.status || "ACTIVE",
    ...overrides,
  });
  return { client };
}

/**
 * Create an authenticated Client (with password & keys for portal access).
 */
export async function createTestClientWithAuth(organizationId, overrides = {}) {
  const { privateKey, publicKey } = generateKeys();
  const password = await bcrypt.hash("Test1234", BCRYPT_ROUNDS);

  const client = await Client.create({
    organizationId,
    name: overrides.name || "AuthClient",
    contactName: overrides.contactName || "AuthContact",
    email: overrides.email || `authclient-${Date.now()}@test.com`,
    status: "ACTIVE",
    password,
    privateKey,
    publicKey,
    ...overrides,
  });

  const payload = buildUserPayload(client, "client");
  const tokens = issueTokens(client.privateKey, payload, false);
  client.refreshToken = tokens.refreshToken;
  client.refreshTokenExpires = tokens.refreshExpires;
  await client.save();

  const cookies = `accessToken=${tokens.accessToken}; refreshToken=${tokens.refreshToken}`;
  return { client, tokens, cookies };
}

/**
 * Create a Task.
 */
export async function createTestTask(organizationId, clientId, createdBy, overrides = {}) {
  const task = await Task.create({
    organizationId,
    clientId,
    title: overrides.title || "Test Task",
    description: overrides.description || "Test description",
    assignedTo: overrides.assignedTo || [],
    status: overrides.status || "TODO",
    createdBy,
    history: [],
  });
  return { task };
}

/**
 * Create a Requirement.
 */
export async function createTestRequirement(organizationId, clientId, createdBy, overrides = {}) {
  const requirement = await Requirement.create({
    organizationId,
    clientId,
    title: overrides.title || "Test Requirement",
    description: overrides.description || "Description",
    priority: overrides.priority || "MEDIUM",
    status: overrides.status || "OPEN",
    createdBy,
    comments: [],
    linkedTaskIds: overrides.linkedTaskIds || [],
  });
  return { requirement };
}

/**
 * Create a pending Invite.
 */
export async function createTestInvite(organizationId, overrides = {}) {
  const rawToken = generateToken();
  const invite = await Invite.create({
    organizationId,
    email: overrides.email || `invite-${Date.now()}@test.com`,
    role: "MEMBER",
    token: hashToken(rawToken),
    expiresAt: overrides.expiresAt || new Date(Date.now() + 48 * 60 * 60 * 1000),
    status: overrides.status || "PENDING",
    roleId: overrides.roleId || null,
  });
  return { invite, rawToken };
}

/**
 * Get all permission IDs for a given list of keys (used to create custom roles in tests).
 */
export async function getPermissionIds(keys) {
  const perms = await Permission.find({ key: { $in: keys } }).select("_id").lean();
  return perms.map((p) => p._id);
}

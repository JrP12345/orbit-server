import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestUser, createTestInvite, getPermissionIds } from "./helpers.js";
import { Invite } from "../models/invite.model.js";
import { User } from "../models/user.model.js";
import { Role } from "../models/role.model.js";

describe("Invite Routes", () => {
  let org, ownerCookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
  });

  // ─── Create Invite ───
  describe("POST /api/invites", () => {
    it("should create an invite", async () => {
      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: "newuser@test.com" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.invite.email).toBe("newuser@test.com");
      expect(res.body.invite.status).toBe("PENDING");
    });

    it("should create invite with a specific roleId", async () => {
      const memberRole = await Role.findOne({
        organizationId: org._id,
        name: "MEMBER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: "roleuser@test.com", roleId: memberRole._id.toString() });

      expect(res.status).toBe(201);
      expect(res.body.invite.roleId).toBe(memberRole._id.toString());
    });

    it("should reject duplicate pending invite", async () => {
      await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: "dup@test.com" });

      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: "dup@test.com" });

      expect(res.status).toBe(409);
    });

    it("should reject invite to the org owner's email", async () => {
      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: org.email });

      expect(res.status).toBe(409);
    });

    it("should reject invite to an existing user", async () => {
      await createTestUser(org._id, { email: "existing@test.com" });

      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: "existing@test.com" });

      expect(res.status).toBe(409);
    });

    it("should reject missing email", async () => {
      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject without authentication", async () => {
      const res = await agent()
        .post("/api/invites")
        .send({ email: "noauth@test.com" });

      expect(res.status).toBe(401);
    });

    it("should reject assigning OWNER role via invite", async () => {
      const ownerRole = await Role.findOne({
        organizationId: org._id,
        name: "OWNER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/invites")
        .set("Cookie", ownerCookies)
        .send({ email: "x@test.com", roleId: ownerRole._id.toString() });

      expect(res.status).toBe(403);
    });

    it("should reject user without USER_INVITE permission", async () => {
      // Create a custom role with no permissions
      const emptyRole = await Role.create({
        organizationId: org._id,
        name: "RESTRICTED",
        permissions: [],
        isSystem: false,
      });
      const { cookies: userCookies } = await createTestUser(org._id, {
        roleId: emptyRole._id,
      });

      const res = await agent()
        .post("/api/invites")
        .set("Cookie", userCookies)
        .send({ email: "noperm@test.com" });

      expect(res.status).toBe(403);
    });
  });

  // ─── Accept Invite ───
  describe("POST /api/invites/accept", () => {
    it("should accept a valid invite and delete it", async () => {
      const { invite, rawToken } = await createTestInvite(org._id, {
        email: "accept@test.com",
      });

      const res = await agent()
        .post("/api/invites/accept")
        .send({ token: rawToken, name: "New User", password: "Password123" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.email).toBe("accept@test.com");

      // Invite should be deleted
      const found = await Invite.findById(invite._id);
      expect(found).toBeNull();

      // User should be created
      const user = await User.findOne({ email: "accept@test.com" });
      expect(user).not.toBeNull();
    });

    it("should reject invalid token", async () => {
      const res = await agent()
        .post("/api/invites/accept")
        .send({ token: "badtoken", name: "User", password: "Password123" });

      expect(res.status).toBe(404);
    });

    it("should reject missing fields", async () => {
      const { rawToken } = await createTestInvite(org._id);

      const res = await agent()
        .post("/api/invites/accept")
        .send({ token: rawToken });

      expect(res.status).toBe(400);
    });

    it("should reject short password", async () => {
      const { rawToken } = await createTestInvite(org._id);

      const res = await agent()
        .post("/api/invites/accept")
        .send({ token: rawToken, name: "User", password: "123" });

      expect(res.status).toBe(400);
    });

    it("should reject expired invite", async () => {
      const { rawToken } = await createTestInvite(org._id, {
        expiresAt: new Date(Date.now() - 1000),
      });

      const res = await agent()
        .post("/api/invites/accept")
        .send({ token: rawToken, name: "User", password: "Password123" });

      expect(res.status).toBe(400);
    });

    it("should reject revoked invite", async () => {
      const { rawToken } = await createTestInvite(org._id, {
        status: "REVOKED",
      });

      const res = await agent()
        .post("/api/invites/accept")
        .send({ token: rawToken, name: "User", password: "Password123" });

      expect(res.status).toBe(400);
    });
  });

  // ─── Revoke Invite ───
  describe("POST /api/invites/revoke", () => {
    it("should revoke a pending invite", async () => {
      const { invite } = await createTestInvite(org._id);

      const res = await agent()
        .post("/api/invites/revoke")
        .set("Cookie", ownerCookies)
        .send({ inviteId: invite._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = await Invite.findById(invite._id);
      expect(updated.status).toBe("REVOKED");
    });

    it("should reject revoking non-pending invite", async () => {
      const { invite } = await createTestInvite(org._id, { status: "REVOKED" });

      const res = await agent()
        .post("/api/invites/revoke")
        .set("Cookie", ownerCookies)
        .send({ inviteId: invite._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject missing inviteId", async () => {
      const res = await agent()
        .post("/api/invites/revoke")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ─── Delete Invite ───
  describe("POST /api/invites/delete", () => {
    it("should delete an invite", async () => {
      const { invite } = await createTestInvite(org._id);

      const res = await agent()
        .post("/api/invites/delete")
        .set("Cookie", ownerCookies)
        .send({ inviteId: invite._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const found = await Invite.findById(invite._id);
      expect(found).toBeNull();
    });

    it("should reject non-existent invite", async () => {
      const res = await agent()
        .post("/api/invites/delete")
        .set("Cookie", ownerCookies)
        .send({ inviteId: "000000000000000000000000" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Resend Invite ───
  describe("POST /api/invites/resend", () => {
    it("should resend a pending invite", async () => {
      const { invite } = await createTestInvite(org._id);

      const res = await agent()
        .post("/api/invites/resend")
        .set("Cookie", ownerCookies)
        .send({ inviteId: invite._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject expired invite resend", async () => {
      const { invite } = await createTestInvite(org._id, {
        expiresAt: new Date(Date.now() - 1000),
      });

      const res = await agent()
        .post("/api/invites/resend")
        .set("Cookie", ownerCookies)
        .send({ inviteId: invite._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject missing inviteId", async () => {
      const res = await agent()
        .post("/api/invites/resend")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ─── Users List ───
  describe("POST /api/invites/users", () => {
    it("should list all users and pending invites", async () => {
      await createTestUser(org._id, { email: "user1@test.com" });
      await createTestInvite(org._id, { email: "pending@test.com" });

      const res = await agent()
        .post("/api/invites/users")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Should have owner + user1
      expect(res.body.users.length).toBe(2);
      expect(res.body.users[0].role).toBe("OWNER");
      expect(res.body.pendingInvites.length).toBe(1);
      expect(res.body.pendingInvites[0].email).toBe("pending@test.com");
    });

    it("should include permissions for users", async () => {
      await createTestUser(org._id, { email: "permuser@test.com" });

      const res = await agent()
        .post("/api/invites/users")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      // Owner has ALL permission
      const owner = res.body.users.find((u) => u.role === "OWNER");
      expect(owner.permissions).toContain("ALL");
      // Normal user has array of permissions
      const user = res.body.users.find((u) => u.email === "permuser@test.com");
      expect(Array.isArray(user.permissions)).toBe(true);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent().post("/api/invites/users");
      expect(res.status).toBe(401);
    });
  });
});

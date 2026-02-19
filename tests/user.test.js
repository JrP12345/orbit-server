import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestUser } from "./helpers.js";
import { User } from "../models/user.model.js";
import { Role } from "../models/role.model.js";
import { Invite } from "../models/invite.model.js";

describe("User Routes", () => {
  let org, ownerCookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
  });

  // ─── Update User ───
  describe("POST /api/users/update", () => {
    it("should update a user's name", async () => {
      const { user } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/update")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString(), name: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe("Updated Name");
    });

    it("should update a user's roleId", async () => {
      const { user } = await createTestUser(org._id);
      const memberRole = await Role.findOne({
        organizationId: org._id,
        name: "MEMBER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/users/update")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString(), roleId: memberRole._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.user.roleId).toBe(memberRole._id.toString());
    });

    it("should reject assigning OWNER role", async () => {
      const { user } = await createTestUser(org._id);
      const ownerRole = await Role.findOne({
        organizationId: org._id,
        name: "OWNER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/users/update")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString(), roleId: ownerRole._id.toString() });

      expect(res.status).toBe(403);
    });

    it("should reject empty name", async () => {
      const { user } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/update")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString(), name: "   " });

      expect(res.status).toBe(400);
    });

    it("should reject missing userId", async () => {
      const res = await agent()
        .post("/api/users/update")
        .set("Cookie", ownerCookies)
        .send({ name: "X" });

      expect(res.status).toBe(400);
    });

    it("should reject non-existent user", async () => {
      const res = await agent()
        .post("/api/users/update")
        .set("Cookie", ownerCookies)
        .send({ userId: "000000000000000000000000", name: "X" });

      expect(res.status).toBe(404);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent()
        .post("/api/users/update")
        .send({ userId: "000000000000000000000000" });

      expect(res.status).toBe(401);
    });
  });

  // ─── Delete User ───
  describe("POST /api/users/delete", () => {
    it("should delete a user and clean up invites", async () => {
      const { user } = await createTestUser(org._id, { email: "todelete@test.com" });

      // Create a lingering invite for same email
      await Invite.create({
        organizationId: org._id,
        email: "todelete@test.com",
        role: "MEMBER",
        token: "fakehash",
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        status: "PENDING",
      });

      const res = await agent()
        .post("/api/users/delete")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // User should be gone
      const found = await User.findById(user._id);
      expect(found).toBeNull();

      // Invite should also be cleaned up
      const invites = await Invite.find({ email: "todelete@test.com" });
      expect(invites.length).toBe(0);
    });

    it("should reject missing userId", async () => {
      const res = await agent()
        .post("/api/users/delete")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject non-existent user", async () => {
      const res = await agent()
        .post("/api/users/delete")
        .set("Cookie", ownerCookies)
        .send({ userId: "000000000000000000000000" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Profile ───
  describe("POST /api/users/profile", () => {
    it("should update owner's name", async () => {
      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", ownerCookies)
        .send({ name: "New Owner Name" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe("New Owner Name");
    });

    it("should update user's name", async () => {
      const { cookies } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", cookies)
        .send({ name: "User New Name" });

      expect(res.status).toBe(200);
      expect(res.body.user.name).toBe("User New Name");
    });

    it("should update password when current password is correct", async () => {
      const { cookies } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", cookies)
        .send({ currentPassword: "Test1234", newPassword: "NewPass123" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject wrong current password", async () => {
      const { cookies } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", cookies)
        .send({ currentPassword: "WrongPass", newPassword: "NewPass123" });

      expect(res.status).toBe(401);
    });

    it("should reject new password without current password", async () => {
      const { cookies } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", cookies)
        .send({ newPassword: "NewPass123" });

      expect(res.status).toBe(400);
    });

    it("should reject short new password", async () => {
      const { cookies } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", cookies)
        .send({ currentPassword: "Test1234", newPassword: "short" });

      expect(res.status).toBe(400);
    });

    it("should reject empty update", async () => {
      const { cookies } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/users/profile")
        .set("Cookie", cookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent()
        .post("/api/users/profile")
        .send({ name: "X" });

      expect(res.status).toBe(401);
    });
  });
});

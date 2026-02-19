import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestUser, getPermissionIds } from "./helpers.js";
import { Role } from "../models/role.model.js";
import { User } from "../models/user.model.js";
import { Permission } from "../models/permission.model.js";

describe("Role Routes", () => {
  let org, ownerCookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
  });

  // ─── Create Role ───
  describe("POST /api/roles", () => {
    it("should create a custom role", async () => {
      const permIds = await getPermissionIds(["PAGE_TASKS", "TASK_CREATE"]);

      const res = await agent()
        .post("/api/roles")
        .set("Cookie", ownerCookies)
        .send({ name: "Developer", permissions: permIds.map((id) => id.toString()) });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.role.name).toBe("Developer");
      expect(res.body.role.isSystem).toBe(false);
      expect(res.body.role.permissions.length).toBe(2);
    });

    it("should create a role with no permissions", async () => {
      const res = await agent()
        .post("/api/roles")
        .set("Cookie", ownerCookies)
        .send({ name: "Viewer" });

      expect(res.status).toBe(201);
      expect(res.body.role.permissions.length).toBe(0);
    });

    it("should reject duplicate role name", async () => {
      await agent()
        .post("/api/roles")
        .set("Cookie", ownerCookies)
        .send({ name: "Engineer" });

      const res = await agent()
        .post("/api/roles")
        .set("Cookie", ownerCookies)
        .send({ name: "Engineer" });

      expect(res.status).toBe(409);
    });

    it("should reject missing name", async () => {
      const res = await agent()
        .post("/api/roles")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent()
        .post("/api/roles")
        .send({ name: "Ghost" });

      expect(res.status).toBe(401);
    });
  });

  // ─── List Roles ───
  describe("POST /api/roles/list", () => {
    it("should list system and custom roles", async () => {
      const res = await agent()
        .post("/api/roles/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.roles.length).toBeGreaterThanOrEqual(2); // OWNER + MEMBER at least
      const systemRoles = res.body.roles.filter((r) => r.isSystem);
      expect(systemRoles.length).toBeGreaterThanOrEqual(2);
    });

    it("should include user counts per role", async () => {
      const memberRole = await Role.findOne({
        organizationId: org._id,
        name: "MEMBER",
        isSystem: true,
      });
      await createTestUser(org._id);

      const res = await agent()
        .post("/api/roles/list")
        .set("Cookie", ownerCookies);

      const member = res.body.roles.find((r) => r.name === "MEMBER" && r.isSystem);
      expect(member.userCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Update Role ───
  describe("POST /api/roles/update", () => {
    it("should update a custom role's name and permissions", async () => {
      const role = await Role.create({
        organizationId: org._id,
        name: "OldName",
        permissions: [],
        isSystem: false,
      });
      const permIds = await getPermissionIds(["PAGE_TASKS"]);

      const res = await agent()
        .post("/api/roles/update")
        .set("Cookie", ownerCookies)
        .send({
          roleId: role._id.toString(),
          name: "NewName",
          permissions: permIds.map((id) => id.toString()),
        });

      expect(res.status).toBe(200);
      expect(res.body.role.name).toBe("NewName");
      expect(res.body.role.permissions.length).toBe(1);
    });

    it("should allow updating MEMBER system role permissions (not name)", async () => {
      const memberRole = await Role.findOne({
        organizationId: org._id,
        name: "MEMBER",
        isSystem: true,
      });
      const permIds = await getPermissionIds(["PAGE_DASHBOARD"]);

      const res = await agent()
        .post("/api/roles/update")
        .set("Cookie", ownerCookies)
        .send({
          roleId: memberRole._id.toString(),
          permissions: permIds.map((id) => id.toString()),
        });

      expect(res.status).toBe(200);
    });

    it("should reject modifying OWNER system role", async () => {
      const ownerRole = await Role.findOne({
        organizationId: org._id,
        name: "OWNER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/roles/update")
        .set("Cookie", ownerCookies)
        .send({ roleId: ownerRole._id.toString(), name: "Hacked" });

      expect(res.status).toBe(403);
    });

    it("should reject duplicate name", async () => {
      await Role.create({
        organizationId: org._id,
        name: "Existing",
        permissions: [],
        isSystem: false,
      });
      const role2 = await Role.create({
        organizationId: org._id,
        name: "ToRename",
        permissions: [],
        isSystem: false,
      });

      const res = await agent()
        .post("/api/roles/update")
        .set("Cookie", ownerCookies)
        .send({ roleId: role2._id.toString(), name: "Existing" });

      expect(res.status).toBe(409);
    });

    it("should reject missing roleId", async () => {
      const res = await agent()
        .post("/api/roles/update")
        .set("Cookie", ownerCookies)
        .send({ name: "X" });

      expect(res.status).toBe(400);
    });
  });

  // ─── Delete Role ───
  describe("POST /api/roles/delete", () => {
    it("should delete a custom role and reassign users to MEMBER", async () => {
      const customRole = await Role.create({
        organizationId: org._id,
        name: "ToDelete",
        permissions: [],
        isSystem: false,
      });
      const { user } = await createTestUser(org._id, { roleId: customRole._id });

      const res = await agent()
        .post("/api/roles/delete")
        .set("Cookie", ownerCookies)
        .send({ roleId: customRole._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Role deleted
      const found = await Role.findById(customRole._id);
      expect(found).toBeNull();

      // User reassigned to MEMBER
      const updatedUser = await User.findById(user._id);
      const memberRole = await Role.findOne({
        organizationId: org._id,
        name: "MEMBER",
        isSystem: true,
      });
      expect(updatedUser.roleId.toString()).toBe(memberRole._id.toString());
    });

    it("should reject deleting system roles", async () => {
      const memberRole = await Role.findOne({
        organizationId: org._id,
        name: "MEMBER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/roles/delete")
        .set("Cookie", ownerCookies)
        .send({ roleId: memberRole._id.toString() });

      expect(res.status).toBe(403);
    });

    it("should reject non-existent role", async () => {
      const res = await agent()
        .post("/api/roles/delete")
        .set("Cookie", ownerCookies)
        .send({ roleId: "000000000000000000000000" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Assign Role ───
  describe("POST /api/roles/assign", () => {
    it("should assign a role to a user", async () => {
      const { user } = await createTestUser(org._id);
      const customRole = await Role.create({
        organizationId: org._id,
        name: "Custom",
        permissions: [],
        isSystem: false,
      });

      const res = await agent()
        .post("/api/roles/assign")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString(), roleId: customRole._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.user.roleId).toBe(customRole._id.toString());
    });

    it("should reject assigning OWNER role to a user", async () => {
      const { user } = await createTestUser(org._id);
      const ownerRole = await Role.findOne({
        organizationId: org._id,
        name: "OWNER",
        isSystem: true,
      });

      const res = await agent()
        .post("/api/roles/assign")
        .set("Cookie", ownerCookies)
        .send({ userId: user._id.toString(), roleId: ownerRole._id.toString() });

      expect(res.status).toBe(403);
    });

    it("should reject missing userId or roleId", async () => {
      const res = await agent()
        .post("/api/roles/assign")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ─── Reset Defaults ───
  describe("POST /api/roles/reset-defaults", () => {
    it("should restore default roles if missing", async () => {
      const res = await agent()
        .post("/api/roles/reset-defaults")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});

describe("Permission Routes", () => {
  let ownerCookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    ownerCookies = result.cookies;
  });

  describe("POST /api/permissions/list", () => {
    it("should list all permissions grouped", async () => {
      const res = await agent()
        .post("/api/permissions/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBeGreaterThan(0);
      expect(res.body.grouped).toBeDefined();
      expect(Array.isArray(res.body.permissions)).toBe(true);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent().post("/api/permissions/list");

      expect(res.status).toBe(401);
    });
  });
});

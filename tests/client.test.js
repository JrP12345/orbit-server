import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestClient, createTestClientWithAuth, createTestRequirement } from "./helpers.js";
import { Client } from "../models/client.model.js";
import { Role } from "../models/role.model.js";
import { createTestUser } from "./helpers.js";

describe("Client Routes", () => {
  let org, ownerCookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
  });

  // ─── Create Client ───
  describe("POST /api/clients", () => {
    it("should create a client without email", async () => {
      const res = await agent()
        .post("/api/clients")
        .set("Cookie", ownerCookies)
        .send({ name: "ACME Inc", contactName: "John" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.client.name).toBe("ACME Inc");
      expect(res.body.client.status).toBe("ACTIVE");
    });

    it("should create a client with email (INVITED status)", async () => {
      const res = await agent()
        .post("/api/clients")
        .set("Cookie", ownerCookies)
        .send({ name: "Beta Corp", contactName: "Jane", email: "beta@corp.com" });

      expect(res.status).toBe(201);
      expect(res.body.client.status).toBe("INVITED");
      expect(res.body.client.email).toBe("beta@corp.com");
    });

    it("should reject missing client name", async () => {
      const res = await agent()
        .post("/api/clients")
        .set("Cookie", ownerCookies)
        .send({ contactName: "Joe" });

      expect(res.status).toBe(400);
    });

    it("should reject duplicate email", async () => {
      await createTestClient(org._id, { email: "dup@corp.com" });

      const res = await agent()
        .post("/api/clients")
        .set("Cookie", ownerCookies)
        .send({ name: "Dup", email: "dup@corp.com" });

      expect(res.status).toBe(409);
    });

    it("should reject invalid email", async () => {
      const res = await agent()
        .post("/api/clients")
        .set("Cookie", ownerCookies)
        .send({ name: "Bad Email", email: "not-email" });

      expect(res.status).toBe(400);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent()
        .post("/api/clients")
        .send({ name: "No Auth" });

      expect(res.status).toBe(401);
    });

    it("should reject user without CLIENT_MANAGE permission", async () => {
      const emptyRole = await Role.create({
        organizationId: org._id,
        name: "NOCLIENTS",
        permissions: [],
        isSystem: false,
      });
      const { cookies } = await createTestUser(org._id, { roleId: emptyRole._id });

      const res = await agent()
        .post("/api/clients")
        .set("Cookie", cookies)
        .send({ name: "Restricted" });

      expect(res.status).toBe(403);
    });
  });

  // ─── List Clients ───
  describe("POST /api/clients/list", () => {
    it("should list all clients", async () => {
      await createTestClient(org._id, { name: "C1" });
      await createTestClient(org._id, { name: "C2" });

      const res = await agent()
        .post("/api/clients/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.clients.length).toBe(2);
      expect(res.body.usage).toBeDefined();
    });

    it("should return empty list for fresh org", async () => {
      const res = await agent()
        .post("/api/clients/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.clients.length).toBe(0);
    });
  });

  // ─── Update Client ───
  describe("POST /api/clients/update", () => {
    it("should update client name", async () => {
      const { client } = await createTestClient(org._id);

      const res = await agent()
        .post("/api/clients/update")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString(), name: "Updated" });

      expect(res.status).toBe(200);
      expect(res.body.client.name).toBe("Updated");
    });

    it("should archive a client", async () => {
      const { client } = await createTestClient(org._id);

      const res = await agent()
        .post("/api/clients/update")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString(), status: "ARCHIVED" });

      expect(res.status).toBe(200);
      expect(res.body.client.status).toBe("ARCHIVED");
    });

    it("should reject invalid status", async () => {
      const { client } = await createTestClient(org._id);

      const res = await agent()
        .post("/api/clients/update")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString(), status: "INVALID" });

      expect(res.status).toBe(400);
    });

    it("should reject empty name", async () => {
      const { client } = await createTestClient(org._id);

      const res = await agent()
        .post("/api/clients/update")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString(), name: "   " });

      expect(res.status).toBe(400);
    });

    it("should reject missing clientId", async () => {
      const res = await agent()
        .post("/api/clients/update")
        .set("Cookie", ownerCookies)
        .send({ name: "X" });

      expect(res.status).toBe(400);
    });

    it("should reject non-existent client", async () => {
      const res = await agent()
        .post("/api/clients/update")
        .set("Cookie", ownerCookies)
        .send({ clientId: "000000000000000000000000", name: "X" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Resend Invite ───
  describe("POST /api/clients/resend-invite", () => {
    it("should resend invite for an invited client", async () => {
      const { client } = await createTestClient(org._id, {
        email: "invite@corp.com",
        status: "INVITED",
      });

      const res = await agent()
        .post("/api/clients/resend-invite")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject for client without email", async () => {
      // Create client directly with no email (helper always sets default email)
      const { Client } = await import("../models/client.model.js");
      const noEmailClient = await Client.create({
        organizationId: org._id,
        name: "No Email Client",
        contactName: "Contact",
        status: "ACTIVE",
      });

      const res = await agent()
        .post("/api/clients/resend-invite")
        .set("Cookie", ownerCookies)
        .send({ clientId: noEmailClient._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject for archived client", async () => {
      const { client } = await createTestClient(org._id, {
        email: "archived@corp.com",
        status: "ARCHIVED",
      });

      const res = await agent()
        .post("/api/clients/resend-invite")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject for client with portal access already", async () => {
      const { client } = await createTestClientWithAuth(org._id);

      const res = await agent()
        .post("/api/clients/resend-invite")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject missing clientId", async () => {
      const res = await agent()
        .post("/api/clients/resend-invite")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ─── Client Requirements ───
  describe("POST /api/clients/requirements", () => {
    it("should list requirements for a client", async () => {
      const { client } = await createTestClient(org._id);
      await createTestRequirement(org._id, client._id, org._id, { title: "Req 1" });
      await createTestRequirement(org._id, client._id, org._id, { title: "Req 2" });

      const res = await agent()
        .post("/api/clients/requirements")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.requirements.length).toBe(2);
    });

    it("should reject missing clientId", async () => {
      const res = await agent()
        .post("/api/clients/requirements")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });
  });
});

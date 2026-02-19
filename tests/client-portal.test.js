import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestClient, createTestClientWithAuth, createTestTask, createTestRequirement } from "./helpers.js";
import { Client } from "../models/client.model.js";
import { generateToken, hashToken } from "../lib/crypto.js";

describe("Client Portal Routes", () => {
  let org, ownerCookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
  });

  // ─── Accept Client Invite ───
  describe("POST /api/client-portal/accept-invite", () => {
    it("should accept a valid client invite", async () => {
      const rawToken = generateToken();
      const hashedToken = hashToken(rawToken);

      await Client.create({
        organizationId: org._id,
        name: "Portal Client",
        contactName: "Portal Contact",
        email: "portal@test.com",
        status: "INVITED",
        inviteToken: hashedToken,
        inviteExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });

      const res = await agent()
        .post("/api/client-portal/accept-invite")
        .send({ token: rawToken, password: "Password123" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe("CLIENT");

      // Client should now have password & be ACTIVE
      const updated = await Client.findOne({ email: "portal@test.com" });
      expect(updated.status).toBe("ACTIVE");
      expect(updated.password).toBeDefined();
      expect(updated.inviteToken).toBeNull();
    });

    it("should reject invalid token", async () => {
      const res = await agent()
        .post("/api/client-portal/accept-invite")
        .send({ token: "badtoken", password: "Password123" });

      expect(res.status).toBe(400);
    });

    it("should reject expired invite", async () => {
      const rawToken = generateToken();
      await Client.create({
        organizationId: org._id,
        name: "Expired",
        contactName: "Exp",
        email: "expired@test.com",
        status: "INVITED",
        inviteToken: hashToken(rawToken),
        inviteExpiresAt: new Date(Date.now() - 1000), // expired
      });

      const res = await agent()
        .post("/api/client-portal/accept-invite")
        .send({ token: rawToken, password: "Password123" });

      expect(res.status).toBe(400);
    });

    it("should reject missing fields", async () => {
      const res = await agent()
        .post("/api/client-portal/accept-invite")
        .send({ token: "abc" });

      expect(res.status).toBe(400);
    });

    it("should reject short password", async () => {
      const res = await agent()
        .post("/api/client-portal/accept-invite")
        .send({ token: "abc", password: "123" });

      expect(res.status).toBe(400);
    });
  });

  // ─── Dashboard ───
  describe("POST /api/client-portal/dashboard", () => {
    it("should return dashboard stats", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);

      // Create some data
      await createTestRequirement(org._id, client._id, client._id);
      await createTestTask(org._id, client._id, org._id, { status: "SENT_TO_CLIENT" });
      await createTestTask(org._id, client._id, org._id, { status: "DONE" });

      const res = await agent()
        .post("/api/client-portal/dashboard")
        .set("Cookie", cookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stats).toBeDefined();
      expect(res.body.stats.requirements).toBeDefined();
      expect(res.body.stats.tasks).toBeDefined();
      expect(res.body.stats.tasks.pendingReview).toBe(1);
      expect(res.body.stats.tasks.done).toBe(1);
    });

    it("should reject non-client user", async () => {
      const res = await agent()
        .post("/api/client-portal/dashboard")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(403);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent().post("/api/client-portal/dashboard");
      expect(res.status).toBe(401);
    });
  });

  // ─── Create Requirement ───
  describe("POST /api/client-portal/requirements", () => {
    it("should create a requirement from client portal", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);

      const res = await agent()
        .post("/api/client-portal/requirements")
        .set("Cookie", cookies)
        .send({ title: "Need new feature", description: "Details here", priority: "HIGH" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.requirement.title).toBe("Need new feature");
      expect(res.body.requirement.priority).toBe("HIGH");
    });

    it("should reject missing title", async () => {
      const { cookies } = await createTestClientWithAuth(org._id);

      const res = await agent()
        .post("/api/client-portal/requirements")
        .set("Cookie", cookies)
        .send({ description: "No title" });

      expect(res.status).toBe(400);
    });

    it("should reject invalid priority", async () => {
      const { cookies } = await createTestClientWithAuth(org._id);

      const res = await agent()
        .post("/api/client-portal/requirements")
        .set("Cookie", cookies)
        .send({ title: "Test", priority: "INVALID" });

      expect(res.status).toBe(400);
    });
  });

  // ─── List Requirements ───
  describe("POST /api/client-portal/requirements/list", () => {
    it("should list client's requirements", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      await createTestRequirement(org._id, client._id, client._id, { title: "R1" });
      await createTestRequirement(org._id, client._id, client._id, { title: "R2" });

      const res = await agent()
        .post("/api/client-portal/requirements/list")
        .set("Cookie", cookies);

      expect(res.status).toBe(200);
      expect(res.body.requirements.length).toBe(2);
    });

    it("should filter by status", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      await createTestRequirement(org._id, client._id, client._id, { status: "OPEN" });
      await createTestRequirement(org._id, client._id, client._id, { status: "IN_PROGRESS" });

      const res = await agent()
        .post("/api/client-portal/requirements/list")
        .set("Cookie", cookies)
        .send({ status: "OPEN" });

      expect(res.status).toBe(200);
      expect(res.body.requirements.every((r) => r.status === "OPEN")).toBe(true);
    });

    it("should only show client's own requirements", async () => {
      const { client: c1, cookies: c1Cookies } = await createTestClientWithAuth(org._id, {
        email: "c1@test.com",
      });
      const { client: c2 } = await createTestClientWithAuth(org._id, {
        email: "c2@test.com",
      });

      await createTestRequirement(org._id, c1._id, c1._id, { title: "C1 Req" });
      await createTestRequirement(org._id, c2._id, c2._id, { title: "C2 Req" });

      const res = await agent()
        .post("/api/client-portal/requirements/list")
        .set("Cookie", c1Cookies);

      expect(res.status).toBe(200);
      expect(res.body.requirements.length).toBe(1);
      expect(res.body.requirements[0].title).toBe("C1 Req");
    });
  });

  // ─── Requirement Detail ───
  describe("POST /api/client-portal/requirements/detail", () => {
    it("should return requirement detail", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { requirement } = await createTestRequirement(org._id, client._id, client._id, {
        title: "Detail Req",
      });

      const res = await agent()
        .post("/api/client-portal/requirements/detail")
        .set("Cookie", cookies)
        .send({ requirementId: requirement._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.requirement.title).toBe("Detail Req");
    });

    it("should reject missing requirementId", async () => {
      const { cookies } = await createTestClientWithAuth(org._id);

      const res = await agent()
        .post("/api/client-portal/requirements/detail")
        .set("Cookie", cookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject other client's requirement", async () => {
      const { cookies: c1Cookies } = await createTestClientWithAuth(org._id, {
        email: "c1x@test.com",
      });
      const { client: c2 } = await createTestClientWithAuth(org._id, {
        email: "c2x@test.com",
      });
      const { requirement } = await createTestRequirement(org._id, c2._id, c2._id);

      const res = await agent()
        .post("/api/client-portal/requirements/detail")
        .set("Cookie", c1Cookies)
        .send({ requirementId: requirement._id.toString() });

      expect(res.status).toBe(404);
    });
  });

  // ─── Comment ───
  describe("POST /api/client-portal/requirements/comment", () => {
    it("should add a comment from client", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { requirement } = await createTestRequirement(org._id, client._id, client._id);

      const res = await agent()
        .post("/api/client-portal/requirements/comment")
        .set("Cookie", cookies)
        .send({ requirementId: requirement._id.toString(), message: "Client comment" });

      expect(res.status).toBe(200);
      expect(res.body.comment.message).toBe("Client comment");
      expect(res.body.comment.byType).toBe("client");
    });

    it("should reject missing message", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { requirement } = await createTestRequirement(org._id, client._id, client._id);

      const res = await agent()
        .post("/api/client-portal/requirements/comment")
        .set("Cookie", cookies)
        .send({ requirementId: requirement._id.toString() });

      expect(res.status).toBe(400);
    });
  });

  // ─── Tasks List ───
  describe("POST /api/client-portal/tasks/list", () => {
    it("should list tasks for the client", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      await createTestTask(org._id, client._id, org._id, { title: "T1", status: "SENT_TO_CLIENT" });
      await createTestTask(org._id, client._id, org._id, { title: "T2", status: "DONE" });

      const res = await agent()
        .post("/api/client-portal/tasks/list")
        .set("Cookie", cookies);

      expect(res.status).toBe(200);
      expect(res.body.tasks.length).toBe(2);
    });

    it("should filter by status", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      await createTestTask(org._id, client._id, org._id, { status: "SENT_TO_CLIENT" });
      await createTestTask(org._id, client._id, org._id, { status: "DONE" });

      const res = await agent()
        .post("/api/client-portal/tasks/list")
        .set("Cookie", cookies)
        .send({ statusFilter: "DONE" });

      expect(res.status).toBe(200);
      expect(res.body.tasks.every((t) => t.status === "DONE")).toBe(true);
    });

    it("should include canRespond flag for SENT_TO_CLIENT tasks", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      await createTestTask(org._id, client._id, org._id, { status: "SENT_TO_CLIENT" });

      const res = await agent()
        .post("/api/client-portal/tasks/list")
        .set("Cookie", cookies);

      expect(res.body.tasks[0].canRespond).toBe(true);
    });
  });

  // ─── Task Respond ───
  describe("POST /api/client-portal/tasks/respond", () => {
    it("should approve a task (DONE)", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      const res = await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ taskId: task._id.toString(), decision: "DONE" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("DONE");
    });

    it("should request revision with note", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      const res = await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ taskId: task._id.toString(), decision: "REVISION", note: "Need changes" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("REVISION");
    });

    it("should reject revision without note", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      const res = await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ taskId: task._id.toString(), decision: "REVISION" });

      expect(res.status).toBe(400);
    });

    it("should reject invalid decision", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      const res = await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ taskId: task._id.toString(), decision: "INVALID" });

      expect(res.status).toBe(400);
    });

    it("should reject if task is not SENT_TO_CLIENT", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "TODO",
      });

      const res = await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ taskId: task._id.toString(), decision: "DONE" });

      expect(res.status).toBe(400);
    });

    it("should reject missing taskId", async () => {
      const { cookies } = await createTestClientWithAuth(org._id);

      const res = await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ decision: "DONE" });

      expect(res.status).toBe(400);
    });

    it("should sync requirement status on approval", async () => {
      const { client, cookies } = await createTestClientWithAuth(org._id);
      const { requirement } = await createTestRequirement(org._id, client._id, client._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      // Link task to requirement
      requirement.linkedTaskIds.push(task._id);
      requirement.status = "IN_PROGRESS";
      await requirement.save();

      await agent()
        .post("/api/client-portal/tasks/respond")
        .set("Cookie", cookies)
        .send({ taskId: task._id.toString(), decision: "DONE" });

      const { Requirement } = await import("../models/requirement.model.js");
      const updated = await Requirement.findById(requirement._id);
      expect(updated.status).toBe("COMPLETED");
    });
  });
});

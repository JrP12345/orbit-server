import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestClient, createTestRequirement, createTestTask } from "./helpers.js";
import { Requirement } from "../models/requirement.model.js";

describe("Requirement Routes", () => {
  let org, ownerCookies, client;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
    const c = await createTestClient(org._id);
    client = c.client;
  });

  // ─── List Requirements ───
  describe("POST /api/requirements/list", () => {
    it("should list all requirements", async () => {
      await createTestRequirement(org._id, client._id, org._id, { title: "R1" });
      await createTestRequirement(org._id, client._id, org._id, { title: "R2" });

      const res = await agent()
        .post("/api/requirements/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.requirements.length).toBe(2);
      expect(res.body.total).toBe(2);
    });

    it("should filter by clientId", async () => {
      const { client: c2 } = await createTestClient(org._id, { name: "C2" });
      await createTestRequirement(org._id, client._id, org._id, { title: "R1" });
      await createTestRequirement(org._id, c2._id, org._id, { title: "R2" });

      const res = await agent()
        .post("/api/requirements/list")
        .set("Cookie", ownerCookies)
        .send({ clientId: c2._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.requirements.length).toBe(1);
      expect(res.body.requirements[0].title).toBe("R2");
    });

    it("should filter by status", async () => {
      await createTestRequirement(org._id, client._id, org._id, { status: "OPEN" });
      await createTestRequirement(org._id, client._id, org._id, { status: "IN_PROGRESS" });

      const res = await agent()
        .post("/api/requirements/list")
        .set("Cookie", ownerCookies)
        .send({ status: "OPEN" });

      expect(res.status).toBe(200);
      expect(res.body.requirements.every((r) => r.status === "OPEN")).toBe(true);
    });

    it("should filter by priority", async () => {
      await createTestRequirement(org._id, client._id, org._id, { priority: "HIGH" });
      await createTestRequirement(org._id, client._id, org._id, { priority: "LOW" });

      const res = await agent()
        .post("/api/requirements/list")
        .set("Cookie", ownerCookies)
        .send({ priority: "HIGH" });

      expect(res.status).toBe(200);
      expect(res.body.requirements.every((r) => r.priority === "HIGH")).toBe(true);
    });

    it("should include linked task info", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, { title: "Linked" });
      requirement.linkedTaskIds.push(task._id);
      await requirement.save();

      const res = await agent()
        .post("/api/requirements/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.requirements[0].linkedTasks.length).toBe(1);
      expect(res.body.requirements[0].linkedTasks[0].title).toBe("Linked");
    });
  });

  // ─── Requirement Detail ───
  describe("POST /api/requirements/detail", () => {
    it("should return requirement detail", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id, {
        title: "Detailed Req",
      });

      const res = await agent()
        .post("/api/requirements/detail")
        .set("Cookie", ownerCookies)
        .send({ requirementId: requirement._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.requirement.title).toBe("Detailed Req");
      expect(res.body.requirement.clientName).toBe(client.name);
    });

    it("should reject missing requirementId", async () => {
      const res = await agent()
        .post("/api/requirements/detail")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject non-existent requirement", async () => {
      const res = await agent()
        .post("/api/requirements/detail")
        .set("Cookie", ownerCookies)
        .send({ requirementId: "000000000000000000000000" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Comment ───
  describe("POST /api/requirements/comment", () => {
    it("should add a comment", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/requirements/comment")
        .set("Cookie", ownerCookies)
        .send({ requirementId: requirement._id.toString(), message: "Looking good!" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.comment.message).toBe("Looking good!");

      // Verify in DB
      const updated = await Requirement.findById(requirement._id);
      expect(updated.comments.length).toBe(1);
    });

    it("should reject missing message", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/requirements/comment")
        .set("Cookie", ownerCookies)
        .send({ requirementId: requirement._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject missing requirementId", async () => {
      const res = await agent()
        .post("/api/requirements/comment")
        .set("Cookie", ownerCookies)
        .send({ message: "Hello" });

      expect(res.status).toBe(400);
    });
  });

  // ─── Update Status ───
  describe("POST /api/requirements/update-status", () => {
    it("should update requirement status", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/requirements/update-status")
        .set("Cookie", ownerCookies)
        .send({ requirementId: requirement._id.toString(), status: "IN_PROGRESS" });

      expect(res.status).toBe(200);
      expect(res.body.requirement.status).toBe("IN_PROGRESS");
    });

    it("should reject invalid status", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/requirements/update-status")
        .set("Cookie", ownerCookies)
        .send({ requirementId: requirement._id.toString(), status: "INVALID" });

      expect(res.status).toBe(400);
    });

    it("should reject missing requirementId", async () => {
      const res = await agent()
        .post("/api/requirements/update-status")
        .set("Cookie", ownerCookies)
        .send({ status: "OPEN" });

      expect(res.status).toBe(400);
    });

    it("should reject non-existent requirement", async () => {
      const res = await agent()
        .post("/api/requirements/update-status")
        .set("Cookie", ownerCookies)
        .send({ requirementId: "000000000000000000000000", status: "OPEN" });

      expect(res.status).toBe(404);
    });
  });
});

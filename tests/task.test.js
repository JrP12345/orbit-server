import { describe, it, expect, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestUser, createTestClient, createTestTask, createTestRequirement } from "./helpers.js";
import { Task } from "../models/task.model.js";
import { Requirement } from "../models/requirement.model.js";
import { Role } from "../models/role.model.js";
import { Permission } from "../models/permission.model.js";

describe("Task Routes", () => {
  let org, ownerCookies, client;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    ownerCookies = result.cookies;
    const c = await createTestClient(org._id);
    client = c.client;
  });

  // ─── Create Task ───
  describe("POST /api/tasks", () => {
    it("should create a task", async () => {
      const res = await agent()
        .post("/api/tasks")
        .set("Cookie", ownerCookies)
        .send({
          clientId: client._id.toString(),
          title: "Build homepage",
          description: "Full homepage design",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.task.title).toBe("Build homepage");
      expect(res.body.task.status).toBe("TODO");
    });

    it("should create a task with assignees", async () => {
      const { user } = await createTestUser(org._id);

      const res = await agent()
        .post("/api/tasks")
        .set("Cookie", ownerCookies)
        .send({
          clientId: client._id.toString(),
          title: "Assigned Task",
          assignedTo: [user._id.toString()],
        });

      expect(res.status).toBe(201);
      expect(res.body.task.assignedTo.length).toBe(1);
    });

    it("should link task to a requirement", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks")
        .set("Cookie", ownerCookies)
        .send({
          clientId: client._id.toString(),
          title: "Linked Task",
          requirementId: requirement._id.toString(),
        });

      expect(res.status).toBe(201);

      // Check requirement got linked
      const updated = await Requirement.findById(requirement._id);
      expect(updated.linkedTaskIds.map((id) => id.toString())).toContain(res.body.task.id.toString());
    });

    it("should reject missing clientId", async () => {
      const res = await agent()
        .post("/api/tasks")
        .set("Cookie", ownerCookies)
        .send({ title: "No Client" });

      expect(res.status).toBe(400);
    });

    it("should reject missing title", async () => {
      const res = await agent()
        .post("/api/tasks")
        .set("Cookie", ownerCookies)
        .send({ clientId: client._id.toString() });

      expect(res.status).toBe(400);
    });

    it("should reject non-existent client", async () => {
      const res = await agent()
        .post("/api/tasks")
        .set("Cookie", ownerCookies)
        .send({ clientId: "000000000000000000000000", title: "Ghost" });

      expect(res.status).toBe(404);
    });

    it("should reject unauthenticated request", async () => {
      const res = await agent()
        .post("/api/tasks")
        .send({ clientId: client._id.toString(), title: "Test" });

      expect(res.status).toBe(401);
    });
  });

  // ─── List Tasks ───
  describe("POST /api/tasks/list", () => {
    it("should list all tasks for owner", async () => {
      await createTestTask(org._id, client._id, org._id, { title: "T1" });
      await createTestTask(org._id, client._id, org._id, { title: "T2" });

      const res = await agent()
        .post("/api/tasks/list")
        .set("Cookie", ownerCookies);

      expect(res.status).toBe(200);
      expect(res.body.tasks.length).toBe(2);
      expect(res.body.total).toBe(2);
    });

    it("should filter by status", async () => {
      await createTestTask(org._id, client._id, org._id, { status: "TODO" });
      await createTestTask(org._id, client._id, org._id, { status: "DOING" });

      const res = await agent()
        .post("/api/tasks/list")
        .set("Cookie", ownerCookies)
        .send({ status: "TODO" });

      expect(res.status).toBe(200);
      expect(res.body.tasks.every((t) => t.status === "TODO")).toBe(true);
    });

    it("should filter by clientId", async () => {
      const { client: c2 } = await createTestClient(org._id, { name: "C2" });
      await createTestTask(org._id, client._id, org._id, { title: "C1 Task" });
      await createTestTask(org._id, c2._id, org._id, { title: "C2 Task" });

      const res = await agent()
        .post("/api/tasks/list")
        .set("Cookie", ownerCookies)
        .send({ clientId: c2._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.tasks.length).toBe(1);
      expect(res.body.tasks[0].title).toBe("C2 Task");
    });

    it("should restrict visibility for non-owner users", async () => {
      // Create role with PAGE_TASKS but no TASK_VIEW_ALL
      const permIds = await Permission.find({ key: { $in: ["PAGE_TASKS", "TASK_MOVE_OWN"] } })
        .select("_id")
        .lean();
      const limitedRole = await Role.create({
        organizationId: org._id,
        name: "LIMITED",
        permissions: permIds.map((p) => p._id),
        isSystem: false,
      });

      const { user, cookies } = await createTestUser(org._id, { roleId: limitedRole._id });
      const { user: other } = await createTestUser(org._id);

      // Task assigned to user
      await createTestTask(org._id, client._id, org._id, {
        title: "My Task",
        assignedTo: [user._id],
      });
      // Task assigned to someone else
      await createTestTask(org._id, client._id, org._id, {
        title: "Other Task",
        assignedTo: [other._id],
      });

      const res = await agent()
        .post("/api/tasks/list")
        .set("Cookie", cookies);

      expect(res.status).toBe(200);
      // Should only see own task
      expect(res.body.tasks.length).toBe(1);
      expect(res.body.tasks[0].title).toBe("My Task");
    });
  });

  // ─── Task Detail ───
  describe("POST /api/tasks/detail", () => {
    it("should return task detail", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        title: "Detailed Task",
      });

      const res = await agent()
        .post("/api/tasks/detail")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.task.title).toBe("Detailed Task");
      expect(res.body.task.clientName).toBe(client.name);
    });

    it("should reject missing taskId", async () => {
      const res = await agent()
        .post("/api/tasks/detail")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });

    it("should reject non-existent task", async () => {
      const res = await agent()
        .post("/api/tasks/detail")
        .set("Cookie", ownerCookies)
        .send({ taskId: "000000000000000000000000" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Update Task ───
  describe("POST /api/tasks/update", () => {
    it("should update task title and description", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks/update")
        .set("Cookie", ownerCookies)
        .send({
          taskId: task._id.toString(),
          title: "Updated Title",
          description: "Updated Desc",
        });

      expect(res.status).toBe(200);
      expect(res.body.task.title).toBe("Updated Title");
    });

    it("should reject editing a DONE task", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "DONE",
      });

      const res = await agent()
        .post("/api/tasks/update")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), title: "Edit Done" });

      expect(res.status).toBe(400);
    });

    it("should reject empty title", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks/update")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), title: "   " });

      expect(res.status).toBe(400);
    });
  });

  // ─── Move Task (State Machine) ───
  describe("POST /api/tasks/move", () => {
    it("should move TODO → DOING", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "DOING" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("DOING");
    });

    it("should move DOING → READY_FOR_REVIEW", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "DOING",
      });

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "READY_FOR_REVIEW" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("READY_FOR_REVIEW");
    });

    it("should move READY_FOR_REVIEW → SENT_TO_CLIENT", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "READY_FOR_REVIEW",
      });

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "SENT_TO_CLIENT" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("SENT_TO_CLIENT");
    });

    it("should move SENT_TO_CLIENT → DONE", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "DONE" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("DONE");
    });

    it("should move SENT_TO_CLIENT → REVISION", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "REVISION", note: "Needs fixes" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("REVISION");
    });

    it("should move REVISION → DOING", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "REVISION",
      });

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "DOING" });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe("DOING");
    });

    it("should reject invalid transition (TODO → DONE)", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "DONE" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot move/i);
    });

    it("should reject moving DONE task (terminal)", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "DONE",
      });

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "TODO" });

      expect(res.status).toBe(400);
    });

    it("should record history on move", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "DOING", note: "Starting work" });

      const res = await agent()
        .post("/api/tasks/detail")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString() });

      expect(res.body.task.history.length).toBe(1);
      expect(res.body.task.history[0].from).toBe("TODO");
      expect(res.body.task.history[0].to).toBe("DOING");
      expect(res.body.task.history[0].note).toBe("Starting work");
    });

    it("should sync requirement status when task moves to DONE", async () => {
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);
      const { task } = await createTestTask(org._id, client._id, org._id, {
        status: "SENT_TO_CLIENT",
      });

      // Link task to requirement
      requirement.linkedTaskIds.push(task._id);
      requirement.status = "IN_PROGRESS";
      await requirement.save();

      await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "DONE" });

      const updated = await Requirement.findById(requirement._id);
      expect(updated.status).toBe("COMPLETED");
    });

    it("should reject missing taskId", async () => {
      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ status: "DOING" });

      expect(res.status).toBe(400);
    });

    it("should reject invalid status", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks/move")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString(), status: "INVALID" });

      expect(res.status).toBe(400);
    });
  });

  // ─── Delete Task ───
  describe("POST /api/tasks/delete", () => {
    it("should delete a task", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);

      const res = await agent()
        .post("/api/tasks/delete")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const found = await Task.findById(task._id);
      expect(found).toBeNull();
    });

    it("should unlink task from requirements on delete", async () => {
      const { task } = await createTestTask(org._id, client._id, org._id);
      const { requirement } = await createTestRequirement(org._id, client._id, org._id);
      requirement.linkedTaskIds.push(task._id);
      await requirement.save();

      await agent()
        .post("/api/tasks/delete")
        .set("Cookie", ownerCookies)
        .send({ taskId: task._id.toString() });

      const updated = await Requirement.findById(requirement._id);
      expect(updated.linkedTaskIds.map((id) => id.toString())).not.toContain(task._id.toString());
    });

    it("should reject non-existent task", async () => {
      const res = await agent()
        .post("/api/tasks/delete")
        .set("Cookie", ownerCookies)
        .send({ taskId: "000000000000000000000000" });

      expect(res.status).toBe(404);
    });

    it("should reject missing taskId", async () => {
      const res = await agent()
        .post("/api/tasks/delete")
        .set("Cookie", ownerCookies)
        .send({});

      expect(res.status).toBe(400);
    });
  });
});

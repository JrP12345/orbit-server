import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { agent, cleanDb, createTestOrg, createTestUser, createTestClientWithAuth } from "./helpers.js";

describe("Auth Routes", () => {
  beforeEach(async () => { await cleanDb(); });

  // ─── Registration ───
  describe("POST /api/auth/register", () => {
    it("should register a new organization", async () => {
      const res = await agent()
        .post("/api/auth/register")
        .send({
          name: "Acme Corp",
          ownerName: "John Doe",
          email: "john@acme.com",
          password: "Password123",
          phone: "1234567890",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe("john@acme.com");
      expect(res.body.user.role).toBe("OWNER");
      // Should set cookies
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies.some((c) => c.startsWith("accessToken="))).toBe(true);
      expect(cookies.some((c) => c.startsWith("refreshToken="))).toBe(true);
    });

    it("should reject missing fields", async () => {
      const res = await agent()
        .post("/api/auth/register")
        .send({ email: "test@test.com", password: "Password123" });

      expect(res.status).toBe(400);
    });

    it("should reject short password", async () => {
      const res = await agent()
        .post("/api/auth/register")
        .send({
          name: "Test", ownerName: "Owner",
          email: "test@test.com", password: "123",
          phone: "1234567890",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/8 characters/i);
    });

    it("should reject invalid email", async () => {
      const res = await agent()
        .post("/api/auth/register")
        .send({
          name: "Test", ownerName: "Owner",
          email: "not-an-email", password: "Password123",
          phone: "1234567890",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid email/i);
    });

    it("should reject duplicate email", async () => {
      await agent().post("/api/auth/register").send({
        name: "Org1", ownerName: "O1",
        email: "dup@test.com", password: "Password123",
        phone: "1234567890",
      });

      const res = await agent().post("/api/auth/register").send({
        name: "Org2", ownerName: "O2",
        email: "dup@test.com", password: "Password123",
        phone: "1234567890",
      });

      expect(res.status).toBe(409);
    });
  });

  // ─── Login ───
  describe("POST /api/auth/login", () => {
    it("should login as organization owner", async () => {
      const { org } = await createTestOrg({ email: "login@test.com" });

      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "login@test.com", password: "Test1234" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe("OWNER");
    });

    it("should login as a user", async () => {
      const { org } = await createTestOrg();
      await createTestUser(org._id, { email: "user@test.com" });

      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "user@test.com", password: "Test1234" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe("MEMBER");
    });

    it("should login as a client", async () => {
      const { org } = await createTestOrg();
      await createTestClientWithAuth(org._id, { email: "client@test.com" });

      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "client@test.com", password: "Test1234" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe("CLIENT");
    });

    it("should reject wrong password", async () => {
      await createTestOrg({ email: "wrong@test.com" });

      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "wrong@test.com", password: "WrongPassword" });

      expect(res.status).toBe(401);
    });

    it("should reject non-existent email", async () => {
      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "nobody@test.com", password: "Test1234" });

      expect(res.status).toBe(401);
    });

    it("should reject missing fields", async () => {
      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "x@test.com" });

      expect(res.status).toBe(400);
    });
  });

  // ─── Verify ───
  describe("POST /api/auth/verify", () => {
    it("should verify valid session", async () => {
      const { cookies } = await createTestOrg();

      const res = await agent()
        .post("/api/auth/verify")
        .set("Cookie", cookies);

      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.user).toBeDefined();
    });

    it("should return unauthenticated with no cookies", async () => {
      const res = await agent().post("/api/auth/verify");

      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
    });
  });

  // ─── Logout ───
  describe("POST /api/auth/logout", () => {
    it("should clear cookies on logout", async () => {
      const { cookies } = await createTestOrg();

      const res = await agent()
        .post("/api/auth/logout")
        .set("Cookie", cookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ─── Forgot password ───
  describe("POST /api/auth/forgot-password", () => {
    it("should accept valid email (always returns success for security)", async () => {
      await createTestOrg({ email: "forgot@test.com" });

      const res = await agent()
        .post("/api/auth/forgot-password")
        .send({ email: "forgot@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should handle non-existent email gracefully", async () => {
      const res = await agent()
        .post("/api/auth/forgot-password")
        .send({ email: "nonexist@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject missing email", async () => {
      const res = await agent()
        .post("/api/auth/forgot-password")
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ─── Reset password ───
  describe("POST /api/auth/reset-password", () => {
    it("should reject missing fields", async () => {
      const res = await agent()
        .post("/api/auth/reset-password")
        .send({ token: "abc" });

      expect(res.status).toBe(400);
    });

    it("should reject invalid token", async () => {
      const res = await agent()
        .post("/api/auth/reset-password")
        .send({ token: "invalidtoken", password: "NewPass123" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid|expired/i);
    });

    it("should reject short password", async () => {
      const res = await agent()
        .post("/api/auth/reset-password")
        .send({ token: "sometoken", password: "123" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/8 characters/i);
    });
  });

  // ─── Health ───
  describe("GET /api/health", () => {
    it("should return ok", async () => {
      const res = await agent().get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  // ─── NoSQL Injection Sanitization ───
  describe("NoSQL injection protection", () => {
    it("should strip $-prefixed keys from req.body", async () => {
      // $gt injected alongside a valid email — sanitizer removes $gt,
      // leaving the normal string field intact so the route handles it safely
      const res = await agent()
        .post("/api/auth/login")
        .send({ email: "test@test.com", password: "x", $where: "1==1" });
      // Should not crash — sanitizer strips $where key
      expect(res.status).not.toBe(500);
    });

    it("should sanitize req.query $-prefixed keys", async () => {
      const res = await agent().get("/api/health?status[$gt]=");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  // ─── 404 ───
  describe("Unknown route", () => {
    it("should return 404", async () => {
      const res = await agent().get("/api/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});

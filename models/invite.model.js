import mongoose from "mongoose";

const inviteSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ["MEMBER"], default: "MEMBER" },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ["PENDING", "ACCEPTED", "REVOKED"], default: "PENDING" },
    acceptedAt: { type: Date, default: null },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", default: null },
  },
  { timestamps: true }
);

inviteSchema.index({ token: 1 });
inviteSchema.index({ organizationId: 1, status: 1 });
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const Invite = mongoose.model("Invite", inviteSchema);

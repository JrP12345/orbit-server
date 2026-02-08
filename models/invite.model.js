import mongoose from "mongoose";

const inviteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ["MEMBER"],
      default: "MEMBER",
    },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "REVOKED"],
      default: "PENDING",
    },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Invite = mongoose.model("Invite", inviteSchema);

import mongoose from "mongoose";

const clientSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    contactName: { type: String, trim: true, default: "" },
    email: { type: String, lowercase: true, trim: true, default: null },
    password: { type: String, default: null },
    status: { type: String, enum: ["ACTIVE", "INVITED", "ARCHIVED"], default: "ACTIVE" },
    privateKey: { type: String, default: null },
    publicKey: { type: String, default: null },
    refreshToken: { type: String, default: null },
    refreshTokenExpires: { type: Date, default: null },
    rememberMe: { type: Boolean, default: false },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
    inviteToken: { type: String, default: null },
    inviteExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

clientSchema.index({ organizationId: 1, status: 1 });
clientSchema.index({ email: 1 }, { unique: true, sparse: true });

export const Client = mongoose.model("Client", clientSchema);

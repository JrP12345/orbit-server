import mongoose from "mongoose";

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true },
    address: { type: String, trim: true },
    phone: { type: String, required: true, trim: true },
    country: { type: String, trim: true, default: "" },
    businessEmail: { type: String, trim: true, lowercase: true, default: "" },
    website: { type: String, trim: true, default: "" },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
    refreshToken: { type: String, default: null },
    refreshTokenExpires: { type: Date, default: null },
    rememberMe: { type: Boolean, default: false },
    privateKey: { type: String, required: true },
    publicKey: { type: String, required: true },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Organization = mongoose.model("Organization", organizationSchema);

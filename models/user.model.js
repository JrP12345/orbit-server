import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["OWNER", "MEMBER"],
      default: "MEMBER",
    },
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

export const User = mongoose.model("User", userSchema);

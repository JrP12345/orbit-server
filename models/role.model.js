import mongoose from "mongoose";

const roleSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    permissions: [{ type: mongoose.Schema.Types.ObjectId, ref: "Permission" }],
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

roleSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export const Role = mongoose.model("Role", roleSchema);

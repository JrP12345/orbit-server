import mongoose from "mongoose";

const permissionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, uppercase: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    group: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

export const Permission = mongoose.model("Permission", permissionSchema);

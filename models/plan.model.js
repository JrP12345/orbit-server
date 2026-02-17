import mongoose from "mongoose";

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, uppercase: true, trim: true },
    maxClients: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

export const Plan = mongoose.model("Plan", planSchema);

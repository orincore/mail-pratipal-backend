import mongoose from "mongoose";
import { config } from "../config";

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) {
    return;
  }

  if (!config.mongodbUri) {
    throw new Error("MONGODB_URI is not defined in the environment config.");
  }

  try {
    await mongoose.connect(config.mongodbUri, {
      bufferCommands: false,
    });
    console.log("MongoDB connected successfully to Standalone Mail Backend");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

import dotenv from "dotenv";

if (process.env.INTEGRATION_MODE !== "true") {
  dotenv.config();
}

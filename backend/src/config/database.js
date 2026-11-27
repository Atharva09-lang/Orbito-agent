import pg from "pg";
import "./environment.js";
import { validateIntegrationEnvironment } from "./integration-env.js";
validateIntegrationEnvironment();
const { Pool } = pg;
const requiresVerifiedSsl =
    process.env.INTEGRATION_MODE === "true" ||
    process.env.NODE_ENV === "production";
const pool = new Pool({
    connectionString: process.env.DATABASE_URL_POOLED,
    ssl: requiresVerifiedSsl ? { rejectUnauthorized: true } : false,
});
export default pool;
import pg from "pg";
import "./environment.js";
import { getIntegrationDatabaseConfig } from "./integration-env.js";
const { Pool } = pg;
const integrationConfig = process.env.INTEGRATION_MODE === "true"
    ? getIntegrationDatabaseConfig()
    : null;
const requiresVerifiedSsl =
    process.env.NODE_ENV === "production";
const pool = new Pool(integrationConfig ?? {
    connectionString: process.env.DATABASE_URL_POOLED,
    ssl: requiresVerifiedSsl ? { rejectUnauthorized: true } : false,
});
export default pool;
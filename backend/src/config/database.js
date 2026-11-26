import pg from "pg";
import "./environment.js";
import { validateIntegrationEnvironment } from "./integration-env.js";
validateIntegrationEnvironment();
const { Pool } = pg;
const isProduction = process.env.NODE_ENV === "production";
const pool = new Pool({
    connectionString: process.env.DATABASE_URL_POOLED,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
});
export default pool;
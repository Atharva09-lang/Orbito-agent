import "dotenv/config";
import app from "./app.js";
import pool from "./config/database.js";

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);

    pool.query("SELECT 1").catch((error) => {
        console.error("Database warm-up failed:", error.message);
    });
});
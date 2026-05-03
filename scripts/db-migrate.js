require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

async function migrate() {
    let dbPassword = process.env.DB_PASSWORD;
    const region = process.env.AWS_REGION || 'us-west-2';

    if (dbPassword && dbPassword.startsWith('arn:aws:secretsmanager:')) {
        process.env.DB_SECRET_NAME = dbPassword;
        dbPassword = null;
    } else if (dbPassword && dbPassword.startsWith('{')) {
        try {
            const parsed = JSON.parse(dbPassword);
            dbPassword = parsed.password || dbPassword;
        } catch (e) {}
    }

    if (!dbPassword && process.env.DB_SECRET_NAME) {
        const smClient = new SecretsManagerClient({ region });
        try {
            const secretData = await smClient.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_NAME }));
            if (secretData.SecretString) {
                const secret = JSON.parse(secretData.SecretString);
                dbPassword = secret.password;
            }
        } catch (err) {
            console.error("Failed to retrieve DB secret:", err);
        }
    }

    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'stockmaster_prod',
        user: process.env.DB_USER || 'stockmaster_admin',
        password: dbPassword,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        console.log("Starting database migration...");
        const sqlPath = path.join(__dirname, '..', 'migrations', '001_initial_schema.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await pool.query(sql);
        console.log("Migration completed successfully.");
    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();

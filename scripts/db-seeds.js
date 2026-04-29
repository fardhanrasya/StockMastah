require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

async function seed() {
    let dbPassword = process.env.DB_PASSWORD;
    const region = process.env.AWS_REGION || 'us-west-2';

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
    });

    try {
        console.log("Seeding database...");
        // Insert admin user
        const hashedPassword = await bcrypt.hash('admin123', 10);
        await pool.query(`
            INSERT INTO users (username, password_hash, role) 
            VALUES ('admin', $1, 'ADMIN')
            ON CONFLICT (username) DO NOTHING
        `, [hashedPassword]);
        
        console.log("Seeding completed successfully.");
    } catch (err) {
        console.error("Seeding failed:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

seed();

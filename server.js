require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: '/uploads/' }); // Using EFS mount point for uploads

// AWS SDK Clients
const region = process.env.AWS_REGION || 'us-west-2';
const ddbClient = new DynamoDBClient({ region });
const snsClient = new SNSClient({ region });
const sqsClient = new SQSClient({ region });
const smClient = new SecretsManagerClient({ region });

let pool;

// Initialize Database Connection
async function initDB() {
    let dbPassword = process.env.DB_PASSWORD;
    
    if (dbPassword && dbPassword.startsWith('arn:aws:secretsmanager:')) {
        process.env.DB_SECRET_NAME = dbPassword;
        dbPassword = null;
    } else if (dbPassword && dbPassword.startsWith('{')) {
        try {
            const parsed = JSON.parse(dbPassword);
            dbPassword = parsed.password || dbPassword;
        } catch (e) {}
    }

    // Attempt to get password from Secrets Manager if DB_PASSWORD is not set directly
    if (!dbPassword && process.env.DB_SECRET_NAME) {
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

    pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'stockmaster_prod',
        user: process.env.DB_USER || 'stockmaster_admin',
        password: dbPassword,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        ssl: {
            rejectUnauthorized: false
        }
    });
}

// Audit Logging to DynamoDB
async function logAudit(action, details) {
    try {
        const timestamp = Date.now();
        const auditId = `audit-${timestamp}-${Math.floor(Math.random() * 1000)}`;
        
        await ddbClient.send(new PutItemCommand({
            TableName: process.env.DYNAMODB_TABLE || 'stockmaster-audit-log',
            Item: {
                'auditId': { S: auditId },
                'timestamp': { N: timestamp.toString() },
                'action': { S: action },
                'details': { S: JSON.stringify(details) }
            }
        }));
    } catch (err) {
        console.error("Failed to log audit:", err);
    }
}

// Send Alert to SNS
async function sendAlert(subject, message) {
    try {
        await snsClient.send(new PublishCommand({
            TopicArn: process.env.SNS_TOPIC_ARN,
            Subject: subject,
            Message: message
        }));
    } catch (err) {
        console.error("Failed to send SNS alert:", err);
    }
}

// Send background task to SQS
async function sendToQueue(message) {
    try {
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: process.env.SQS_QUEUE_URL,
            MessageBody: JSON.stringify(message)
        }));
    } catch (err) {
        console.error("Failed to send SQS message:", err);
    }
}

// Middleware: Authentication
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecret');
            req.user = decoded;
            next();
        } catch (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    } else {
        res.status(401).json({ error: 'Authorization header missing' });
    }
};

// --- API Endpoints ---

// Health Check
app.get('/health', async (req, res) => {
    let dbStatus = 'disconnected';
    try {
        if (pool) {
            const res = await pool.query('SELECT 1');
            if (res.rowCount === 1) dbStatus = 'connected';
        }
    } catch (err) {
        dbStatus = 'error';
    }
    res.json({
        status: 'ok',
        version: '1.0.0',
        database: dbStatus,
        timestamp: new Date().toISOString()
    });
});

// Users
app.post('/api/users/register', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
            [username, hashedPassword, role || 'USER']
        );
        await logAudit('USER_REGISTER', { username, role });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        
        if (user && await bcrypt.compare(password, user.password_hash)) {
            const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '24h' });
            await logAudit('USER_LOGIN', { username });
            res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Products
app.get('/api/products', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products', authenticate, upload.single('image'), async (req, res) => {
    try {
        const { name, description, price, category_id, min_stock_level } = req.body;
        const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
        const result = await pool.query(
            'INSERT INTO products (name, description, price, category_id, min_stock_level, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [name, description, price, category_id, min_stock_level, imagePath]
        );
        await logAudit('PRODUCT_CREATED', { productId: result.rows[0].id });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stock Adjustments
app.post('/api/stock/adjust', authenticate, async (req, res) => {
    try {
        const { product_id, quantity, type, notes } = req.body;
        const result = await pool.query(
            'INSERT INTO stock_history (product_id, quantity, type, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [product_id, quantity, type, notes, req.user.id]
        );
        
        await sendToQueue({ action: 'UPDATE_INVENTORY', payload: result.rows[0] });
        await logAudit('STOCK_ADJUSTMENT', { productId: product_id, quantity, type });
        
        if (type === 'OUT' && quantity > 100) {
            await sendAlert('Large Stock Outward', `A large stock outward of ${quantity} occurred for product ${product_id}.`);
        }
        
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Other endpoints are mocked to return success
const createMockEndpoint = (path, method) => {
    app[method](path, authenticate, (req, res) => {
        res.json({ message: `Mock ${method.toUpperCase()} ${path} successful` });
    });
};

createMockEndpoint('/api/products/:id', 'get');
createMockEndpoint('/api/products/:id', 'put');
createMockEndpoint('/api/products/:id', 'delete');
createMockEndpoint('/api/stock/history', 'get');
createMockEndpoint('/api/categories', 'get');
createMockEndpoint('/api/categories', 'post');
createMockEndpoint('/api/categories/:id', 'put');
createMockEndpoint('/api/categories/:id', 'delete');
createMockEndpoint('/api/suppliers', 'get');
createMockEndpoint('/api/suppliers', 'post');
createMockEndpoint('/api/suppliers/:id', 'put');
createMockEndpoint('/api/suppliers/:id', 'delete');
createMockEndpoint('/api/purchase-orders', 'get');
createMockEndpoint('/api/purchase-orders', 'post');
createMockEndpoint('/api/purchase-orders/:id', 'get');
createMockEndpoint('/api/purchase-orders/:id/status', 'put');
createMockEndpoint('/api/reports/inventory', 'get');


// Start Server
const PORT = process.env.PORT || 8080;
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`StockMaster Server running on port ${PORT}`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
});

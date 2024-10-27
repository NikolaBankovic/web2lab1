import express from 'express';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { auth, requiresAuth } from 'express-openid-connect';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.set("views", path.join(__dirname, "views"));
app.set('view engine', 'pug');

const externalUrl = process.env.RENDER_EXTERNAL_URL;
const port = externalUrl && process.env.PORT ? parseInt(process.env.PORT) : 4080;

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: true
});

const config = {
    authRequired: false,
    idpLogout: true,
    secret: process.env.SECRET,
    baseURL: externalUrl || `https://localhost:${port}`,
    clientID: process.env.CLIENT_ID,
    issuerBaseURL: process.env.ISSUER_BASE_URL,
    clientSecret: process.env.CLIENT_SECRET,
    authorizationParams: {
        response_type: 'code',
    },
};


app.use(auth(config));
app.use(express.urlencoded({ extended: true }));

app.get('/', async (req, res) => {
    try {
        const totalQRsQuery = 'SELECT COUNT(*) FROM qrs';
        const totalQRsResult = await pool.query(totalQRsQuery);
        const totalQRs = totalQRsResult.rows[0].count;


        res.render('index', {
            totalQRs,
            isAuthenticated: req.oidc.isAuthenticated()
        });
    } catch (error) {
        console.error("Error fetching total QRs:", error);
        res.status(500).send("Server error");
    }
});

app.get('/qr/:id', requiresAuth(), async (req: any, res: any) => {
    const qrId = req.params.id;

    try {
        const qrQuery = 'SELECT * FROM qrs WHERE id = $1';
        const qrResult = await pool.query(qrQuery, [qrId]);

        let username = req.oidc.isAuthenticated() ? (req.oidc.user?.name ?? req.oidc.user?.sub) : null;

        if (qrResult.rows.length === 0) {
            return res.status(404).send("QR code not found.");
        }

        const qr = qrResult.rows[0];

        res.render('qr-details', {
            username,
            id: qr.id,
            vatin: qr.vatin,
            firstName: qr.first_name,
            lastName: qr.last_name,
            createdAt: qr.created_at
        });
    } catch (error) {
        console.error("Error fetching qr details:", error);
        res.status(500).send("Server error");
    }
});

app.get('/generate-qr', requiresAuth(), (req, res) => {
    res.render('generate-qr');
});

app.post('/generate-qr', requiresAuth(), async (req: any, res: any) => {
    interface QRRequestBody {
        vatin: string;
        firstName: string;
        lastName: string;
    }

    const { vatin, firstName, lastName }: QRRequestBody = req.body;
    if (!vatin || !firstName || !lastName) {
        return res.status(400).json({ error: "Missing 'vatin', 'firstName', or 'lastName' in request body." });
    }

    try {
        const countQuery = 'SELECT COUNT(*) FROM qrs WHERE vatin = $1';
        const countResult = await pool.query(countQuery, [vatin]);
        const qrCount = parseInt(countResult.rows[0].count);

        if (qrCount >= 3) {
            return res.status(400).json({ error: "QR code limit reached for this VATIN. You can generate maximum 3 QR codes per VATIN)." });
        }

        const id = uuidv4();
        const created_at = new Date();

        const insertQuery = `
            INSERT INTO qrs (id, vatin, first_name, last_name, created_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        await pool.query(insertQuery, [id, vatin, firstName, lastName, created_at]);
        const qrUrl = `${process.env.BASE_URL}/qr/${id}`;
        const qrCode = await QRCode.toDataURL(qrUrl);

        res.render('qr-img', {
            qrCode
        });
    } catch (error) {
        console.error("Error generating qr code:", error);
        res.status(500).json({ error: "Server error while generating qr code." });
    }
});

if (externalUrl) {
    const hostname = '0.0.0.0';
    app.listen(port, hostname, () => {
        console.log(`Server locally running at http://${hostname}:${port}/ and from
outside on ${externalUrl}`);
    });
}
else {
    https.createServer({
        key: fs.readFileSync('server.key'),
        cert: fs.readFileSync('server.cert')
    }, app)
        .listen(port, function () {
            console.log(`Server running at https://localhost:${port}/`);
        });
}
// https.createServer({
//     key: fs.readFileSync('/etc/secrets/server.key'),
//     cert: fs.readFileSync('/etc/secrets/server.cert'),
//     passphrase: process.env.CERT_PASSPHRASE
// }, app).listen(portnumber, host, () => {
//     console.log(`Server running at https://localhost:${port}/`);
// });

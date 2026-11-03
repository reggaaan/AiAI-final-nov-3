import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import db from './db.js';
import { validateStreamInput } from './lib/stream-input.js';

dotenv.config();

const requiredEnv = ['GEMINI_API_KEY', 'JWT_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes long.');
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_TTL = '30m';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.startsWith('/login') || req.path.startsWith('/chat')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || '';
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_MODEL = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

function runDb(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getRetryDelayMs(err) {
  const rawDelay = err?.errorDetails?.find((detail) => detail?.retryDelay)?.retryDelay;
  if (typeof rawDelay === 'string') {
    const match = rawDelay.match(/(\d+(?:\.\d+)?)s/);
    if (match) return Number(match[1]) * 1000;
    const matchMs = rawDelay.match(/(\d+(?:\.\d+)?)ms/);
    if (matchMs) return Number(matchMs[1]);
  }

  if (err?.status === 429) return 45000;
  if (err?.status === 503) return 1500;
  return 0;
}

function generateTaglishTitle(prompt) {
  const rawPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!rawPrompt) return 'Bagong Chikahan';

  const cleanedPrompt = rawPrompt
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();

  const words = cleanedPrompt.split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return 'Bagong Chikahan';

  const titleWords = words.map((word, index) => {
    const normalized = word.toLowerCase();
    if (index === 0) return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return normalized;
  });

  if (titleWords.length < 3) {
    titleWords.push('tayo');
    titleWords.push('chikahan');
  }

  return titleWords.slice(0, 5).join(' ');
}

// Custom System Instruction for Ai-Ai Delas Alas Persona
const AIAI_SYSTEM_INSTRUCTION = `
You are "Ai-Ai", an interactive full-stack Taglish workspace assistant inspired by Filipino comedy queen Ai-Ai delas Alas (notably her iconic character Ina Montecillo from "Ang Tanging Ina").

CORE PERSONALITY & TONE GUIDELINES:
1. Speak naturally in energetic, warm, and expressive Taglish (Filipino-English code-switching).
2. Maintain a comedy-queen, motherly vibe ("Ang Tanging AI Assistant Mo!"). Warm, supportive, and enthusiastic toward the user.
3. Use iconic catchphrases and modified proverbs where appropriate (e.g., "Ang taong nagigipit, sa Ai-Ai kumakapit!", "Kung kaya ng iba... ipagawa mo kay Ai-Ai!", "Aray ko po!", "Goooolive!").
4. Refer to the user warmly as "anak", "mommish", "kababayan", or "kapamilya".
5. EVEN WHILE BEING HUMOROUS AND ENERGETIC, ALWAYS BE SMART, PRECISE, AND ACCURATE. Provide detailed, well-structured answers using clean markdown formatting (bold text, lists, code blocks).
6. Multimodal Vision: When presented with images, describe or analyze them thoroughly while maintaining your Taglish persona.
`;

const AIAI_UNAVAILABLE_COMMENTS = [
  "Aray ko po, anak! Super traffic sa linya ngayon at tila nagpapalit pa ng outfit si Gemini server sa backstage! 'Ang taong nagigipit, sa Ai-Ai kumakapit'—kaya wait ka lang ng ilang segundo at subukan natin ulit, go, go, go!",
  "Naku, mommish! May konting aberya sa ating signal at naputol ang ating chikahan! Pahinga muna tayo nang konti, tapos i-click mo lang ulit ang send button para makapag-Goooolive tayo ulit!",
  "Aray ko po, kababayan! High demand ang lola mo ngayon kaya medyo napagod ang system! Subukan mo ulit mag-message paglipas ng 10 seconds, handa ulit ako makipag-chikahan!"
];

// Middleware: Authenticate JWT Token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized access' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ================= AUTH ROUTES =================

// Register Route
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const sql = `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`;

  db.run(sql, [username, email, hashedPassword], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Username or Email already exists.' });
      }
      console.error('Failed to register user:', err);
      return res.status(500).json({ error: 'Unable to create account.' });
    }

    const token = jwt.sign({ id: this.lastID, username, email }, JWT_SECRET, { expiresIn: SESSION_TTL });
    res.json({ token, username, userId: this.lastID, expiresIn: SESSION_TTL });
  });
});

// Login Route
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }

  const sql = `SELECT * FROM users WHERE username = ? OR email = ?`;
  db.get(sql, [username, username], async (err, user) => {
    if (err) {
      console.error('Failed to look up login user:', err);
      return res.status(500).json({ error: 'Unable to sign in right now.' });
    }
    if (!user) return res.status(400).json({ error: 'Invalid username/email or password.' });

    let validPassword;
    try {
      validPassword = await bcrypt.compare(password, user.password);
    } catch (compareErr) {
      console.error('Failed to verify login password:', compareErr);
      return res.status(500).json({ error: 'Unable to sign in right now.' });
    }
    if (!validPassword) return res.status(400).json({ error: 'Invalid username/email or password.' });

    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: SESSION_TTL });
    res.json({ token, username: user.username, userId: user.id, expiresIn: SESSION_TTL });
  });
});

// ================= AUTH SESSION ROUTES =================

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email
    },
    expiresIn: SESSION_TTL
  });
});

// ================= CHAT ROUTES =================

// Get all chat threads for logged-in user
app.get('/api/chats', authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM chats WHERE user_id = ? ORDER BY created_at DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Create a new chat thread
app.post('/api/chats', authenticateToken, (req, res) => {
  const { title } = req.body;
  const chatTitle = title || 'Bagong Chikahan';

  db.run(
    `INSERT INTO chats (user_id, title) VALUES (?, ?)`,
    [req.user.id, chatTitle],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, title: chatTitle });
    }
  );
});

// Update/Rename a Chat Title
app.put('/api/chats/:id', authenticateToken, (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  db.run(
    `UPDATE chats SET title = ? WHERE id = ? AND user_id = ?`,
    [title, req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, title });
    }
  );
});

// Delete a Chat Thread & Its Messages
app.delete('/api/chats/:id', authenticateToken, (req, res) => {
  db.run(
    `DELETE FROM chats WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run(`DELETE FROM messages WHERE chat_id = ?`, [req.params.id]);
      res.json({ success: true });
    }
  );
});

// Get messages for a specific chat thread
app.get('/api/chats/:id/messages', authenticateToken, (req, res) => {
  db.all(
    `SELECT messages.*
     FROM messages
     JOIN chats ON chats.id = messages.chat_id
     WHERE messages.chat_id = ? AND chats.user_id = ?
     ORDER BY messages.created_at ASC`,
    [req.params.id, req.user.id],
    (err, rows) => {
      if (err) {
        console.error('Failed to load chat messages:', err);
        return res.status(500).json({ error: 'Unable to load chat messages.' });
      }
      res.json(rows);
    }
  );
});

// ================= GEMINI STREAMING ROUTE =================

app.post('/api/chats/:id/stream', authenticateToken, async (req, res) => {
  const chatId = req.params.id;
  const { prompt, imageBase64, mimeType } = req.body;
  const inputError = validateStreamInput({ prompt, imageBase64, mimeType });
  if (inputError) {
    return res.status(inputError.status).json({
      error: inputError.error,
      code: inputError.code
    });
  }

  db.get(
    `SELECT id, title FROM chats WHERE id = ? AND user_id = ?`,
    [chatId, req.user.id],
    async (chatErr, chat) => {
      if (chatErr) {
        console.error(`[Chat ${chatId}] Chat lookup failed:`, chatErr);
        return res.status(500).json({
          error: 'Failed to verify chat.',
          code: 'CHAT_LOOKUP_FAILED'
        });
      }

      if (!chat) {
        return res.status(404).json({
          error: 'Chat not found.',
          code: 'CHAT_NOT_FOUND'
        });
      }

      try {
        if (chat.title === 'Bagong Chikahan') {
          const autoTitle = generateTaglishTitle(prompt || 'Image Chat');
          await runDb(
            `UPDATE chats SET title = ? WHERE id = ? AND user_id = ?`,
            [autoTitle, chatId, req.user.id]
          );
        }

        await runDb(
          `INSERT INTO messages (chat_id, sender, content, image_data) VALUES (?, 'user', ?, ?)`,
          [chatId, prompt || '[Uploaded Image]', imageBase64 || null]
        );
      } catch (dbErr) {
        console.error(`[Chat ${chatId}] Failed to save incoming message:`, dbErr);
        return res.status(500).json({
          error: 'Unable to save your message. Please try again.',
          code: 'MESSAGE_SAVE_FAILED'
        });
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let clientConnected = true;
      let streamFinished = false;

      const markClientDisconnected = () => {
        if (!clientConnected) return;
        clientConnected = false;
        if (!streamFinished) {
          console.log(`[Chat ${chatId}] Client disconnected before stream completed.`);
        }
      };

      req.on('aborted', markClientDisconnected);
      res.on('close', markClientDisconnected);

      const sendSSE = (payload) => {
        if (!clientConnected || res.writableEnded) {
          return false;
        }

        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          return true;
        } catch (writeErr) {
          clientConnected = false;
          console.warn(`[Chat ${chatId}] Failed to write SSE data:`, writeErr.message);
          return false;
        }
      };

      try {
        const contents = [];
        if (imageBase64) {
          contents.push({
            inlineData: {
              data: imageBase64.replace(/^data:image\/[^;]+;base64,/, ''),
              mimeType
            }
          });
        }
        contents.push(prompt || 'Ano ang masasabi mo dito sa litratong ito?');

        const modelName = GEMINI_MODEL;
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: AIAI_SYSTEM_INSTRUCTION
        });

        let result;

        try {
          result = await model.generateContentStream(contents);
        } catch (err) {
          const status = err?.status;
          console.error(`[Gemini ${modelName}] Initial request failed:`, err?.message || err);

          if (status === 429) {
            if (clientConnected) {
              sendSSE({
                error: 'Gemini quota has been reached for this API key. Please try again later or configure another Gemini API key.',
                code: 'GEMINI_QUOTA'
              });
            }
            return;
          }

          if (status === 503 && clientConnected) {
            const waitMs = getRetryDelayMs(err) || 1500;
            sendSSE({
              status: 'retrying',
              label: `Gemini is temporarily busy. Retrying in ${Math.ceil(waitMs / 1000)}s...`
            });
            await delay(waitMs);

            if (!clientConnected) return;

            try {
              result = await model.generateContentStream(contents);
            } catch (retryErr) {
              console.error(`[Gemini ${modelName}] Retry failed:`, retryErr?.message || retryErr);
              if (retryErr?.status === 429) {
                sendSSE({
                  error: 'Gemini quota has been reached for this API key. Please try again later or configure another Gemini API key.',
                  code: 'GEMINI_QUOTA'
                });
                return;
              }

              sendSSE({
                error: 'Gemini is temporarily unavailable. Please try again shortly.',
                code: 'GEMINI_UNAVAILABLE'
              });
              return;
            }
          } else {
            throw err;
          }
        }

        if (!result) {
          throw new Error('Gemini did not return a streaming response.');
        }

        let fullResponse = '';
        for await (const chunk of result.stream) {
          if (!clientConnected) {
            console.log(`[Chat ${chatId}] Stream abandoned because client disconnected.`);
            return;
          }

          let chunkText = '';
          try {
            chunkText = chunk.text();
          } catch (chunkErr) {
            console.error(`[Chat ${chatId}] Failed to read Gemini chunk:`, chunkErr);
            continue;
          }

          if (!chunkText) continue;

          fullResponse += chunkText;
          sendSSE({ text: chunkText });
        }

        if (clientConnected && fullResponse) {
          await runDb(
            `INSERT INTO messages (chat_id, sender, content) VALUES (?, 'ai', ?)`,
            [chatId, fullResponse]
          );

          sendSSE({ done: true });
        }

        streamFinished = true;
      } catch (err) {
        console.error(`[Chat ${chatId}] Streaming Error:`, err?.message || err);

        if (!clientConnected) return;

        const status = err?.status;

        if (status === 429) {
          sendSSE({
            error: 'Gemini quota has been reached for this API key. Please try again later or configure another Gemini API key.',
            code: 'GEMINI_QUOTA'
          });
          return;
        }

        if (status === 503) {
          sendSSE({
            error: 'Gemini is temporarily unavailable. Please try again shortly.',
            code: 'GEMINI_UNAVAILABLE'
          });
          return;
        }

        sendSSE({
          error: AIAI_UNAVAILABLE_COMMENTS[Math.floor(Math.random() * AIAI_UNAVAILABLE_COMMENTS.length)],
          code: 'STREAMING_ERROR'
        });
      } finally {
        streamFinished = true;
        if (!res.writableEnded) {
          res.end();
        }
      }
    }
  );
});

app.use((err, _req, res, _next) => {
  const status = err.status === 413 ? 413 : 500;
  if (status === 413) {
    return res.status(status).json({ error: 'Request body is too large.' });
  }
  console.error('Unhandled request error:', err);
  return res.status(status).json({ error: 'An unexpected server error occurred.' });
});

app.listen(PORT, () => {
  console.log(`Ai-Ai Workspace Server listening on port ${PORT}`);
});
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS - Cho phép mọi origin (vì app desktop)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(bodyParser.json());

// Database path - Railway sẽ lưu persistent
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Connected to SQLite database');
  }
});

// Initialize database
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT 'New Chat',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);



  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
});

// Get user settings
app.get('/api/settings/:userId', (req, res) => {
  const { userId } = req.params;
  db.get('SELECT openai_api_key FROM user_settings WHERE user_id = ?', [userId], (err, settings) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    res.json(settings || { openai_api_key: null });
  });
});

// Save user settings
app.post('/api/settings', (req, res) => {
  const { userId, openai_api_key } = req.body;

  db.run(
    'INSERT OR REPLACE INTO user_settings (user_id, openai_api_key, updated_at) VALUES (?, ?, datetime("now"))',
    [userId, openai_api_key],
    (err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json({ success: true });
    }
  );
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Math Chatbot API Server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
          }
          return res.status(500).json({ error: 'Server error' });
        }
        res.json({ success: true, userId: this.lastID });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      success: true,
      userId: user.id,
      username: user.username
    });
  });
});

// Get conversations
app.get('/api/conversations/:userId', (req, res) => {
  const { userId } = req.params;
  db.all(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
    (err, conversations) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json(conversations);
    }
  );
});

// Create conversation
app.post('/api/conversations', (req, res) => {
  const { userId, title } = req.body;
  db.run(
    'INSERT INTO conversations (user_id, title) VALUES (?, ?)',
    [userId, title || 'New Chat'],
    function(err) {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json({ success: true, conversationId: this.lastID });
    }
  );
});

// Get messages
app.get('/api/messages/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  db.all(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId],
    (err, messages) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json(messages);
    }
  );
});

// Save message
app.post('/api/messages', (req, res) => {
  const { conversationId, role, content } = req.body;
  db.run(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, role, content],
    function(err) {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json({ success: true, messageId: this.lastID });
    }
  );
});

// Delete conversation
app.delete('/api/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;

  db.serialize(() => {
    db.run('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
    db.run('DELETE FROM conversations WHERE id = ?', [conversationId], (err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json({ success: true });
    });
  });
});

// Update conversation title
app.put('/api/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const { title } = req.body;

  db.run(
    'UPDATE conversations SET title = ? WHERE id = ?',
    [title, conversationId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      res.json({ success: true });
    }
  );
});

// Graceful shutdown
process.on('SIGTERM', () => {
  db.close((err) => {
    if (err) console.error(err.message);
    console.log('Database connection closed');
    process.exit(0);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Math Chatbot API Server Started');
  console.log(`📡 Server: http://0.0.0.0:${PORT}`);
  console.log(`💾 Database: ${dbPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

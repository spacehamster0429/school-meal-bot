// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'users.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

const restrictDbFilePermissions = () => {
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!fs.existsSync(filePath)) continue;

    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      console.warn(`Could not restrict ${path.basename(filePath)} permissions:`, error.message);
    }
  }
};

const journalMode = db.pragma('journal_mode = WAL', { simple: true });
if (String(journalMode).toLowerCase() !== 'wal') {
  console.warn(`SQLite WAL mode was not enabled. Current journal_mode: ${journalMode}`);
}
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
restrictDbFilePermissions();

// Create the users table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    office_code TEXT NOT NULL,
    school_code TEXT NOT NULL,
    school_name TEXT NOT NULL
  )
`);
restrictDbFilePermissions();

const isSnowflake = (value) => /^\d{15,25}$/.test(String(value ?? ''));
const isValidCode = (value) => /^[A-Z0-9]+$/i.test(String(value ?? ''));
const normalizeSchoolName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const getUser = (userId) => {
  if (!isSnowflake(userId)) return null;

  const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
  return stmt.get(userId);
};

const saveUser = (userId, officeCode, schoolCode, schoolName) => {
  const normalizedSchoolName = normalizeSchoolName(schoolName);

  if (!isSnowflake(userId) || !isValidCode(officeCode) || !isValidCode(schoolCode) || !normalizedSchoolName) {
    throw new Error('Invalid user or school data');
  }

  const stmt = db.prepare(`
    INSERT INTO users (user_id, office_code, school_code, school_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      office_code = excluded.office_code,
      school_code = excluded.school_code,
      school_name = excluded.school_name
  `);
  stmt.run(userId, officeCode, schoolCode, normalizedSchoolName);
  restrictDbFilePermissions();
};

module.exports = {
  db,
  getUser,
  saveUser,
};

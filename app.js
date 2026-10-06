import express from "express";
import crypto from "node:crypto";

export function createApp(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      balance INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      amount INTEGER NOT NULL
    );
    -- La clé primaire garantit l'unicité : c'est elle qui fait le travail
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL
    );
    INSERT OR IGNORE INTO accounts (id, balance) VALUES (1, 1000);
  `);

  const app = express();
  app.use(express.json());

  const debit = (accountId, amount) => {
    db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(amount, accountId);
    const { lastInsertRowid } = db
      .prepare("INSERT INTO payments (account_id, amount) VALUES (?, ?)")
      .run(accountId, amount);
    return { paymentId: Number(lastInsertRowid), amount };
  };

  // ❌ NON idempotent : chaque appel débite à nouveau
  app.post("/naive/payments", (req, res) => {
    const { accountId, amount } = req.body;
    res.status(201).json(debit(accountId, amount));
  });

  // ✅ Idempotent grâce à l'en-tête Idempotency-Key
  app.post("/payments", (req, res) => {
    const key = req.get("Idempotency-Key");
    if (!key) return res.status(400).json({ error: "Idempotency-Key requis" });

    const { accountId, amount } = req.body;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({ accountId, amount })).digest("hex");

    // Tout dans une transaction : débit + enregistrement de la clé sont atomiques.
    const run = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(key);

      if (existing) {
        // Même clé, payload différent = bug côté client → on refuse
        if (existing.request_hash !== requestHash) {
          return { status: 422, body: { error: "Clé déjà utilisée avec une requête différente" } };
        }
        // Rejeu : on renvoie la réponse d'origine SANS ré-exécuter l'effet
        return { status: existing.status_code, body: JSON.parse(existing.response_body), replayed: true };
      }

      const body = debit(accountId, amount);
      db.prepare(
        "INSERT INTO idempotency_keys (key, request_hash, status_code, response_body) VALUES (?, ?, ?, ?)"
      ).run(key, requestHash, 201, JSON.stringify(body));
      return { status: 201, body };
    });

    const { status, body, replayed } = run();
    if (replayed) res.set("Idempotent-Replayed", "true");
    res.status(status).json(body);
  });

  // Naturellement idempotents : PUT (état cible) et DELETE
  app.put("/accounts/:id/balance", (req, res) => {
    db.prepare("UPDATE accounts SET balance = ? WHERE id = ?").run(req.body.balance, req.params.id);
    res.json({ balance: req.body.balance });
  });

  app.get("/accounts/:id", (req, res) => {
    res.json(db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id));
  });

  app.get("/payments", (req, res) => {
    res.json(db.prepare("SELECT * FROM payments").all());
  });

  app.get("/idempotency-keys", (req, res) => {
    res.json(db.prepare("SELECT * FROM idempotency_keys").all());
  });

  app.get("/accounts", (req, res) => {
    res.json(db.prepare("SELECT * FROM accounts").all());
  });

  return app;
}
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import request from "supertest";
import { createApp } from "./app.js";

let db, app;

// Base en mémoire neuve pour chaque test : compte n°1 à 1000 €
beforeEach(() => {
  db = new Database(":memory:");
  app = createApp(db);
});

const balance = () => db.prepare("SELECT balance FROM accounts WHERE id = 1").get().balance;
const paymentCount = () => db.prepare("SELECT COUNT(*) AS n FROM payments").get().n;

test("PROBLÈME : sans clé, un retry réseau débite deux fois", async () => {
  const payload = { accountId: 1, amount: 100 };

  await request(app).post("/naive/payments").send(payload); // réponse perdue côté client…
  await request(app).post("/naive/payments").send(payload); // …le client retente

  assert.equal(paymentCount(), 2);
  assert.equal(balance(), 800); // 💥 débité 200 au lieu de 100
});

test("SOLUTION : même Idempotency-Key = un seul débit", async () => {
  const payload = { accountId: 1, amount: 100 };

  const r1 = await request(app).post("/payments").set("Idempotency-Key", "abc-123").send(payload);
  const r2 = await request(app).post("/payments").set("Idempotency-Key", "abc-123").send(payload);

  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.body, r1.body); // même réponse exacte
  assert.equal(r2.headers["idempotent-replayed"], "true");
  assert.equal(paymentCount(), 1);
  assert.equal(balance(), 900); // ✅ débité une seule fois
});

test("des clés différentes = des opérations distinctes", async () => {
  const payload = { accountId: 1, amount: 100 };

  await request(app).post("/payments").set("Idempotency-Key", "k1").send(payload);
  await request(app).post("/payments").set("Idempotency-Key", "k2").send(payload);

  assert.equal(balance(), 800); // deux paiements voulus, deux débits
});

test("même clé avec un payload différent est rejetée (422)", async () => {
  await request(app).post("/payments").set("Idempotency-Key", "abc").send({ accountId: 1, amount: 100 });
  const r = await request(app).post("/payments").set("Idempotency-Key", "abc").send({ accountId: 1, amount: 999 });

  assert.equal(r.status, 422);
  assert.equal(balance(), 900); // le 2e montant n'a jamais été appliqué
});

test("requêtes simultanées avec la même clé : un seul débit", async () => {
  const payload = { accountId: 1, amount: 100 };

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(app).post("/payments").set("Idempotency-Key", "race").send(payload)
    )
  );

  assert.ok(results.every((r) => r.status === 201));
  assert.equal(new Set(results.map((r) => r.body.paymentId)).size, 1); // même paiement partout
  assert.equal(balance(), 900);
});

test("sans Idempotency-Key, l'endpoint sécurisé refuse (400)", async () => {
  const r = await request(app).post("/payments").send({ accountId: 1, amount: 100 });
  assert.equal(r.status, 400);
});

test("PUT est idempotent par nature : répéter ne change rien", async () => {
  await request(app).put("/accounts/1/balance").send({ balance: 500 });
  await request(app).put("/accounts/1/balance").send({ balance: 500 });
  await request(app).put("/accounts/1/balance").send({ balance: 500 });

  assert.equal(balance(), 500);
});
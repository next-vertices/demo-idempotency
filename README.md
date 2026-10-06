# demo-idempotency

Exemple minimal d'**idempotence** pour une API HTTP : Express + SQLite, avec des tests qui montrent le problème, la solution et ses garde-fous.

> Un retry réseau ne doit jamais débiter deux fois un client.

## Le problème

Un client envoie `POST /payments`, le serveur traite la requête, mais la réponse se perd en route. Le client ne sait pas si le paiement est passé : il réessaie. Sans protection, le paiement est exécuté deux fois.

## La solution

Le client génère une **clé d'idempotence** unique par opération et l'envoie dans l'en-tête `Idempotency-Key`. Le serveur :

1. regarde si cette clé a déjà été vue ;
2. si oui, renvoie la **réponse d'origine** sans refaire l'opération ;
3. sinon, exécute l'opération et mémorise la clé et la réponse, **dans la même transaction**.

Le débit, la trace du paiement et l'enregistrement de la clé sont atomiques : en cas d'erreur ou de crash, tout est annulé et le retry repart proprement.

## Démarrage rapide

Prérequis : Node.js 20 ou supérieur.

```bash
npm install
npm test        # lance les tests (node:test + supertest, base SQLite en mémoire)
npm start       # serveur sur http://localhost:3000 (base demo.db)
```

## Endpoints

| Méthode | Route | Idempotent ? | Rôle |
|---|---|---|---|
| `POST` | `/naive/payments` | Non | Version naïve : chaque appel débite. Sert à démontrer le bug. |
| `POST` | `/payments` | Oui (via `Idempotency-Key`) | Version sécurisée. |
| `PUT` | `/accounts/:id/balance` | Oui, par nature | Fixe un état cible : répéter ne change rien. |
| `GET` | `/accounts/:id` | Oui | Lecture. |

Exemple :

```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: abc-123" \
  -d '{"accountId": 1, "amount": 100}'
```

Rejouer exactement la même commande renvoie la même réponse, avec l'en-tête `Idempotent-Replayed: true`, et le compte n'est débité qu'une fois.

## Ce que démontrent les tests

| Test | Ce qu'il prouve |
|---|---|
| Sans clé, un retry débite deux fois | Le problème (solde 800 au lieu de 900) |
| Même `Idempotency-Key` | Un seul débit, même réponse rejouée |
| Clés différentes | Des opérations distinctes restent distinctes |
| Même clé, payload différent | Rejet en `422` (bug côté client) |
| 5 requêtes simultanées, même clé | Un seul débit, un seul `paymentId` |
| Pas de clé | Rejet en `400` |
| `PUT` répété | Idempotent par nature |

## Structure

```
app.js        # API Express + schéma SQLite (createApp(db))
server.js     # démarre le serveur sur demo.db
app.test.js   # tests
```

`createApp(db)` reçoit la base en paramètre : les tests utilisent une base `:memory:` neuve avant chaque test.

## Limites de cette démo

- **SQLite est synchrone** avec une seule connexion : la concurrence est donc sérialisée, et le test des requêtes simultanées passe « facilement ». Sur une base réseau (PostgreSQL), le bon pattern est d'insérer la clé en premier avec `INSERT ... ON CONFLICT DO NOTHING` et de s'appuyer sur la contrainte `PRIMARY KEY`.
- **Pas d'expiration** des clés : en production, prévoir un TTL (24 à 48 h en général).
- **Pas de gestion d'une requête « en cours »** : un client qui retente pendant que la première requête s'exécute encore devrait recevoir un `409` ou attendre.
- Avec plusieurs serveurs applicatifs ou des réplicas en lecture, toute la logique de la clé doit passer par la base **primaire**.

## Contributions

Ce dépôt est une démo pour illustrer un article : les pull requests ne sont pas acceptées.

## Licence

MIT

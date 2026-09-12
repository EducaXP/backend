import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { testStore } from "./support.js";
import { migrations } from "../src/migrations.js";
import { importSQLite } from "../src/import-sqlite.js";
import { readDatabaseUrl } from "../src/config.js";
import { Store } from "../src/db.js";

test("importador preserva IDs, credenciais, produção, avaliação, XP e recibos; recusa repetir", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "educaxp-import-"));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("educaxp-import-"));
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "legacy.db");
  const source = new DatabaseSync(path);
  source.exec(
    migrations[0]! + " PRAGMA user_version=1; PRAGMA foreign_keys=ON;",
  );
  source.exec(`INSERT INTO schools VALUES('school','Fictícia');
  INSERT INTO users(id,school_id,role,name,login,password_hash) VALUES('teacher','school','teacher','Docente','docente','hash-preservado'),('student','school','student','Aluno','aluno','hash-pin-preservado');
  INSERT INTO sessions VALUES('hash-token','teacher',1900000000000);
  INSERT INTO classrooms(id,school_id,teacher_id,name,join_code) VALUES('class','school','teacher','9A','CODE');
  INSERT INTO memberships VALUES('class','student','aluno');
  INSERT INTO groups VALUES('group','class','Equipe');
  INSERT INTO group_members VALUES('group','class','student','Investigar');
  INSERT INTO missions(id,classroom_id,status,content,created_at) VALUES('mission','class','published','{"title":"Teste"}','2026-09-12');
  INSERT INTO submissions VALUES('submission','mission','group',1,'{"answers":[{"questionId":"q1","text":"Nossa evidência"}]}','2026-09-12');
  INSERT INTO submission_revisions VALUES('submission',1,'{"evidence":"histórico"}','student','2026-09-12');
  INSERT INTO evaluations VALUES('evaluation','submission',1,'teacher','Feedback','[]','2026-09-12');
  INSERT INTO rewards VALUES('student','mission',100,'Participação','2026-09-12');
  INSERT INTO help_requests VALUES('help','group','Dúvida',NULL,'2026-09-12',NULL);
  INSERT INTO operations VALUES('student','operation','fingerprint','{"replayed":false}','2026-09-12');`);
  source.close();
  const db = await testStore();
  t.after(() => db.close());
  const counts = await importSQLite(path, db);
  assert.equal(counts.users, 2);
  assert.equal(Object.keys(counts).length, 14);
  assert.equal(
    (
      await db.get<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id=$1",
        "teacher",
      )
    )?.password_hash,
    "hash-preservado",
  );
  assert.equal(
    (await db.get<{ expires_at: number }>("SELECT expires_at FROM sessions"))
      ?.expires_at,
    1900000000000,
  );
  assert.match(
    (await db.get<{ content: string }>("SELECT content FROM submissions"))!
      .content,
    /Nossa evidência/,
  );
  assert.equal(
    (
      await db.get<{ fingerprint: string }>(
        "SELECT fingerprint FROM operations",
      )
    )?.fingerprint,
    "fingerprint",
  );
  assert.equal(
    (await db.get<{ xp: number }>("SELECT xp FROM rewards"))?.xp,
    100,
  );
  await assert.rejects(importSQLite(path, db), /vazio/);
  assert.equal(
    (await db.get<{ n: number }>("SELECT count(*) n FROM users"))?.n,
    2,
  );
  const empty = await testStore();
  t.after(() => empty.close());
  const invalid = new DatabaseSync(path);
  invalid.exec("UPDATE users SET eco_mode='invalid'");
  invalid.close();
  await assert.rejects(importSQLite(path, empty));
  assert.equal(
    (await empty.get<{ n: number }>("SELECT count(*) n FROM schools"))?.n,
    0,
  );
});

test("transações usam uma conexão por contexto e adaptador aceita resultado múltiplo de pg", async () => {
  let seq = 0;
  const events: string[] = [];
  const db = new Store({
    async connect() {
      const id = ++seq;
      return {
        release() {
          events.push("release:" + id);
        },
        async query(sql) {
          events.push(id + ":" + sql);
          return { rows: [{ n: "1" }], rowCount: 1 };
        },
      };
    },
    async end() {},
  });
  await db.transaction(async () => {
    await db.get("SELECT 1");
    await db.run("INSERT");
  });
  assert.equal(seq, 1);
  assert.equal(events[0], "1:BEGIN");
  assert.ok(events.includes("1:COMMIT"));
  assert.equal(events.at(-1), "release:1");
  await assert.rejects(
    db.transaction(async () => {
      throw new Error("failure");
    }),
  );
  assert.ok(events.includes("2:ROLLBACK"));
  const multiple = new Store({
    async connect() {
      return {
        release() {},
        async query() {
          return [
            { rows: [], rowCount: null },
            { rows: [{ n: "2" }], rowCount: 1 },
          ] as never;
        },
      };
    },
    async end() {},
  });
  assert.equal((await multiple.get<{ n: number }>("SELECT 1; SELECT 2"))?.n, 2);
});

test("configuração exige PostgreSQL e não revela credenciais em erros", () => {
  for (const DATABASE_URL of [
    "",
    "sqlite:private.db",
    "postgres://user:secret@host/",
  ])
    assert.throws(
      () => readDatabaseUrl({ DATABASE_URL }),
      (e) => e instanceof Error && !e.message.includes("secret"),
    );
  assert.equal(
    readDatabaseUrl({ DATABASE_URL: "postgres://user:secret@host/db" }),
    "postgres://user:secret@host/db",
  );
});

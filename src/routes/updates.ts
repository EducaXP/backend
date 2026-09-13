import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import { authentication } from "../auth.js";
import { digest } from "../auth.js";
import type { Store } from "../db.js";
const sources = {
  classrooms:
    "SELECT id,name,paused,join_code FROM allowed_classes ORDER BY id",
  members:
    "SELECT m.classroom_id,m.user_id,m.alias,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.classroom_id IN (SELECT id FROM allowed_classes) AND ($3='teacher' OR m.user_id=$1) ORDER BY m.classroom_id,m.user_id",
  groups: "SELECT id,name FROM allowed_groups ORDER BY id",
  roles:
    "SELECT group_id,user_id,role FROM group_members WHERE group_id IN (SELECT id FROM allowed_groups) ORDER BY group_id,user_id",
  missions: "SELECT id,status,version FROM allowed_missions ORDER BY id",
  submissions: "SELECT id,version FROM allowed_submissions ORDER BY id",
  evaluations:
    "SELECT id FROM evaluations WHERE submission_id IN (SELECT id FROM allowed_submissions) ORDER BY id",
  help: "SELECT id,resolved_at FROM help_requests WHERE group_id IN (SELECT id FROM allowed_groups) ORDER BY id",
  focus:
    "SELECT mission_id,group_id FROM focus_records WHERE group_id IN (SELECT id FROM allowed_groups) ORDER BY mission_id,group_id",
  rewards:
    "SELECT mission_id,xp FROM rewards WHERE user_id=$1 ORDER BY mission_id",
  focus_rewards:
    "SELECT mission_id,xp FROM focus_rewards WHERE user_id=$1 ORDER BY mission_id",
  avatar: "SELECT avatar_item,eco_mode FROM users WHERE id=$1",
};
const fields = Object.entries(sources)
  .map(
    ([name, sql]) =>
      "'" +
      name +
      "',(SELECT coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) FROM (" +
      sql +
      ") v)",
  )
  .join(",");
const query =
  `WITH allowed_classes AS (
  SELECT c.* FROM classrooms c WHERE c.school_id=$2 AND (c.teacher_id=$1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.classroom_id=c.id AND m.user_id=$1))
), allowed_groups AS (
  SELECT g.* FROM groups g WHERE g.classroom_id IN (SELECT id FROM allowed_classes) AND ($3='teacher' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$1))
), allowed_missions AS (
  SELECT id,status,version FROM missions WHERE classroom_id IN (SELECT id FROM allowed_classes) AND ($3='teacher' OR status<>'draft')
), allowed_submissions AS (
  SELECT id,version FROM submissions WHERE mission_id IN (SELECT id FROM allowed_missions) AND group_id IN (SELECT id FROM allowed_groups)
) SELECT jsonb_build_object(` +
  fields +
  `) AS state`;
export async function updateRoutes(app: FastifyInstance, db: Store) {
  const listeners = new Set<() => void>(),
    closers = new Set<() => void>();
  let ready = false,
    stopped = false,
    release: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    attempts = 0;
  function lost() {
    if (stopped || timer) return;
    ready = false;
    for (const close of [...closers]) close();
    timer = setTimeout(
      () => {
        timer = undefined;
        void start();
      },
      Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)),
    );
    timer.unref();
  }
  async function start() {
    await release?.();
    release = undefined;
    try {
      const stop = await db.listenChanges(() => {
        for (const notify of listeners) notify();
      }, lost);
      if (stopped) {
        await stop();
        return;
      }
      release = stop;
      ready = true;
      attempts = 0;
    } catch {
      lost();
    }
  }
  await start();
  app.addHook("preClose", async () => {
    stopped = true;
    ready = false;
    clearTimeout(timer);
    for (const close of [...closers]) close();
    await release?.();
  });
  const counts = new Map<string, number>();
  app.get(
    "/events",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (req) => digest(req.headers.authorization || req.ip),
        },
      },
    },
    async (req, reply) => {
      if (!ready)
        return reply
          .header("Retry-After", "2")
          .code(503)
          .send({
            error: {
              code: "LIVE_UNAVAILABLE",
              message: "O canal de atualizações está reconectando.",
            },
          });
      const userId = req.user.id;
      if ((counts.get(userId) || 0) >= 4)
        return reply
          .header("Retry-After", "10")
          .code(429)
          .send({
            error: {
              code: "LIVE_LIMIT",
              message: "Há muitos acessos simultâneos para este perfil.",
            },
          });
      counts.set(userId, (counts.get(userId) || 0) + 1);
      const stream = new PassThrough();
      let closed = false,
        checking = false,
        dirty = false,
        previous = "";
      let heartbeat: ReturnType<typeof setInterval>;
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        listeners.delete(notify);
        closers.delete(close);
        const count = (counts.get(userId) || 1) - 1;
        if (count) counts.set(userId, count);
        else counts.delete(userId);
        stream.end();
      }
      function write(frame: string) {
        if (!closed && !stream.write(frame)) close();
      }
      async function check() {
        if (checking || closed) return;
        checking = true;
        try {
          do {
            dirty = false;
            await authentication(db)(req);
            if (closed) return;
            const state = await db.get(
              query,
              req.user.id,
              req.user.school_id,
              req.user.role,
            );
            const revision = digest(JSON.stringify(state));
            if (revision !== previous) {
              previous = revision;
              write(
                "event: update\ndata: " + JSON.stringify({ revision }) + "\n\n",
              );
            }
          } while (dirty && !closed);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 401)
            write("event: reauthenticate\ndata: {}\n\n");
          close();
        } finally {
          checking = false;
        }
      }
      function notify() {
        dirty = true;
        void check();
      }
      listeners.add(notify);
      closers.add(close);
      reply.raw.on("close", close);
      stream.on("close", close);
      // Heartbeats keep proxies alive and validate session expiry; they do not poll application data.
      heartbeat = setInterval(() => {
        void authentication(db)(req)
          .then(() => write(": heartbeat\n\n"))
          .catch(() => {
            write("event: reauthenticate\ndata: {}\n\n");
            close();
          });
      }, 20000);
      heartbeat.unref();
      reply
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-store, no-transform")
        .header("X-Accel-Buffering", "no");
      write(": connected\n\n");
      notify();
      return reply.send(stream);
    },
  );
  // Compatibility with already installed PWAs; current clients subscribe to /events.
  app.get(
    "/updates",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: (req) => digest(req.headers.authorization || req.ip),
        },
      },
    },
    async (req) => {
      const state = await db.get(
        query,
        req.user.id,
        req.user.school_id,
        req.user.role,
      );
      return { revision: digest(JSON.stringify(state)), intervalMs: 5000 };
    },
  );
}

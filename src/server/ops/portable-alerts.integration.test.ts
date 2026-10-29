import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const library = path.join(process.cwd(), "ops/lib/portable-backup.sh");
function emit(command: string, env: Record<string, string> = {}) {
  const result = spawnSync("sh", ["-c", `. "${library}"; ${command}`], { encoding: "utf8", env: { ...process.env, ...env } });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
async function executeRestore(client: Client, sql: string) {
  const source = sql.replace(/^\\set.*\n/gm, "");
  const copies = /COPY pg_temp\.portable_rows \(payload\) FROM STDIN WITH \(FORMAT csv\);\n([\s\S]*?)\\\.\n/g;
  let offset = 0;
  for (const copy of source.matchAll(copies)) {
    await client.query(source.slice(offset, copy.index));
    for (const row of copy[1].trim().split("\n").filter(Boolean)) {
      await client.query("INSERT INTO pg_temp.portable_rows(payload) VALUES ($1)", [row.slice(1, -1)]);
    }
    offset = copy.index! + copy[0].length;
  }
  await client.query(source.slice(offset));
}

describe.skipIf(!controlUrl)("portable alert SQL against PostgreSQL", () => {
  it("round-trips referenced instruments and history paused, without channels, queues or caches; v3 stays empty", async () => {
    const control = new Client({ connectionString: controlUrl });
    const name = `fitgrid_portable_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(controlUrl!);
    target.pathname = `/${name}`;
    const db = new Client({ connectionString: target.href });
    const root = await mkdtemp(path.join(tmpdir(), "fitgrid-alert-sql-"));
    await control.connect();
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      await db.connect();
      for (const migration of (await readdir("prisma/migrations")).sort().filter((value) => /^\d/.test(value))) {
        await db.query(await readFile(path.join("prisma/migrations", migration, "migration.sql"), "utf8"));
      }
      const owner = randomUUID(), instrument = randomUUID(), unused = randomUUID(), rule = randomUUID(), event = randomUUID(), outbox = randomUUID();
      await db.query("INSERT INTO users(id,name,email,updated_at) VALUES ($1,'测试, 名称', 'portable@test.invalid',now())", [owner]);
      await db.query("INSERT INTO sessions(id,expires_at,token,updated_at,user_id) VALUES ($1,now()+interval '1 day','portable-token',now(),$2)", [randomUUID(),owner]);
      await db.query("INSERT INTO market_instruments(id,code,name,market,currency,kind,yahoo) VALUES ($1,'SPY.US','SPY','us','USD','etf','SPY'),($2,'QQQ.US','QQQ','us','USD','etf','QQQ')", [instrument,unused]);
      await db.query(`INSERT INTO price_alerts(id,owner_id,instrument_id,condition,enabled,armed,cursor,active_from,continuity_degraded,last_error,last_success,last_evaluation,updated_at)
        VALUES ($1,$2,$3,'{"kind":"price","direction":"up","targetPrice":"100"}',true,false,now(),now()-interval '1 day',true,'old error',now(),'{"price":"100"}',now())`, [rule,owner,instrument]);
      await db.query("INSERT INTO price_alert_channels(owner_id,key_cipher,updated_at) VALUES ($1,'never-export-this-secret',now())", [owner]);
      await db.query("INSERT INTO price_alert_outbox(id,owner_id,rule_id,version,channel_version,batch_end,payload,expires_at) VALUES($1,$2,$3,1,1,now(),'{\"secret\":\"never-export-pending\"}',now()+interval '1 day')", [outbox,owner,rule]);
      await db.query("INSERT INTO price_alert_events(id,owner_id,rule_id,version,minute_start,minute_end,price,threshold,ma,provider,evidence,outbox_id) VALUES($1,$2,$3,1,now()-interval '1 minute',now(),100.123456789,100,NULL,'yahoo','{\"nested\":\"保留\\n历史\"}',$4)", [event,owner,rule,outbox]);
      const exported = emit("portable_export_sql");
      const copies = [...exported.matchAll(/\\echo __FITGRID_PORTABLE_V3_([A-Z_]+)__\nCOPY \(\n([\s\S]*?)\n\) TO STDOUT WITH \(FORMAT csv, FORCE_QUOTE \*\);/g)];
      expect(copies).toHaveLength(10);
      for (const copy of copies) {
        const rows = (await db.query(copy[2])).rows as { payload: string }[];
        await writeFile(path.join(root, `${copy[1].toLowerCase()}.csv`), rows.map((row) => `"${row.payload}"\n`).join(""));
      }
      expect((await readFile(path.join(root, "market_instruments.csv"), "utf8")).trim().split("\n")).toHaveLength(1);
      expect(exported).not.toContain("FROM public.price_alert_channels");
      expect(exported).not.toContain("FROM public.price_alert_outbox");
      const clean = () => db.query("TRUNCATE users,market_instruments,market_scans CASCADE");
      await clean();
      const before = Date.now();
      await executeRestore(db, emit('portable_emit_restore_sql "$PAYLOAD"', { PAYLOAD: root }));
      const restored = (await db.query("SELECT * FROM price_alerts WHERE id=$1", [rule])).rows[0];
      expect(restored).toMatchObject({ enabled: false, armed: true, cursor: null, continuity_degraded: false, last_error: null, last_success: null, last_evaluation: null, condition: { kind: "price", direction: "up", targetPrice: "100" } });
      expect(restored.active_from.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const history = (await db.query("SELECT * FROM price_alert_events WHERE id=$1", [event])).rows[0];
      expect(history).toMatchObject({ price: "100.1234567890", threshold: "100.0000000000", outbox_id: null, evidence: { nested: "保留\n历史" } });
      for (const table of ["price_alert_channels", "price_alert_outbox", "market_minutes", "market_daily_bases", "market_scans"]) expect((await db.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count).toBe("0");
      const legacy = await mkdtemp(path.join(tmpdir(), "fitgrid-v3-sql-"));
      for (const copy of copies.slice(0, 7)) await writeFile(path.join(legacy, `${copy[1].toLowerCase()}.csv`), await readFile(path.join(root, `${copy[1].toLowerCase()}.csv`)));
      await clean();
      await executeRestore(db, emit('portable_emit_restore_sql "$PAYLOAD"', { PAYLOAD: legacy }));
      expect((await db.query("SELECT COUNT(*) FROM users")).rows[0].count).toBe("1");
      for (const table of ["price_alerts", "price_alert_events", "market_instruments"]) expect((await db.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count).toBe("0");
    } finally {
      await db.end();
      await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    }
  }, 30000);
});

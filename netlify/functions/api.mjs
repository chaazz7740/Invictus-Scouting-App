import { getStore } from "@netlify/blobs";

const COLS = ["events", "teams", "matches", "notes"];
const IDOK = /^[A-Za-z0-9_.\-]{1,200}$/;
const SKU = /^RE-[A-Z0-9]+-\d{2}-\d{4}$/;
const BASE = { 1: 0, 2: 1000, 6: 2000, 3: 3000, 4: 4000, 5: 5000 };
const PRE = { 1: "P", 2: "Q", 3: "QF", 4: "SF", 5: "F", 6: "R16-" };
const RE = "https://events.vex.com/api/v2";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const same = (a, b) => {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

async function re(p) {
  const key = Netlify.env.get("ROBOTEVENTS_KEY");
  if (!key) throw new Error("ROBOTEVENTS_KEY is not set in Netlify");
  const r = await fetch(RE + p, { headers: { Authorization: "Bearer " + key, Accept: "application/json" } });
  if (!r.ok) throw new Error("RobotEvents said " + r.status);
  return r.json();
}
async function all(p) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await re(p + (p.includes("?") ? "&" : "?") + "per_page=250&page=" + page);
    out.push(...(j.data || []));
    if (!j.meta || page >= j.meta.last_page) break;
  }
  return out;
}

async function matchDocs(eid, reid, divs) {
  const docs = [];
  for (const d of divs) {
    const ms = await all(`/events/${reid}/divisions/${d}/matches`);
    for (const m of ms) {
      const al = (c) => (m.alliances || []).find((a) => a.color === c);
      const tm = (a) => ((a && a.teams) || []).map((t) => t.team && (t.team.name || t.team.code)).filter(Boolean);
      const r = m.round, n = m.matchnum;
      const label = r === 1 || r === 2 ? PRE[r] + n : r === 5 ? "F" + n : (PRE[r] || "M") + m.instance + "-" + n;
      docs.push([`matches/${eid}_${d}_${r}_${m.instance}_${n}`, {
        eventId: eid, label, order: (BASE[r] ?? 9000) + (m.instance || 0) * 100 + n,
        red: tm(al("red")), blue: tm(al("blue")),
        rs: m.scored && al("red") ? al("red").score : null, bs: m.scored && al("blue") ? al("blue").score : null,
      }]);
    }
  }
  return docs;
}

export default async (req) => {
  const CODE = Netlify.env.get("TEAM_CODE");
  if (!CODE || !same(req.headers.get("x-code"), CODE)) return json({ error: "Wrong code" }, 401);
  const store = getStore({ name: "scout", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/^\/api/, "");
  const bump = () => store.setJSON("_v", { v: Date.now() });

  try {
    if (path === "/login") return json({ ok: true });

    if (path === "/version") {
      const x = await store.get("_v", { type: "json" });
      return json({ v: x ? x.v : 0 });
    }

    if (path === "/state") {
      const out = {};
      for (const c of COLS) {
        const { blobs } = await store.list({ prefix: c + "/" });
        const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
        out[c] = docs.map((d, i) => d && { id: blobs[i].key.slice(c.length + 1), ...d }).filter(Boolean);
      }
      const x = await store.get("_v", { type: "json" });
      out.v = x ? x.v : 0;
      return json(out);
    }

    const body = req.method === "POST" ? await req.json() : {};

    if (path === "/doc") {
      const { col, id, data, mode } = body;
      if (!COLS.includes(col) || !IDOK.test(id || "")) return json({ error: "Bad request" }, 400);
      const key = col + "/" + id;
      if (mode === "delete") await store.delete(key);
      else {
        if (JSON.stringify(data || {}).length > 100000) return json({ error: "Too big" }, 400);
        if (mode === "update") {
          const old = (await store.get(key, { type: "json" })) || {};
          await store.setJSON(key, { ...old, ...data });
        } else await store.setJSON(key, data || {});
      }
      await bump();
      return json({ ok: true });
    }

    if (path === "/import") {
      const sku = String(body.sku || "").toUpperCase().trim();
      if (!SKU.test(sku)) return json({ error: "That doesn't look like an event code (e.g. RE-V5RC-26-5068)" }, 400);
      const eid = sku.toLowerCase();
      const old = await store.get("events/" + eid, { type: "json" });
      const writeAll = async (docs) => {
        for (let i = 0; i < docs.length; i += 20)
          await Promise.all(docs.slice(i, i + 20).map(([k, d]) => store.setJSON(k, d)));
      };

      // quick refresh (every few seconds): matches and scores only, and only writes if something changed
      if (body.light && old && old.reid) {
        const last = await store.get("_imp", { type: "json" });
        if (last && Date.now() - last.t < 4000) return json({ ok: true, cached: true, eventId: eid });
        await store.setJSON("_imp", { t: Date.now() });
        const docs = await matchDocs(eid, old.reid, old.divs || []);
        const h = JSON.stringify(docs);
        const prev = await store.get("_mh", { type: "json" });
        if (prev && prev.h === h) return json({ ok: true, changed: false, eventId: eid });
        await writeAll(docs);
        await store.setJSON("_mh", { h });
        await bump();
        return json({ ok: true, changed: true, eventId: eid });
      }

      // full import: event, teams, matches
      const found = await re("/events?sku%5B%5D=" + sku);
      const e = found.data && found.data[0];
      if (!e) return json({ error: "Event not found on RobotEvents" }, 404);
      const divs = (e.divisions || []).map((d) => d.id);
      const docs = [["events/" + eid, {
        picks: [], link: `https://events.vex.com/robot-competitions/vex-robotics-competition/${sku}.html`,
        ...(old || {}), name: e.name, sku, reid: e.id, divs,
      }]];
      const teams = await all(`/events/${e.id}/teams`);
      for (const t of teams)
        docs.push([`teams/${eid}_${t.number}`, { eventId: eid, number: t.number, name: t.team_name || "", school: t.organization || "" }]);
      const md = await matchDocs(eid, e.id, divs);
      await writeAll([...docs, ...md]);
      await store.setJSON("_mh", { h: JSON.stringify(md) });
      await bump();
      return json({ ok: true, eventId: eid, teams: teams.length, matches: md.length });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }
};

export const config = { path: "/api/*" };

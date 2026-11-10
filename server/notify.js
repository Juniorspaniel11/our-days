/*
 Our Days background job. Runs every few minutes on GitHub Actions.
 1. Pulls each person's Google or Outlook calendar (private iCal links) into Firestore.
 2. Sends the notifications each person switched on in Settings.
 Needs two repository secrets: FIREBASE_SERVICE_ACCOUNT (the JSON key) and VAPID_PRIVATE_KEY.
*/
const admin = require("firebase-admin");
const webpush = require("web-push");
const ical = require("node-ical");

const VAPID_PUBLIC = "BMUJsWU9rc_xiWa16ujIUeNcvlDAot-lPoFYKX3hVAjALmPRWXrAgNU8OvTkbmKEdpuBKVUbeOGlO63qk_Gqv24";
const APP_URL = "https://juniorspaniel11.github.io/our-days/";
const LOOKBACK_MIN = 25;   // GitHub can start scheduled runs late, so catch anything due in this window
const AHEAD_MIN = 2;
const CAL_REFRESH_MIN = 30;
const CAL_DAYS = 21;

/* ---------- time helpers ---------- */
const pad = n => String(n).padStart(2, "0");
const keyOf = (y, m, d) => y + "-" + pad(m) + "-" + pad(d);
function parts(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).forEach(x => p[x.type] = x.value);
  return { key: keyOf(+p.year, +p.month, +p.day), min: (+p.hour % 24) * 60 + (+p.minute), y: +p.year, mo: +p.month, d: +p.day };
}
function offsetMin(ms, tz) { const p = parts(ms, tz); return Math.round((Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.min / 60), p.min % 60) - Math.floor(ms / 60000) * 60000) / 60000); }
/* local wall clock in tz -> epoch ms (handles daylight saving by checking the offset at that moment) */
function wallToMs(key, min, tz) {
  const [y, m, d] = key.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  let t = guess - offsetMin(guess, tz) * 60000;
  t = guess - offsetMin(t, tz) * 60000;
  return t;
}
const addDays = (k, n) => { const [y, m, d] = k.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return keyOf(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };
const dow = k => { const [y, m, d] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split("-").map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...a.split("-").map((v, i) => i === 1 ? v - 1 : +v))) / 864e5);
const toMin = s => { if (!s) return null; const [a, b] = s.split(":").map(Number); return a * 60 + b; };
function fmt(m) { let h = Math.floor(m / 60), mi = m % 60, ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + pad(mi) + " " + ap; }
const validTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; } };

/* ---------- plan helpers (same rules as the app) ---------- */
function itemsFor(person, cal, dayDoc, k) {
  const w = dow(k);
  const r = (person.routine || []).filter(x => (x.days || []).includes(w)).map(x => ({ ...x, kind: "rep" }));
  const e = (person.events || []).filter(x => x.date === k).map(x => ({ ...x, kind: "one" }));
  const c = ((cal && cal.events) || []).filter(x => x.date === k && !x.allDay).map(x => ({ ...x, kind: "cal" }));
  const skip = (dayDoc && dayDoc.skip) || [], done = (dayDoc && dayDoc.done) || [];
  return r.concat(e, c).map(x => ({ ...x, s: toMin(x.start), skipped: skip.includes(x.id), isDone: done.includes(x.id) }))
    .filter(x => x.s != null).sort((a, b) => a.s - b.s);
}
function countdownsFor(person, shared) {
  const own = (person.countdowns || []).map(c => ({ title: c.title, date: c.date, checkpoints: c.checkpoints || [] }));
  const visits = ((shared && shared.countdowns) || []).map(c => ({ title: c.title, date: c.date, checkpoints: c.checkpoints || [] }));
  const proj = (person.projects || []).filter(p => p.target && !p.done).map(p => ({ title: p.title, date: p.target, checkpoints: [] }));
  return own.concat(visits, proj).filter(c => c.date).sort((a, b) => a.date.localeCompare(b.date));
}

/* Work out which notifications are due for one person at time `now` */
function dueNotifications(ctx) {
  const { now, uid, person, partner, days, shared, cal } = ctx;
  const tz = validTz(person.tz) ? person.tz : "America/Chicago";
  const nf = Object.assign({ morning: true, morningAt: "07:30", evening: true, eveningAt: "21:00", countdown: true, meeting: true, prayer: false, prayerAt: "23:00" }, (person.settings && person.settings.notif) || {});
  const out = [];
  const lo = now - LOOKBACK_MIN * 60000, hi = now + AHEAD_MIN * 60000;
  const inWin = t => t > lo && t <= hi;
  const today = parts(now, tz).key;
  // check yesterday too so a 12:10 AM run still catches an 11:55 PM reminder
  for (const k of [addDays(today, -1), today]) {
    const dd = days[k] || {};
    const items = itemsFor(person, cal, dd, k);
    const tasks = (dd.tasks || []).filter(t => t.t && !t.d);
    const cds = countdownsFor(person, shared).map(c => ({ ...c, left: daysBetween(k, c.date) })).filter(c => c.left >= 0);

    if (nf.morning) {
      const t = wallToMs(k, toMin(nf.morningAt) ?? 450, tz);
      if (inWin(t)) {
        const first = items.filter(x => !x.skipped).slice(0, 2).map(x => x.title + " at " + fmt(x.s));
        const bits = [];
        if (first.length) bits.push(first.join(", ")); else bits.push("Nothing scheduled");
        bits.push(tasks.length ? tasks.length + " task" + (tasks.length > 1 ? "s" : "") + " open" : "add your tasks for today");
        if (cds[0]) bits.push(cds[0].left === 0 ? cds[0].title + " is today" : cds[0].left + " days to " + cds[0].title);
        out.push({ key: "morning:" + k, at: t, title: "Good morning, " + (person.name || ""), body: bits.join(" · ") });
      }
    }
    if (partner && partner.bigdays) {
      const t = wallToMs(k, (toMin(nf.morningAt) ?? 450) + 2, tz);
      const bs = Object.entries(partner.bigdays).filter(([, b]) => b && b.date === k);
      if (inWin(t) && bs.length) out.push({ key: "bigday:" + k, at: t, title: "⭐ " + (partner.name || "Your partner") + "'s big day today",
        body: bs.map(([, b]) => b.title + (b.time ? " at " + fmt(toMin(b.time)) + " their time" : "")).join(" · ") + ". Send some love and a prayer 🙏" });
    }
    if (nf.countdown) {
      const t = wallToMs(k, (toMin(nf.morningAt) ?? 450) + 1, tz);
      if (inWin(t)) {
        const lines = [];
        cds.forEach(c => {
          if ([30, 14, 7, 3, 1, 0].includes(c.left)) lines.push(c.left === 0 ? c.title + " is today" : c.title + ": " + c.left + " day" + (c.left > 1 ? "s" : "") + " left");
          (c.checkpoints || []).forEach(cp => { if (!cp.d && addDays(c.date, -(cp.offset || 0)) === k) lines.push(cp.t + " for " + c.title + " is due today"); });
        });
        if (lines.length) out.push({ key: "countdown:" + k, at: t, title: "Coming up", body: lines.slice(0, 4).join(" · ") });
      }
    }
    if (nf.evening) {
      const t = wallToMs(k, toMin(nf.eveningAt) ?? 1260, tz);
      if (inWin(t)) {
        const tm = days[addDays(k, 1)] || {};
        const planned = (tm.tasks || []).filter(x => x.t).length;
        out.push({ key: "evening:" + k, at: t, title: "Plan tomorrow", body: planned ? planned + " task" + (planned > 1 ? "s" : "") + " set for tomorrow. Anything else?" : "Pick tomorrow's tasks, then you're done for the day." + (tasks.length ? " " + tasks.length + " open today will carry over." : "") });
      }
    }
    if (nf.meeting) {
      items.filter(x => !x.skipped && !x.isDone && (x.agenda || x.cat === "meeting" || x.kind === "cal")).forEach(x => {
        const start = wallToMs(k, x.s, tz), t = start - 10 * 60000;
        if (inWin(t) && now < start) {
          const ag = ((person.agenda || {})[x.id] || []).filter(a => !a.d).length;
          out.push({ key: "meeting:" + k + ":" + x.id, at: t, title: x.title + " in 10 min", body: "At " + fmt(x.s) + (x.agenda ? (ag ? " · " + ag + " item" + (ag > 1 ? "s" : "") + " on your agenda" : " · agenda is empty") : "") });
        }
      });
    }
    if (nf.prayer && partner) {
      const pm = toMin(nf.prayerAt) ?? 1380;
      const dateKey = pm < 240 ? addDays(k, 1) : k;  // a 12:30 AM reminder belongs to the night of k
      const t = wallToMs(dateKey, pm, tz);
      const log = (shared && shared.prayer && shared.prayer.log) || {};
      if (inWin(t) && !log[k]) out.push({ key: "prayer:" + k, at: t, title: "Prayer together", body: "10 minutes with " + (partner.name || "your partner") + " tonight." });
    }
  }
  return out;
}

/* ---------- calendar ---------- */
function wallOf(date, tz) { const p = parts(date.getTime(), tz); return p; }
async function fetchCalendar(urls, tz) {
  const from = Date.now() - 864e5, to = Date.now() + CAL_DAYS * 864e5, events = [], errors = [];
  for (let url of urls) {
    url = url.trim().replace(/^webcal:\/\//i, "https://");
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const data = await ical.async.fromURL(url);
      for (const ev of Object.values(data)) {
        if (!ev || ev.type !== "VEVENT" || !ev.start) continue;
        const allDay = ev.datetype === "date";
        const dur = ev.end ? ev.end - ev.start : 3600000;
        const evTz = ev.start.tz && validTz(ev.start.tz) ? ev.start.tz : tz;
        const add = (start, src) => {
          if (src.status === "CANCELLED") return;
          const s = new Date(start), e = new Date(s.getTime() + dur);
          if (e.getTime() < from || s.getTime() > to) return;
          if (allDay) {
            const k = keyOf(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
            events.push({ id: "cal-" + hash(src.uid + k), title: String(src.summary || "Busy"), date: k, allDay: true, cat: "personal" });
          } else {
            const ps = parts(s.getTime(), tz), pe = parts(e.getTime(), tz);
            events.push({ id: "cal-" + hash(src.uid + s.toISOString()), title: String(src.summary || "Busy"), date: ps.key, start: pad(Math.floor(ps.min / 60)) + ":" + pad(ps.min % 60),
              end: pe.key === ps.key ? pad(Math.floor(pe.min / 60)) + ":" + pad(pe.min % 60) : "23:59", location: src.location ? String(src.location) : "", cat: "meeting" });
          }
        };
        if (ev.rrule) {
          const w = wallOf(ev.start, evTz);
          const occ = ev.rrule.between(new Date(from - 2 * 864e5), new Date(to), true);
          const ex = ev.exdate ? Object.keys(ev.exdate).map(x => x.slice(0, 10)) : [];
          for (const o of occ) {
            // keep the original local start time in the event's own time zone, so daylight saving changes don't shift it
            const ok = allDay ? keyOf(o.getUTCFullYear(), o.getUTCMonth() + 1, o.getUTCDate()) : wallOf(o, evTz).key;
            if (ex.includes(ok)) continue;
            const ov = ev.recurrences && (ev.recurrences[ok] || Object.values(ev.recurrences).find(r => r.recurrenceid && wallOf(new Date(r.recurrenceid), evTz).key === ok));
            if (ov) { add(ov.start, ov); continue; }
            add(allDay ? o : new Date(wallToMs(ok, w.min, evTz)), ev);
          }
        } else add(ev.start, ev);
      }
    } catch (e) { errors.push(shortUrl(url) + ": " + (e.message || "could not load")); }
  }
  events.sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));
  return { events: events.slice(0, 400), errors };
}
const shortUrl = u => u.replace(/^https?:\/\//, "").slice(0, 40) + "…";
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

/* ---------- things one of you sent the other (Us tab) ---------- */
async function socialEvents(db, cid, members, people, now) {
  const lo = now - LOOKBACK_MIN * 60000, out = [];
  const other = u => members.find(x => x !== u);
  const name = u => (people[u] && people[u].name) || "Your partner";
  const recent = async n => (await db.collection(`couples/${cid}/${n}`).where("at", ">", lo).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  for (const n of await recent("nudges")) if (other(n.from)) out.push({ to: other(n.from), key: "nudge:" + n.id, at: n.at, title: n.kind ? String(n.title || "News from " + name(n.from)) : name(n.from) + " is thinking of you", body: n.kind ? String(n.body || "") : "Open Our Days to send a heart back." });
  for (const l of await recent("letters")) if (l.to) out.push({ to: l.to, key: "letter:" + l.id, at: l.at, title: "A letter from " + name(l.from), body: l.openWhen ? "Open when " + l.openWhen : "It's waiting in your letterbox." });
  for (const m of await recent("moments")) if (other(m.from)) out.push({ to: other(m.from), key: "moment:" + m.id, at: m.at,
    title: m.kind === "doodle" ? name(m.from) + " sent you a doodle" : m.kind === "paint" ? name(m.from) + " saved your painting" : m.kind === "daily" ? name(m.from) + " shared today's photo" : name(m.from) + " shared a moment",
    body: m.kind === "daily" ? "Share yours to see it." : "It's in the frame in your room." });
  for (const j of await recent("jar")) if (other(j.from)) out.push({ to: other(j.from), key: "jar:" + j.id, at: j.at, title: name(j.from) + " added a note to your jar", body: "Pull it out whenever you need it." });
  const home = (await db.doc(`couples/${cid}/us/home`).get()).data() || {};
  for (const x of home.log || []) if (x && x.at > lo && other(x.by)) out.push({ to: other(x.by), key: "home:" + x.at + ":" + x.by, at: x.at, title: "Your dream home", body: name(x.by) + " " + x.text });
  const pr = (await db.doc(`couples/${cid}/us/prayer`).get()).data() || {};
  for (const x of pr.items || []) {
    if (x.at > lo && other(x.by)) out.push({ to: other(x.by), key: "pray:" + x.id, at: x.at, title: name(x.by) + " added a prayer request", body: x.text });
    if (x.answered && x.answeredAt > lo && other(x.answeredBy)) out.push({ to: other(x.answeredBy), key: "prayans:" + x.id, at: x.answeredAt, title: "Prayer answered 🙌", body: x.text });
  }
  const ev = (await db.doc(`couples/${cid}/us/evening`).get()).data() || {};
  for (const [k, pl] of Object.entries(ev)) {
    if (!pl || !pl.time) continue;
    const tz = validTz(pl.tz) ? pl.tz : "America/Chicago", labels = (pl.items || []).map(x => x.label).join(", then ");
    const when = k === parts(now, tz).key ? "tonight" : "an evening for " + new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    if (pl.at > lo && other(pl.by)) out.push({ to: other(pl.by), key: "evplan:" + k + ":" + pl.at, at: pl.at, title: name(pl.by) + " planned " + when + " 🌙", body: fmt(toMin(pl.time)) + " " + (people[pl.by] && people[pl.by].city ? "(" + people[pl.by].city + " time)" : "") + ": " + labels });
    const t = wallToMs(k, toMin(pl.time), tz);
    if (t > lo && t <= now + AHEAD_MIN * 60000) members.forEach(u => out.push({ to: u, key: "evstart:" + k + ":" + pl.time, at: t, title: "Your evening together starts now 🌙", body: labels }));
  }
  const ck = (await db.doc(`couples/${cid}/us/checkin`).get()).data() || {};
  for (const [mk, m] of Object.entries(ck)) for (const [u, v] of Object.entries(m || {})) {
    const o = other(u); if (!o || !v || !(v.at > lo)) continue;
    out.push({ to: o, key: "ck:" + mk + ":" + u, at: v.at, title: m[o] ? "Check-in unlocked" : name(u) + " finished the monthly check-in", body: m[o] ? "See how you both saw the month." : "Do yours to see each other's answers." });
  }
  const us = (await db.doc(`couples/${cid}/us/main`).get()).data() || {};
  for (const [id, a] of Object.entries(us.answers || {})) for (const [u, v] of Object.entries(a || {})) {
    const o = other(u); if (!o || !v || !(v.at > lo)) continue;
    const both = !!a[o];
    out.push({ to: o, key: "ans:" + id + ":" + u, at: v.at, title: both ? "Answers unlocked" : name(u) + " answered " + (id.startsWith("d:") ? "today's question" : "a question"),
      body: both ? "You both answered. See what " + name(u) + " said." : "Answer too and you'll both see each other's." });
  }
  const du = (await db.doc(`couples/${cid}/us/duel`).get()).data() || {};
  for (const [kind, label] of [["know", "Know me best"], ["trivia", "Trivia duel"]]) for (const [k, d] of Object.entries(du[kind] || {})) for (const [u, v] of Object.entries(d || {})) {
    const o = other(u); if (!o || !v || !(v.at > lo)) continue;
    const ov = d[o]; if (ov && ov.at > v.at) continue;
    out.push({ to: o, key: "duel:" + kind + ":" + k + ":" + u, at: v.at, title: ov && ov.at ? "Results are in 🏆" : name(u) + " played " + label,
      body: ov && ov.at ? name(u) + " finished " + label + ". See who won." : "Play today's " + label + " to see who wins." });
  }
  const c4 = du.c4;
  if (c4 && c4.at > lo && c4.id) {
    if (c4.by && other(c4.by)) out.push({ to: other(c4.by), key: "c4:" + c4.id + ":" + c4.moves, at: c4.at,
      title: c4.w ? (c4.w === "tie" ? "Connect Four: it's a tie 🤝" : name(c4.w) + " won Connect Four 🏆") : "Your move in Connect Four 🔴",
      body: c4.w ? "Open Our Days for a rematch." : name(c4.by) + " just dropped a disc." });
    else if (!c4.by && c4.moves === 0 && c4.turn && c4.starter && c4.turn !== c4.starter) out.push({ to: c4.turn, key: "c4:" + c4.id + ":0", at: c4.at, title: "New Connect Four game 🔴", body: name(other(c4.turn)) + " started a game. You go first." });
  }
  const GNAME = { likely: "Who's more likely to", wyr: "Would you rather", tot: "This or That", nhie: "Never have I ever", agree: "Agree or disagree", flirty: "Flirty picks" };
  for (const [gid, G] of Object.entries(us.games || {})) for (const [k, d] of Object.entries(G || {})) {
    if (k === "rounds" || !d || !d.done) continue;
    for (const [u, at] of Object.entries(d.done)) {
      const o = other(u); if (!o || !(at > lo)) continue;
      const both = Array.isArray(d[o]) && d[o].length === 5, gn = GNAME[gid] || "a game";
      if (both && (d.done[o] || 0) > at) continue;
      let m = 0; if (both) (d[u] || []).forEach((v, n) => { if (v === d[o][n]) m++; });
      out.push({ to: o, key: "game:" + gid + ":" + k + ":" + u, at, title: both ? "Results are in: " + m + " of 5 match" : name(u) + " played " + gn,
        body: both ? name(u) + " finished " + gn + ". See each other's picks." : "Play your 5 and you'll both see each other's picks." });
    }
  }
  return out;
}

/* ---------- main ---------- */
async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!sa.project_id) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is missing");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const pushOn = !!process.env.VAPID_PRIVATE_KEY;
  if (pushOn) webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY);
  const now = Date.now();
  const couples = await db.collection("couples").get();
  let sent = 0;
  for (const c of couples.docs) {
    const cid = c.id, members = c.data().members || [];
    const sharedSnap = await db.doc(`couples/${cid}/shared/main`).get();
    const shared = sharedSnap.exists ? sharedSnap.data() : {};
    const people = {};
    for (const uid of members) { const s = await db.doc(`couples/${cid}/people/${uid}`).get(); if (s.exists) people[uid] = s.data(); }
    let social = [];
    try { social = await socialEvents(db, cid, members, people, now); } catch (e) { console.warn("us events", e.message); }
    for (const uid of members) {
      const person = people[uid]; if (!person) continue;
      const tz = validTz(person.tz) ? person.tz : "America/Chicago";
      const partner = people[members.find(x => x !== uid)] || null;

      /* calendar */
      const calRef = db.doc(`couples/${cid}/people/${uid}/extra/calendar`);
      const calSnap = await calRef.get();
      let cal = calSnap.exists ? calSnap.data() : null;
      const urls = String((person.settings && person.settings.cal) || "").split(/[\s,]+/).filter(Boolean);
      const sig = hash(urls.join("|") + tz);
      if (!urls.length && cal && cal.events && cal.events.length) { await calRef.set({ events: [], errors: [], fetchedAt: now, sig }); cal = null; }
      else if (urls.length && (!cal || cal.sig !== sig || now - (cal.fetchedAt || 0) > CAL_REFRESH_MIN * 60000)) {
        const r = await fetchCalendar(urls, tz);
        cal = { events: r.events, errors: r.errors, fetchedAt: now, sig };
        await calRef.set(cal);
      }

      /* notifications */
      const userRef = db.doc(`users/${uid}`);
      const user = (await userRef.get()).data() || {};
      const subs = user.push || {};
      if (!pushOn || !Object.keys(subs).length) continue;
      const today = parts(now, tz).key;
      const days = {};
      for (const k of [addDays(today, -1), today, addDays(today, 1)]) { const s = await db.doc(`couples/${cid}/people/${uid}/days/${k}`).get(); if (s.exists) days[k] = s.data(); }
      const due = dueNotifications({ now, uid, person, partner, days, shared, cal });
      if (((person.settings && person.settings.notif) || {}).partner !== false) due.push(...social.filter(n => n.to === uid));
      if (user.testPushAt && now - user.testPushAt < 60 * 60000) due.push({ key: "test:" + user.testPushAt, at: now, title: "Our Days", body: "Notifications are working on this device." });
      const logRef = db.doc(`users/${uid}/private/notifyLog`);
      const log = ((await logRef.get()).data() || {}).sent || {};
      const fresh = due.filter(n => !log[n.key]);
      for (const n of fresh) {
        for (const [id, sub] of Object.entries(subs)) {
          try { await webpush.sendNotification(sub, JSON.stringify({ title: n.title, body: n.body, tag: n.key, url: APP_URL })); sent++; }
          catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await userRef.update({ ["push." + id]: admin.firestore.FieldValue.delete() }); else console.warn("push failed", e.statusCode || e.message); }
        }
        log[n.key] = now;
      }
      if (user.testPushAt) await userRef.update({ testPushAt: admin.firestore.FieldValue.delete() });
      if (fresh.length) {
        for (const k of Object.keys(log)) if (now - log[k] > 4 * 864e5) delete log[k];
        await logRef.set({ sent: log });
      }
    }
  }
  console.log("done, notifications sent:", sent);
}

module.exports = { socialEvents, dueNotifications, fetchCalendar, wallToMs, parts };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

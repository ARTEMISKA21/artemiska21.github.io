const functions = require('firebase-functions');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

admin.initializeApp();
const db = admin.database();
const JWT_SECRET = functions.config().app.jwt_secret;
const TOKEN_TTL = 60 * 60 * 24 * 30;

const normName = n => String(n || '').trim().toLowerCase();
const projectKey = n => String(n || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
const verify = t => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };

async function nextUserId() {
  const r = await db.ref('meta/nextUserId').transaction(c => (c === null ? 1000 : c + 1));
  return r.snapshot.val();
}

exports.register = functions.https.onCall(async (data) => {
  const name = String(data.name || '').trim();
  const pass = String(data.pass || '');
  if (name.length < 3) throw new functions.https.HttpsError('invalid-argument', 'nameShort');
  if (pass.length < 3) throw new functions.https.HttpsError('invalid-argument', 'pwdMin');
  const key = normName(name);
  const ref = db.ref('users/' + key);
  const snap = await ref.once('value');
  if (snap.exists()) throw new functions.https.HttpsError('already-exists', 'nameTaken');
  const id = await nextUserId();
  const passHash = await bcrypt.hash(pass, 10);
  await ref.set({
    name, id, passHash,
    theme: data.theme || 'dark', anim: data.anim || 'on',
    gender: '', lang: 'ru', avatar: '', created: Date.now()
  });
  const token = jwt.sign({ name, id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, name, id };
});

exports.login = functions.https.onCall(async (data) => {
  const key = normName(data.name);
  const snap = await db.ref('users/' + key).once('value');
  if (!snap.exists()) throw new functions.https.HttpsError('not-found', 'errConn');
  const u = snap.val();
  const ok = await bcrypt.compare(String(data.pass || ''), u.passHash || '');
  if (!ok) throw new functions.https.HttpsError('permission-denied', 'wrongPass');
  const token = jwt.sign({ name: u.name, id: u.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, user: {
    name: u.name, id: u.id, theme: u.theme || 'dark', anim: u.anim || 'on',
    gender: u.gender || '', lang: u.lang || 'ru', avatar: u.avatar || ''
  }};
});

exports.me = functions.https.onCall(async (data) => {
  const p = verify(data.token);
  if (!p) throw new functions.https.HttpsError('unauthenticated', 'errConn');
  const snap = await db.ref('users/' + normName(p.name)).once('value');
  if (!snap.exists()) throw new functions.https.HttpsError('not-found', 'errConn');
  const u = snap.val();
  return {
    name: u.name, id: u.id, theme: u.theme || 'dark', anim: u.anim || 'on',
    gender: u.gender || '', lang: u.lang || 'ru', avatar: u.avatar || ''
  };
});

exports.updateProfile = functions.https.onCall(async (data) => {
  const p = verify(data.token);
  if (!p) throw new functions.https.HttpsError('unauthenticated', 'errConn');
  const patch = {};
  if (data.theme === 'light' || data.theme === 'dark') patch.theme = data.theme;
  if (data.anim === 'on' || data.anim === 'off') patch.anim = data.anim;
  if (typeof data.gender === 'string') patch.gender = data.gender;
  if (data.lang === 'ru' || data.lang === 'en') patch.lang = data.lang;
  if (typeof data.avatar === 'string') patch.avatar = data.avatar;
  if (Object.keys(patch).length) await db.ref('users/' + normName(p.name)).update(patch);
  return true;
});

exports.changePassword = functions.https.onCall(async (data) => {
  const p = verify(data.token);
  if (!p) throw new functions.https.HttpsError('unauthenticated', 'errConn');
  if (String(data.pass || '').length < 3)
    throw new functions.https.HttpsError('invalid-argument', 'pwdMin');
  const hash = await bcrypt.hash(data.pass, 10);
  await db.ref('users/' + normName(p.name)).update({ passHash: hash });
  return true;
});

exports.changeName = functions.https.onCall(async (data) => {
  const p = verify(data.token);
  if (!p) throw new functions.https.HttpsError('unauthenticated', 'errConn');
  const newName = String(data.newName || '').trim();
  if (newName.length < 3) throw new functions.https.HttpsError('invalid-argument', 'nameShort');
  const oldKey = normName(p.name), newKey = normName(newName);
  const oldSnap = await db.ref('users/' + oldKey).once('value');
  if (!oldSnap.exists()) throw new functions.https.HttpsError('not-found', 'errConn');
  const newSnap = await db.ref('users/' + newKey).once('value');
  if (newSnap.exists()) throw new functions.https.HttpsError('already-exists', 'nameTaken');
  const u = oldSnap.val(); u.name = newName;
  await db.ref('users/' + newKey).set(u);
  await db.ref('users/' + oldKey).remove();
  const token = jwt.sign({ name: u.name, id: u.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, name: u.name, id: u.id };
});

exports.toggleReaction = functions.https.onCall(async (data) => {
  const p = verify(data.token);
  if (!p) throw new functions.https.HttpsError('unauthenticated', 'needLogin');
  const key = projectKey(data.projectName);
  const ref = db.ref('projects/' + key);
  const snap = await ref.once('value');
  const cur = snap.val() || { likes: [], dislikes: [] };
  cur.likes = (cur.likes || []).filter(u => u !== p.name);
  cur.dislikes = (cur.dislikes || []).filter(u => u !== p.name);
  if (data.reaction === 'like') cur.likes.push(p.name);
  if (data.reaction === 'dislike') cur.dislikes.push(p.name);
  await ref.set(cur);
  return { likes: cur.likes, dislikes: cur.dislikes, downloads: cur.downloads || 0 };
});

exports.incrementDownload = functions.https.onCall(async (data) => {
  const p = verify(data.token);
  if (!p) throw new functions.https.HttpsError('unauthenticated', 'needLoginDownload');
  const key = projectKey(data.projectName);
  const r = await db.ref('projects/' + key + '/downloads').transaction(c => (c || 0) + 1);
  return r.snapshot.val() || 0;
});

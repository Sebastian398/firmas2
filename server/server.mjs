// app_lock_server.mjs
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', allowEIO3: true } });
const CONFIG_PATH = path.resolve(__dirname, 'config_acta.json');

// [API CONFIG] CORS + JSON parser:
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // ajusta si quieres restringir
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '10mb' }));

// Estado por acta
const stateByActa = new Map(); // actaId -> state tree
const locksByActa = new Map(); // actaId -> Map(path -> info)
const LOCK_TTL_MS = 20000;

function getActaState(actaId){ if(!stateByActa.has(actaId)) stateByActa.set(actaId, {}); return stateByActa.get(actaId); }
function getActaLocks(actaId){ if(!locksByActa.has(actaId)) locksByActa.set(actaId, new Map()); return locksByActa.get(actaId); }
function isExpired(info){ return !info || (info.expiresAt && Date.now() > info.expiresAt); }

function setPathValue(root, path, value){
  // path style: /meta/hora  or /participants/row_01/name
  const parts = path.replace(/^\//,'').split('/');
  let cur = root;
  for(let i=0;i<parts.length;i++){
    const k = parts[i];
    if(i === parts.length-1){
      // leaf => wrap as {value}
      if(k){
        if(typeof cur[k] !== 'object' || cur[k]===null) cur[k] = {};
        cur[k].value = value;
      }
    }else{
      if(!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
  }
}

function snapshotObj(state){return state;}

io.of('/acta').on('connection', (socket)=>{
  socket.on('join', ({actaId})=>{
    if(!actaId) return;
    socket.join(actaId);
    // Enviar snapshot actual
    const snap = snapshotObj(getActaState(actaId));
    socket.emit('snapshot', snap);
    // Enviar estado de locks
    const map = getActaLocks(actaId);
    const state = {};
    for (const [p,info] of map.entries()){
      if(!isExpired(info)) state[p] = info;
    }
    socket.emit('lock_state', state);
  });

  socket.on('presence', ({actaId, user})=>{ if(actaId){ socket.to(actaId).emit('presence', {user}); } });

  socket.on('patch', ({actaId, path, value, clientId})=>{
    if(!actaId || !path) return;
    // Si existe lock y no es del cliente, ignorar
    const lmap = getActaLocks(actaId);
    const cur = lmap.get(path);
    if(cur && !isExpired(cur) && cur.ownerClientId !== clientId){
      return; // denegado por servidor
    }
    const state = getActaState(actaId);
    setPathValue(state, path, value);
    socket.to(actaId).emit('patch', { path, value, clientId });
  });

  // Locks
  socket.on('lock_request', ({actaId, path, clientId, user})=>{
    if(!actaId || !path || !clientId) return;
    const map = getActaLocks(actaId);
    const now = Date.now();
    const cur = map.get(path);
    if(!cur || isExpired(cur) || cur.ownerClientId === clientId){
      const info = { ownerClientId: clientId, ownerName: user||clientId, expiresAt: now + LOCK_TTL_MS };
      map.set(path, info);
      socket.emit('lock_granted', { path, ...info });
      socket.to(actaId).emit('lock_update', { path, ...info });
    }else{
      socket.emit('lock_denied', { path, ownerName: cur.ownerName });
    }
  });

  socket.on('lock_touch', ({actaId, path, clientId})=>{
    if(!actaId || !path || !clientId) return;
    const map = getActaLocks(actaId);
    const cur = map.get(path);
    if(cur && cur.ownerClientId === clientId){ cur.expiresAt = Date.now() + LOCK_TTL_MS; map.set(path, cur); }
  });

  socket.on('lock_release', ({actaId, path, clientId})=>{
    if(!actaId || !path || !clientId) return;
    const map = getActaLocks(actaId);
    const cur = map.get(path);
    if(cur && cur.ownerClientId === clientId){
      map.delete(path);
      io.of('/acta').to(actaId).emit('lock_update', { path, ownerClientId: null, ownerName: null, expiresAt: 0 });
    }
  });

  socket.on('typing', ({actaId, path, clientId, user})=>{ if(actaId && path) socket.to(actaId).emit('typing', { path, user: user || clientId }); });
});

// [API CONFIG] Helpers JSON compartido:
async function readConfig(){
  if (!existsSync(CONFIG_PATH)) return { empresas:{}, cargos:[] };
  try { const t = await readFile(CONFIG_PATH, 'utf8'); return JSON.parse(t || '{}') || {empresas:{}, cargos:[]}; }
  catch { return { empresas:{}, cargos:[] }; }
}
async function writeConfig(data){
  const clean = {
    empresas: (data && typeof data.empresas==='object') ? data.empresas : {},
    cargos: Array.isArray(data?.cargos) ? data.cargos : []
  };
  await writeFile(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
}

// [API CONFIG] Rutas:
app.get('/api/config', async (req, res) => {
  const cfg = await readConfig();
  res.status(200).json(cfg);
});
app.put('/api/config', async (req, res) => {
  try { await writeConfig(req.body || {}); res.status(200).json({ ok:true }); }
  catch (err) { res.status(400).json({ ok:false, error:String(err) }); }
});

app.post('/api/config', async (req, res) => {
  try {
    await writeConfig(req.body || {});
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Servidor Socket.IO con locks en puerto', PORT));

const express = require('express');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ============ DATABASE JSON SEDERHANA ============
const DB_FILE = '/tmp/antrian.json';

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return {
      config: { admin_user: 'admin', admin_pass: 'admin123' },
      layanan: {
        A: { kode: 'A', nama: 'Teller', aktif: true, jam_buka: '08:00', jam_tutup: '15:00', hari_aktif: [1,2,3,4,5] },
        B: { kode: 'B', nama: 'Customer Service', aktif: true, jam_buka: '08:00', jam_tutup: '15:00', hari_aktif: [1,2,3,4,5] },
        C: { kode: 'C', nama: 'Prioritas', aktif: true, jam_buka: '08:00', jam_tutup: '15:00', hari_aktif: [1,2,3,4,5] }
      },
      antrian: [],
      sesi: [],
      lastId: 0
    };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ============ HELPERS ============
function today() {
  return new Date().toISOString().slice(0, 10);
}
function nowTime() {
  return new Date().toTimeString().slice(0, 5);
}
function cekBuka(l) {
  const hari = new Date().getDay();
  if (!l.hari_aktif.includes(hari)) return { buka: false, alasan: 'Hari ini tutup' };
  const t = nowTime();
if (t < l.jam_buka) return { buka: false, alasan: 'Buka jam ' + l.jam_buka };
  if (t > l.jam_tutup) return { buka: false, alasan: 'Sudah tutup (' + l.jam_tutup + ')' };
  return { buka: true };
}
function requireAdmin(req, res, next) {
  const db = loadDB();
  if (!req.cookies.token || !db.sesi.includes(req.cookies.token))
    return res.status(401).json({ error: 'Belum login' });
  next();
}

// ============ API NASABAH ============
app.get('/api/info', (req, res) => {
  const db = loadDB();
  const tgl = today();
  const hasil = Object.values(db.layanan).map(l => {
    const hariIni = db.antrian.filter(a => a.kode_layanan === l.kode && a.tanggal === tgl);
    const dipanggil = Math.max(0, ...hariIni.filter(a => a.status === 'dipanggil' || a.status === 'selesai').map(a => a.nomor));
    const menunggu = hariIni.filter(a => a.status === 'menunggu').length;
    return { ...l, status: cekBuka(l), sedang_dipanggil: dipanggil, sisa_menunggu: menunggu };
  });
  res.json(hasil);
});

app.post('/api/ambil', (req, res) => {
  const db = loadDB();
  const { kode } = req.body;
  const l = db.layanan[kode];
  if (!l || !l.aktif) return res.status(400).json({ error: 'Layanan tidak aktif' });
  const status = cekBuka(l);
  if (!status.buka) return res.status(400).json({ error: status.alasan });

  const tgl = today();
  const hariIni = db.antrian.filter(a => a.kode_layanan === kode && a.tanggal === tgl);
  const nomor = Math.max(0, ...hariIni.map(a => a.nomor)) + 1;
  const dipanggil = Math.max(0, ...hariIni.filter(a => a.status === 'dipanggil' || a.status === 'selesai').map(a => a.nomor));

  db.lastId++;
  db.antrian.push({
    id: db.lastId, kode_layanan: kode, nomor, tanggal: tgl,
    status: 'menunggu', waktu_ambil: nowTime()
  });
  saveDB(db);

  res.json({
    kode, nomor_anda: nomor, sedang_berjalan: dipanggil,
    sisa_di_depan: Math.max(0, nomor - dipanggil - 1),
    pesan: 'Simpan nomor ini. Jika lewat 3 antrian, nomor tidak berlaku.'
  });
});

app.get('/api/status/:kode/:nomor', (req, res) => {
  const db = loadDB();
  const tgl = today();
  const nomor = Number(req.params.nomor);
  const kode = req.params.kode;
  const data = db.antrian.find(a => a.kode_layanan === kode && a.nomor === nomor && a.tanggal === tgl);
  if (!data) return res.json({ error: 'Tidak ditemukan' });

  const hariIni = db.antrian.filter(a => a.kode_layanan === kode && a.tanggal === tgl);
  const dipanggil = Math.max(0, ...hariIni.filter(a => a.status === 'dipanggil' || a.status === 'selesai').map(a => a.nomor));
  const selisih = nomor - dipanggil;

  let status_text = 'menunggu';
  if (data.status === 'dipanggil') status_text = 'dipanggil';
  else if (data.status === 'hangus' || selisih > 3) status_text = 'hangus';

  res.json({
    nomor, kode, status: status_text, sedang_berjalan: dipanggil, selisih,
    pesan: selisih > 3 ? 'Antrian Anda sudah hangus (lewat 3 antrian)' :
           selisih === 1 ? 'Anda adalah antrian berikutnya!' :
           selisih === 0 ? 'SEKARANG GILIRAN ANDA!' :
           Sisa ${selisih - 1} antrian lagi
  });
});

app.get('/api/display', (req, res) => {
  const db = loadDB();
  const tgl = today();
  const hasil = Object.values(db.layanan).map(l => {
    const hariIni = db.antrian.filter(a => a.kode_layanan === l.kode && a.tanggal === tgl && (a.status === 'dipanggil' || a.status === 'selesai'));
    return { kode: l.kode, nama: l.nama, dipanggil: Math.max(0, ...hariIni.map(a => a.nomor)) };
  });
  res.json({ waktu: nowTime(), layanan: hasil });
});

// ============ API ADMIN ============
app.post('/api/admin/login', (req, res) => {
  const db = loadDB();
  const { user, pass } = req.body;
  if (user !== db.config.admin_user || pass !== db.config.admin_pass)
    return res.status(401).json({ error: 'Salah login' });
  const token = Math.random().toString(36).slice(2) + Date.now();
  db.sesi.push(token);
  saveDB(db);
  res.cookie('token', token, { httpOnly: true });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const db = loadDB();
  db.sesi = db.sesi.filter(t => t !== req.cookies.token);
  saveDB(db);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/admin/layanan', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(Object.values(db.layanan));
});

app.put('/api/admin/layanan/:kode', requireAdmin, (req, res) => {
  const db = loadDB();
  const l = db.layanan[req.params.kode];
  if (!l) return res.status(404).json({ error: 'Tidak ada' });
  const { nama, aktif, jam_buka, jam_tutup, hari_aktif } = req.body;
  Object.assign(l, {
    nama, aktif: !!aktif, jam_buka, jam_tutup,
    hari_aktif: hari_aktif.split(',').map(Number)
  });
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/admin/panggil/:kode', requireAdmin, (req, res) => {
  const db = loadDB();
  const tgl = today();
  const kode = req.params.kode;
  db.antrian.forEach(a => {
    if (a.kode_layanan === kode && a.tanggal === tgl && a.status === 'dipanggil')
      a.status = 'selesai';
  });
  const next = db.antrian
    .filter(a => a.kode_layanan === kode && a.tanggal === tgl && a.status === 'menunggu')
    .sort((a, b) => a.nomor - b.nomor)[0];
  if (!next) { saveDB(db); return res.json({ ok: false, message: 'Tidak ada antrian menunggu' }); }
  next.status = 'dipanggil';
  next.waktu_panggil = nowTime();
  saveDB(db);
  res.json({ ok: true, dipanggil: next.nomor });
});

app.post('/api/admin/panggil-ulang/:kode', requireAdmin, (req, res) => {
  const db = loadDB();
  const tgl = today();
  const hariIni = db.antrian.filter(a => a.kode_layanan === req.params.kode && a.tanggal === tgl && a.status === 'dipanggil');
  if (!hariIni.length) return res.json({ ok: false });
  res.json({ ok: true, dipanggil: Math.max(...hariIni.map(a => a.nomor)) });
});

app.post('/api/admin/bersihkan/:kode', requireAdmin, (req, res) => {
  const db = loadDB();
  const tgl = today();
  const kode = req.params.kode;
  const hariIni = db.antrian.filter(a => a.kode_layanan === kode && a.tanggal === tgl);
  const dipanggil = Math.max(0, ...hariIni.filter(a => a.status === 'dipanggil' || a.status === 'selesai').map(a => a.nomor));
  hariIni.forEach(a => {
    if (a.status === 'menunggu' && a.nomor < dipanggil - 2) a.status = 'hangus';
  });
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/admin/qr', requireAdmin, async (req, res) => {
  const url = req.query.url || 'http://localhost:3000/';
  const qr = await QRCode.toDataURL(url);
  res.json({ qr });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server jalan di port ' + PORT));
 

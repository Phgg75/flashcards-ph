// Service worker: deixa o app funcionando offline depois da primeira abertura.
const CACHE = 'flashcards-ph-v10';
const FILES = ['./', './index.html', './styles.css', './edital-pmpe.js', './estudo.js', './gerar.js', './app.js', './sync.js', './lembretes.js', './icon-180.png', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Rede primeiro (pega atualizações), cache como reserva quando offline.
// Só guarda os arquivos do app e a biblioteca do Supabase (não guarda respostas do banco).
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin && url.hostname !== 'cdn.jsdelivr.net') return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});

// Lembretes: mostra a notificação que chega da função "lembrete"
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '📚 Hora de revisar', {
    body: d.body || 'Abra o app para ver o que tem para hoje.',
    icon: 'icon-180.png', badge: 'icon-180.png', tag: 'lembrete-revisao', renotify: true,
    data: { url: d.url || './' },
  }));
});
// Tocar na notificação abre (ou traz para frente) o app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(alvo);
  }));
});

/**
 * STW-301 · Iframe-Bridge (läuft IM Widget).
 * Einzige Aufgabe: die Höhe des Inhalts an die einbettende Seite melden, damit
 * kein Scrollbalken entsteht. Ausschließlich ausgehende Nachrichten, adressiert
 * an einen konkreten Origin, der über ?parent= übergeben und gegen die Server-
 * seitig gerenderte Allow-List (data-allowed-parents) geprüft wird. Eingehende
 * Nachrichten werden ignoriert.
 */
(function () {
  const root = document.getElementById('root');
  if (!root || window.parent === window) return;

  const params = new URLSearchParams(location.search);
  const parent = params.get('parent');
  const allowed = (root.dataset.allowedParents ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parent || !allowed.includes(parent)) return; // ohne freigegebenen Elternteil keine Kommunikation

  let last = -1;
  const send = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h === last) return;
    last = h;
    window.parent.postMessage({ type: 'slotwise:resize', height: h }, parent);
  };

  new ResizeObserver(send).observe(document.documentElement);
  window.addEventListener('load', send);
})();

// ── Content script — corre en parkguellonline.cat ────────────────────────────
if (window.__scopBotLoaded) { /* ya inyectado, no ejecutar de nuevo */ throw new Error('already_loaded'); }
window.__scopBotLoaded = true;

// Prevenir que el browser use bfcache — evita que se cierre el canal de mensajes
window.addEventListener('unload', () => {});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    // La página volvió del bfcache — recargar para que el content script se reconecte
    window.location.reload();
  }
});

const TICKET_SELECT_IDS = {
  'general':              'iNumPers_1',
  'children-7-12':        'iNumPers_3',
  'children-0-6':         'iNumPers_24',
  'over65':               'iNumPers_4',
  'targeta-rosa-reduida':  'iNumPers_30',
  'disabilities':         'iNumPers_14',
};

const SUPABASE_URL  = 'https://odhogdwxafqdlfvfbsux.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kaG9nZHd4YWZxZGxmdmZic3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMTM2MDAsImV4cCI6MjA4OTY4OTYwMH0.sDgtKOdVeK9Xf7VI2aNQhUO5Hs_rY2tmXD1z5pHayF8';

// Convertir una orden de Supabase al formato que usa el bot
function orderToBot(row) {
  const tickets = {};

  // Park Güell usa ticket_type "standard" para todos
  // Las cantidades vienen en qty_adults, qty_children, qty_seniors
  if ((row.qty_adults || 0) > 0)   tickets['general']       = row.qty_adults;
  if ((row.qty_children || 0) > 0) tickets['children-7-12'] = row.qty_children;
  if ((row.qty_seniors || 0) > 0)  tickets['over65']        = row.qty_seniors;
  // qty_infants son niños 0-6 (gratis)
  if ((row.qty_infants || 0) > 0)  tickets['children-0-6']  = row.qty_infants;

  // Visitantes: titular primero, luego companion_names
  const visitors = [];

  // Titular
  if (row.visitor_name) {
    visitors.push({ name: row.visitor_name.trim() });
  }

  // Companions — vienen como JSON array de strings tipo "NOMBRE [tipo]"
  if (row.companion_names) {
    let companions = row.companion_names;
    if (typeof companions === 'string') {
      try { companions = JSON.parse(companions); } catch { companions = []; }
    }
    for (const c of companions) {
      // Extraer solo el nombre (antes del "[")
      const name = c.replace(/\s*\[.*\]/, '').trim();
      if (name) visitors.push({ name });
    }
  }

  return {
    date:     row.visit_date,
    timeSlot: row.time_slot,
    tickets,
    visitors,
    country:  row.country || '',
  };
}

async function fetchOrder(orderId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*&limit=1`,
    { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } }
  );
  if (!res.ok) throw new Error(`Error al obtener la orden: ${res.status}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`Orden no encontrada: ${orderId}`);
  return orderToBot(rows[0]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min = 200, max = 700) {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}
function sendStep(step, text) {
  chrome.runtime.sendMessage({ type: 'STEP', step, text }).catch(() => {});
}
function sendDone(text) {
  chrome.runtime.sendMessage({ type: 'DONE', text }).catch(() => {});
}
function sendError(text) {
  chrome.runtime.sendMessage({ type: 'ERROR', text }).catch(() => {});
}

async function humanType(el, text) {
  el.focus();
  el.select?.();
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(100);
  for (const char of text) {
    el.value += char;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(Math.floor(Math.random() * 100) + 30);
    if (Math.random() < 0.06) await randomDelay(200, 500);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await randomDelay(150, 400);
}

function waitFor(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start > timeout) return reject(new Error(`Timeout esperando: ${selector}`));
      setTimeout(check, 200);
    };
    check();
  });
}

function scrollTo(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return sleep(400);
}

function timeToSlotId(timeStr) {
  // Slots: 9:00 (idx=3), 9:30 (idx=4), 10:00 (idx=5), ...
  let hour = 9, min = 0, idx = 3;
  while (hour < 20) {
    const hhmm    = String(hour).padStart(2,'0') + String(min).padStart(2,'0');
    const endMin  = min + 29;
    const endH    = endMin >= 60 ? hour + 1 : hour;
    const endM    = endMin >= 60 ? endMin - 60 : endMin;
    const endHHMM = String(endH).padStart(2,'0') + String(endM).padStart(2,'0');
    const slotTime = `${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    if (slotTime === timeStr) return `sessio_1_${idx}_${hhmm}_0_${endHHMM}`;
    min += 30;
    if (min >= 60) { min -= 60; hour++; }
    idx++;
  }
  throw new Error(`Slot no encontrado para hora: ${timeStr}`);
}

// ── Pasos 5 y 6: datos personales + visitantes (se ejecuta en carritoActivitats.jsp) ──
async function fillPersonalData(order) {
  const { visitors } = order;

  // Esperar que el formulario esté listo
  await waitFor('#sle_nom', 20000);
  await randomDelay(800, 1500);

  sendStep(5, 'Llenando datos personales...');

  // Usar el nombre del primer visitante como titular
  const firstVisitorName = visitors[0]?.name || 'Scop Tickets';
  const nameParts = firstVisitorName.trim().split(' ');
  const firstName = nameParts[0] || 'Scop';
  const lastName  = nameParts.slice(1).join(' ') || 'Tickets';

  // Solo rellenar nombre y apellido — dejar tel, email y pais como están
  const fields = {
    sle_nom:     firstName,
    sle_cognoms: lastName,
  };

  for (const [id, value] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) { await scrollTo(el); await humanType(el, value); }
  }

  // País — mapear código ISO al nombre completo del dropdown
  const COUNTRY_MAP = {
    'ES': 'España', 'FR': 'Francia', 'DE': 'Alemania', 'IT': 'Italia',
    'GB': 'Reino Unido', 'US': 'Estados Unidos', 'PT': 'Portugal',
    'NL': 'Países Bajos', 'BE': 'Bélgica', 'CH': 'Suiza', 'AT': 'Austria',
    'PL': 'Polonia', 'SE': 'Suecia', 'NO': 'Noruega', 'DK': 'Dinamarca',
    'FI': 'Finlandia', 'IE': 'Irlanda', 'CZ': 'República Checa',
    'HU': 'Hungría', 'RO': 'Rumanía', 'RU': 'Rusia', 'TR': 'Turquía',
    'AU': 'Australia', 'CA': 'Canadá', 'MX': 'México', 'BR': 'Brasil',
    'AR': 'Argentina', 'CL': 'Chile', 'CO': 'Colombia', 'JP': 'Japón',
    'CN': 'China', 'KR': 'Corea del Sur', 'IN': 'India', 'ZA': 'Sudáfrica',
    'IL': 'Israel', 'AE': 'Emiratos Árabes Unidos', 'SA': 'Arabia Saudita',
    'GR': 'Grecia', 'HR': 'Croacia', 'SK': 'Eslovaquia', 'UA': 'Ucrania',
  };

  const paisSel = document.getElementById('sle_pais');
  if (paisSel && order.country) {
    const code = (order.country || '').toUpperCase().trim();
    const countryName = COUNTRY_MAP[code] || '';

    // Buscar por valor exacto, luego por texto del nombre mapeado, luego por código
    const countryOpt = Array.from(paisSel.options).find(o => o.value.toUpperCase() === code) ||
                       Array.from(paisSel.options).find(o => countryName && o.text?.includes(countryName)) ||
                       Array.from(paisSel.options).find(o => o.text?.toUpperCase().includes(code));

    if (countryOpt) {
      await scrollTo(paisSel);
      paisSel.value = countryOpt.value;
      paisSel.dispatchEvent(new Event('change', { bubbles: true }));
      await randomDelay(200, 400);
    }
  }

  sendStep(6, 'Llenando nombres de visitantes...');

  for (let i = 0; i < visitors.length; i++) {
    const el = document.getElementById(`dadesAsistent_nom_${i}`);
    if (el) { await scrollTo(el); await humanType(el, visitors[i].name); }
  }

  // Scroll hasta el reCAPTCHA
  const recaptcha = document.querySelector('.g-recaptcha, [class*="recaptcha"]');
  if (recaptcha) await scrollTo(recaptcha);

  // Limpiar estado guardado
  chrome.storage.local.remove('pendingOrder');

  sendDone('¡Formulario completado! Resolvé el reCAPTCHA y completá el pago.');
}

// ── Al cargar la página: verificar orden pendiente O hash #scoporder=ID ─────
chrome.storage.local.get('pendingOrder', async (res) => {
  // 1. Continuación tras navegación a carritoActivitats
  if (res.pendingOrder) {
    const { order, resumeStep } = res.pendingOrder;
    if (resumeStep === 5 && window.location.href.includes('carritoActivitats')) {
      fillPersonalData(order).catch(err => sendError(err.message));
      return;
    }
  }

  // 2. Precarga desde URL hash: #scoporder=ORDER_ID
  const hash = window.location.hash;
  const match = hash.match(/#scoporder=([a-zA-Z0-9-]+)/);
  if (!match) return;

  const orderId = match[1];
  try {
    const order = await fetchOrder(orderId);
    // Enviar al popup para que precargue el form
    chrome.runtime.sendMessage({ type: 'PRELOAD', order }).catch(() => {});
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'ERROR', text: err.message }).catch(() => {});
  }
});

// ── Escuchar mensaje RUN_BOT desde el popup ───────────────────────────────────
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.action !== 'RUN_BOT') return;

  const { order } = msg;
  const { date, timeSlot, tickets, visitors } = order;
  const [year, month, day] = date.split('-').map(Number);

  try {

    // ── PASO 1: Seleccionar actividad y avanzar a Tarifas ─────────────────
    sendStep(1, 'Seleccionando actividad...');

    // La página es una SPA — todas las secciones están en el DOM, se muestran/ocultan con CSS
    // iNumPers_1 puede existir en el DOM pero estar oculto (display:none)
    // Verificar si ya hay una actividad seleccionada (tiene "Quitar Actividad" visible)
    function isActivitySelected() {
      return Array.from(document.querySelectorAll('img'))
        .some(img => {
          if (!img.alt?.includes('Entrada al Park') && !img.alt?.includes('Admission to Park')) return false;
          const container = img.closest('div, li');
          if (!container) return false;
          return Array.from(container.querySelectorAll('*'))
            .some(el => el.offsetParent && (
              (el.innerText || '').includes('Quitar') ||
              (el.innerText || '').includes('Treure') ||
              (el.innerText || '').includes('Remove')
            ));
        });
    }

    if (!isActivitySelected()) {
      // Seleccionar la actividad: buscar img "Entrada al Park" cuyo contenedor NO tiene "Quitar"
      const imgs = Array.from(document.querySelectorAll('img'))
        .filter(img => img.alt?.includes('Entrada al Park') || img.alt?.includes('Admission to Park'));

      let selectLink = null;
      for (const img of imgs) {
        const container = img.closest('div, li');
        if (!container) continue;
        const hasQuitar = Array.from(container.querySelectorAll('*'))
          .some(el => el.offsetParent && ((el.innerText || '').includes('Quitar') || (el.innerText || '').includes('Treure')));
        if (hasQuitar) continue;
        // Este contenedor no tiene actividad seleccionada — buscar el primer link
        const link = Array.from(container.querySelectorAll('a')).find(a => a.offsetParent && a.href?.includes('#'));
        if (link) { selectLink = link; break; }
      }

      if (!selectLink) { sendError('No se encontró la actividad "Entrada al Park Güell".'); return; }
      await scrollTo(selectLink);
      await randomDelay(500, 800);
      selectLink.click();
      // Esperar que iNumPers_1 sea visible — indica que Tarifas cargó correctamente
      await new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const el = document.getElementById(TICKET_SELECT_IDS.general);
          if (el && el.offsetParent !== null) return resolve();
          if (Date.now() - start > 15000) return reject(new Error('Timeout esperando pantalla de Tarifas tras seleccionar actividad'));
          setTimeout(check, 300);
        };
        check();
      });
      await randomDelay(400, 600);
    } else {
      // Actividad ya seleccionada — avanzar con Continuar si Tarifas no es visible
      const el = document.getElementById(TICKET_SELECT_IDS.general);
      if (!el || el.offsetParent === null) {
        const continuarBtn = Array.from(document.querySelectorAll('button'))
          .find(btn => btn.offsetParent && (btn.innerText?.trim() === 'Continuar' || btn.innerText?.trim() === 'Continue' || btn.innerText?.trim() === 'Continuer'));
        if (continuarBtn) {
          await scrollTo(continuarBtn);
          await randomDelay(400, 600);
          continuarBtn.click();
          await new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
              const el2 = document.getElementById(TICKET_SELECT_IDS.general);
              if (el2 && el2.offsetParent !== null) return resolve();
              if (Date.now() - start > 15000) return reject(new Error('Timeout esperando sección de Tarifas'));
              setTimeout(check, 200);
            };
            check();
          });
        }
      }
    }
    await randomDelay(500, 800);

    // Forzar idioma inglés para que el calendario muestre meses en inglés
    const engLink = Array.from(document.querySelectorAll('a')).find(el => el.innerText?.trim() === 'English' && el.offsetParent);
    if (engLink) { engLink.click(); await randomDelay(500, 800); }

    // ── PASO 2: Seleccionar tickets ────────────────────────────────────────
    sendStep(2, 'Seleccionando cantidad de tickets...');

    for (const [type, qty] of Object.entries(tickets)) {
      const selectId = TICKET_SELECT_IDS[type];
      if (!selectId || qty <= 0) continue;
      const sel = document.getElementById(selectId);
      if (!sel) { sendError(`Select no encontrado: ${selectId}`); return; }
      await scrollTo(sel);
      sel.value = String(qty);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await randomDelay(300, 700);
    }

    const nextBtns = Array.from(document.querySelectorAll('button, input[type="button"], div'))
      .filter(el => ['Next','Siguiente','Continuar'].includes(el.innerText?.trim()) && el.offsetParent);
    if (!nextBtns.length) { sendError('Botón Next no encontrado'); return; }
    await scrollTo(nextBtns[nextBtns.length - 1]);
    await randomDelay(300, 600);
    nextBtns[nextBtns.length - 1].click();
    await waitFor('td[data-handler="selectDay"]', 20000);
    await randomDelay(600, 1200);

    // ── PASO 3: Seleccionar fecha ──────────────────────────────────────────
    sendStep(3, `Seleccionando fecha ${date}...`);

    // Leer mes/año directamente del DOM del datepicker (data-month es 0-indexed)
    function getCalendarMonthYear() {
      const header = document.querySelector('.ui-datepicker-header, [class*="datepicker"] th, [class*="datepicker"] .title');
      // jQuery UI guarda data-month (0=Enero) y data-year en los td
      const anyDay = document.querySelector('td[data-month]');
      if (anyDay) {
        return {
          month: parseInt(anyDay.getAttribute('data-month')) + 1, // convertir a 1-indexed
          year:  parseInt(anyDay.getAttribute('data-year'))
        };
      }
      // Fallback: buscar en el título del calendario
      const titleEl = document.querySelector('.ui-datepicker-title, .ui-datepicker-month');
      if (titleEl) {
        // El título tiene el mes como texto — no confiable, usar solo como último recurso
        return null;
      }
      return null;
    }

    for (let attempt = 0; attempt < 12; attempt++) {
      const cal = getCalendarMonthYear();
      if (cal && cal.month === month && cal.year === year) break;
      if (cal && (cal.year > year || (cal.year === year && cal.month > month))) {
        // Nos pasamos — ir hacia atrás
        const prevArrows = Array.from(document.querySelectorAll('a, span, div, button'))
          .filter(el => (el.innerText?.trim() === '<' || el.innerText?.trim() === '‹' ||
            el.className?.includes('prev') || el.className?.includes('anterior')) && el.offsetParent);
        if (prevArrows.length) { prevArrows[0].click(); await randomDelay(400, 700); }
        else break;
      } else {
        // Avanzar al siguiente mes
        const nextArrows = Array.from(document.querySelectorAll('a, span, div, button'))
          .filter(el => (el.innerText?.trim() === '>' || el.innerText?.trim() === '›' ||
            el.className?.includes('next') || el.className?.includes('siguiente')) && el.offsetParent);
        if (nextArrows.length) { nextArrows[0].click(); await randomDelay(400, 700); }
        else break;
      }
    }

    const dayTds = Array.from(document.querySelectorAll('td[data-handler="selectDay"]'));
    const dayTd = dayTds.find(td => {
      const a = td.querySelector('a');
      return a && a.innerText?.trim() === String(day) && !td.classList.contains('ui-datepicker-unselectable');
    });
    if (!dayTd) { sendError(`Día ${day} no disponible o no encontrado en el calendario`); return; }
    await scrollTo(dayTd.querySelector('a'));
    await randomDelay(300, 600);
    dayTd.querySelector('a').click();

    // Esperar que aparezcan los slots — cualquier elemento con id "sessio_"
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        // Buscar slots visibles de multiples formas
        const byContainer = document.getElementById('tabla_horarios');
        const hasSlots = byContainer && byContainer.querySelector('[id^="sessio_"]');
        const directSlot = document.querySelector('[id^="sessio_1_"]');
        if (hasSlots || directSlot) return resolve();
        if (Date.now() - start > 20000) return reject(new Error('Timeout esperando slots de horario. Verificá que la fecha seleccionada tenga disponibilidad.'));
        setTimeout(check, 300);
      };
      check();
    });
    await randomDelay(500, 800);

    // ── PASO 4: Seleccionar horario ────────────────────────────────────────
    sendStep(4, `Seleccionando horario ${timeSlot}...`);

    const slotId = timeToSlotId(timeSlot);
    let slotEl = document.getElementById(slotId);

    // Si no encuentra por ID exacto, buscar por texto del horario
    if (!slotEl) {
      slotEl = Array.from(document.querySelectorAll('[id^="sessio_1_"]'))
        .find(el => {
          const text = el.innerText || el.textContent || '';
          return text.includes(timeSlot) && el.offsetParent;
        });
    }
    if (!slotEl) { sendError(`Slot ${timeSlot} no encontrado (ID: ${slotId}). Puede estar agotado o el formato del ID cambió.`); return; }
    await scrollTo(slotEl);
    await randomDelay(300, 600);
    slotEl.click();
    await randomDelay(400, 800);

    // Guardar orden en storage ANTES de navegar — la nueva página la leerá
    await chrome.storage.local.set({ pendingOrder: { order, resumeStep: 5 } });

    // Click Next → navega a carritoActivitats.jsp (nueva URL, el script se recarga)
    const nextBtns2 = Array.from(document.querySelectorAll('button, input[type="button"], div'))
      .filter(el => ['Next','Siguiente','Continuar'].includes(el.innerText?.trim()) && el.offsetParent);
    if (!nextBtns2.length) { sendError('Botón Next (paso 4) no encontrado'); return; }
    await scrollTo(nextBtns2[nextBtns2.length - 1]);
    await randomDelay(300, 600);
    nextBtns2[nextBtns2.length - 1].click();

    // El script se va a recargar en la nueva página — fillPersonalData se llama automáticamente

  } catch (err) {
    sendError(err.message);
  }
});

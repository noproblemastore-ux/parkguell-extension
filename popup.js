// ── Ticket fields → select IDs en el sitio ───────────────────────────────────
const TICKET_MAP = {
  'general':              'iNumPers_1',
  'children-7-12':        'iNumPers_3',
  'children-0-6':         'iNumPers_24',
  'over65':               'iNumPers_4',
  'targeta-rosa-reduida':  'iNumPers_30',
  'disabilities':         'iNumPers_14',
};

const TICKET_LABELS = {
  'general':             'General',
  'children-7-12':       'Niño 7–12',
  'children-0-6':        'Niño 0–6',
  'over65':              '+65 años',
  'targeta-rosa-reduida': 'T.Rosa Reduïda',
  'disabilities':        'Discapacidad',
};

const SUPABASE_URL  = 'https://odhogdwxafqdlfvfbsux.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kaG9nZHd4YWZxZGxmdmZic3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMTM2MDAsImV4cCI6MjA4OTY4OTYwMH0.sDgtKOdVeK9Xf7VI2aNQhUO5Hs_rY2tmXD1z5pHayF8';

function orderToForm(row) {
  const tickets = {};
  if ((row.qty_adults  || 0) > 0) tickets['general']       = row.qty_adults;
  if ((row.qty_children|| 0) > 0) tickets['children-7-12'] = row.qty_children;
  if ((row.qty_seniors || 0) > 0) tickets['over65']        = row.qty_seniors;
  if ((row.qty_infants || 0) > 0) tickets['children-0-6']  = row.qty_infants;

  const visitors = [];
  if (row.visitor_name) visitors.push({ name: row.visitor_name.trim() });
  let companions = row.companion_names || [];
  if (typeof companions === 'string') { try { companions = JSON.parse(companions); } catch { companions = []; } }
  for (const c of companions) {
    const name = c.replace(/\s*\[.*\]/, '').trim();
    if (name) visitors.push({ name });
  }

  return { date: row.visit_date, timeSlot: row.time_slot, tickets, visitors };
}

function fillForm(order) {
  if (order.date)     document.getElementById('visit-date').value = order.date;
  if (order.timeSlot) document.getElementById('time-slot').value  = order.timeSlot;
  if (order.tickets) {
    for (const [key, val] of Object.entries(order.tickets)) {
      const el = document.getElementById(`t-${key}`);
      if (el) el.value = val;
    }
  }
  updateVisitorFields();
  if (order.visitors) restoreVisitors(order.visitors);
  chrome.storage.local.set({ lastOrder: order });
}

// ── Al abrir el popup: verificar si la pestaña activa tiene #scoporder=ID ────
async function checkTabForOrder() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return false;

    const match = tab.url.match(/#scoporder=([a-zA-Z0-9-]+)/);
    if (!match) return false;

    const orderId = match[1];
    setStatus('⏳ Cargando orden...', 'info');

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*&limit=1`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) throw new Error('Orden no encontrada');

    const order = orderToForm(rows[0]);
    fillForm(order);
    setStatus('✅ Orden precargada — revisá y clickeá Completar', 'success');
    return true;
  } catch (err) {
    setStatus('❌ Error cargando orden: ' + err.message, 'error');
    return false;
  }
}

// ── Restaurar datos guardados ────────────────────────────────────────────────
async function initPopup() {
  // Primero intentar cargar desde la URL de la pestaña activa
  const loadedFromTab = await checkTabForOrder();

  // Si no había orden en la URL, restaurar última orden guardada
  if (!loadedFromTab) {
    chrome.storage.local.get(['lastOrder'], (res) => {
      if (res.lastOrder) {
        fillForm(res.lastOrder);
      }
    });
  }
}

initPopup();

// ── Actualizar campos de visitantes cuando cambian los tickets ───────────────
const ticketInputs = document.querySelectorAll('.ticket-field input');
ticketInputs.forEach(inp => inp.addEventListener('input', updateVisitorFields));

function getTotalTickets() {
  let total = 0;
  ticketInputs.forEach(inp => { total += parseInt(inp.value) || 0; });
  return total;
}

function updateVisitorFields() {
  const container = document.getElementById('visitors-container');
  const total = getTotalTickets();
  const existing = container.querySelectorAll('input[data-visitor]');

  if (total === 0) {
    container.innerHTML = '<div style="font-size:11px; color:#999; text-align:center; padding:6px 0;">Completá los tickets arriba para ver los campos</div>';
    return;
  }

  // Guardar valores existentes
  const currentValues = {};
  existing.forEach(inp => { currentValues[inp.dataset.visitor] = inp.value; });

  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const row = document.createElement('div');
    row.className = 'visitor-row';
    row.innerHTML = `
      <div class="visitor-num">${i + 1}</div>
      <input type="text" data-visitor="${i}" placeholder="Nombre y apellido completo" value="${currentValues[i] || ''}">
    `;
    container.appendChild(row);
  }
}

function restoreVisitors(visitors) {
  // Se llama después de updateVisitorFields
  setTimeout(() => {
    const inputs = document.querySelectorAll('input[data-visitor]');
    inputs.forEach((inp, i) => {
      if (visitors[i]) inp.value = visitors[i].name || '';
    });
  }, 50);
}

// ── Estado y pasos ───────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = `status ${type}`;
}

function setStep(n, state) {
  // state: 'active' | 'done' | ''
  const el = document.getElementById(`s${n}`);
  if (el) { el.className = 'step'; if (state) el.classList.add(state); }
}

function resetSteps() {
  for (let i = 1; i <= 6; i++) setStep(i, '');
}

// ── Click en botón ───────────────────────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', async () => {
  const date     = document.getElementById('visit-date').value;
  const timeSlot = document.getElementById('time-slot').value;

  if (!date)     { setStatus('⚠️ Seleccioná la fecha', 'error'); return; }
  if (!timeSlot) { setStatus('⚠️ Seleccioná la hora', 'error'); return; }

  const tickets = {};
  ticketInputs.forEach(inp => {
    const key = inp.id.replace('t-', '');
    const val = parseInt(inp.value) || 0;
    if (val > 0) tickets[key] = val;
  });

  if (Object.keys(tickets).length === 0) {
    setStatus('⚠️ Seleccioná al menos 1 ticket', 'error');
    return;
  }

  const visitorInputs = document.querySelectorAll('input[data-visitor]');
  const visitors = [];
  let missingVisitor = false;
  visitorInputs.forEach((inp, i) => {
    if (!inp.value.trim()) { missingVisitor = true; }
    visitors.push({ name: inp.value.trim() });
  });

  if (missingVisitor) {
    setStatus('⚠️ Completá todos los nombres de visitantes', 'error');
    return;
  }

  const order = { date, timeSlot, tickets, visitors };

  // Guardar para próxima vez
  chrome.storage.local.set({ lastOrder: order });

  // Deshabilitar botón
  const btn = document.getElementById('btn-run');
  btn.disabled = true;
  btn.textContent = '⏳ Ejecutando...';
  resetSteps();
  setStatus('Iniciando...', 'info');

  // Inyectar en la pestaña activa
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes('parkguellonline.cat')) {
    setStatus('❌ Abrí el sitio de Park Güell primero:\nhttps://www.parkguellonline.cat/pg_muslinkIII/venda/index.jsp?lang=3&nom_cache=PARC&property=PARC', 'error');
    btn.disabled = false;
    btn.textContent = '▶ Completar formulario';
    return;
  }

  // Siempre reinyectar — previene el error de bfcache que cierra el canal
  try {
    // Resetear el flag para permitir reinyección
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window.__scopBotLoaded = false; }
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await new Promise(r => setTimeout(r, 400));
  } catch (e) {
    setStatus('❌ No se pudo inyectar: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '▶ Completar formulario';
    return;
  }

  // Enviar orden al content script con retry si el canal falla
  async function sendWithRetry(retries = 3) {
    for (let i = 0; i < retries; i++) {
      const ok = await new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, { action: 'RUN_BOT', order }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
      if (ok) return true;
      // Canal cerrado — reinyectar y reintentar
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__scopBotLoaded = false; } });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 500));
      } catch(e) {}
    }
    return false;
  }

  const sent = await sendWithRetry();
  if (!sent) {
    setStatus('❌ No se pudo conectar con la página. Recargá la página e intentá de nuevo.', 'error');
    btn.disabled = false;
    btn.textContent = '▶ Completar formulario';
  }

  // Escuchar progreso del content script
  chrome.runtime.onMessage.addListener(function listener(msg) {
    if (msg.type === 'STEP') {
      setStep(msg.step, 'active');
      if (msg.step > 1) setStep(msg.step - 1, 'done');
      setStatus(msg.text, 'info');
    }
    if (msg.type === 'DONE') {
      for (let i = 1; i <= 6; i++) setStep(i, 'done');
      setStatus('✅ ' + msg.text, 'success');
      btn.disabled = false;
      btn.textContent = '▶ Completar formulario';
      chrome.runtime.onMessage.removeListener(listener);
    }
    if (msg.type === 'ERROR') {
      setStatus('❌ ' + msg.text, 'error');
      btn.disabled = false;
      btn.textContent = '▶ Completar formulario';
      chrome.runtime.onMessage.removeListener(listener);
    }
  });
});


let opUserId = null;
let chatActivoUserId = null;
let jugadorCaja = null;
let chatChannel = null;
let perfilesMap = {};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('op-login').addEventListener('click', loginOperador);
    document.getElementById('op-logout').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        window.location.reload();
    });
    document.getElementById('op-chat-form').addEventListener('submit', enviarRespuesta);
    document.getElementById('caja-buscar').addEventListener('click', buscarJugador);
    document.getElementById('caja-cargar').addEventListener('click', () => moverFichas(1));
    document.getElementById('caja-descontar').addEventListener('click', () => moverFichas(-1));
    document.querySelectorAll('[data-caja]').forEach((b) => {
        b.addEventListener('click', () => {
            const inp = document.getElementById('caja-monto');
            inp.value = (parseFloat(inp.value) || 0) + Number(b.dataset.caja);
        });
    });
    document.getElementById('op-pass').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loginOperador();
    });
});

supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (!session) {
        document.getElementById('op-gate').classList.remove('hidden');
        document.getElementById('op-app').classList.add('hidden');
        return;
    }
    opUserId = session.user.id;
    const perfil = await cargarPerfilCompleto(session.user.id);
    if (!perfil || (perfil.rol !== 'operador' && perfil.rol !== 'admin')) {
        document.getElementById('op-gate').classList.remove('hidden');
        document.getElementById('op-app').classList.add('hidden');
        document.getElementById('op-gate-msg').innerText = 'Esta cuenta no es operador. En Supabase: UPDATE perfiles SET rol = \'operador\' WHERE id = \'...\'';
        return;
    }
    document.getElementById('op-gate').classList.add('hidden');
    document.getElementById('op-app').classList.remove('hidden');
    document.getElementById('op-who').innerText = perfil.username || session.user.email;
    insertarBotonAyuda();
    await cargarPerfiles();
    await cargarConversaciones();
    await cargarSolicitudes();
    suscribirRealtime();
});

async function loginOperador() {
    const email = document.getElementById('op-email').value.trim();
    const password = document.getElementById('op-pass').value;
    const msg = document.getElementById('op-gate-msg');
    msg.innerText = 'Entrando...';
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) msg.innerText = 'Correo o contraseña incorrectos.';
}

async function cargarPerfiles() {
    const { data } = await supabaseClient.from('perfiles').select('id, username, saldo, rol');
    perfilesMap = {};
    (data || []).forEach((p) => { perfilesMap[p.id] = p; });
}

function nombreDe(uid) {
    const p = perfilesMap[uid];
    if (p && p.username) return p.username;
    return 'Jugador ' + String(uid).slice(0, 6);
}

async function cargarConversaciones() {
    const box = document.getElementById('op-convos');
    const { data, error } = await supabaseClient
        .from('chat_mensajes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(400);
    if (error) {
        box.innerHTML = '<p class="empty-msg">Corrê el SQL para activar el chat.</p>';
        return;
    }
    const seen = new Map();
    (data || []).forEach((m) => {
        if (!seen.has(m.user_id)) seen.set(m.user_id, m);
    });
    if (!seen.size) {
        box.innerHTML = '<p class="empty-msg">Nadie escribió todavía.</p>';
        return;
    }
    box.innerHTML = '';
    seen.forEach((m, uid) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'op-convo' + (uid === chatActivoUserId ? ' active' : '');
        btn.innerHTML = `<strong>${escapeHtml(nombreDe(uid))}</strong><span>${escapeHtml((m.mensaje || '').slice(0, 42))}</span>`;
        btn.addEventListener('click', () => abrirChat(uid));
        box.appendChild(btn);
    });
}

async function abrirChat(uid) {
    chatActivoUserId = uid;
    document.getElementById('op-chat-title').innerText = nombreDe(uid);
    const p = perfilesMap[uid];
    document.getElementById('op-chat-sub').innerText = p ? 'Saldo ' + formatMoney(p.saldo || 0) : '';
    jugadorCaja = p ? { ...p, id: uid } : { id: uid };
    pintarCajaResultado();
    await cargarMensajesOp();
    cargarConversaciones();
}

async function cargarMensajesOp() {
    const box = document.getElementById('op-messages');
    if (!chatActivoUserId) return;
    const { data } = await supabaseClient
        .from('chat_mensajes')
        .select('*')
        .eq('user_id', chatActivoUserId)
        .order('created_at', { ascending: true });
    box.innerHTML = '';
    (data || []).forEach((m) => {
        const div = document.createElement('div');
        div.className = 'chat-bubble ' + (m.es_operador ? 'from-op' : 'from-me');
        div.innerHTML = `<p>${escapeHtml(m.mensaje)}</p><small>${formatFecha(m.created_at)}</small>`;
        box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
}

async function enviarRespuesta(e) {
    e.preventDefault();
    if (!chatActivoUserId) return;
    const input = document.getElementById('op-chat-input');
    const texto = (input.value || '').trim();
    if (!texto) return;
    input.value = '';
    const { error } = await supabaseClient.from('chat_mensajes').insert([{
        user_id: chatActivoUserId,
        mensaje: texto,
        es_operador: true
    }]);
    if (error) alert(error.message);
}

function suscribirRealtime() {
    if (chatChannel) supabaseClient.removeChannel(chatChannel);
    chatChannel = supabaseClient
        .channel('op-chat')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_mensajes' }, (payload) => {
            cargarConversaciones();
            if (payload.new.user_id === chatActivoUserId) cargarMensajesOp();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitudes_carga' }, () => {
            cargarSolicitudes();
        })
        .subscribe();
}

async function buscarJugador() {
    const q = document.getElementById('caja-q').value.trim();
    const msg = document.getElementById('caja-msg');
    if (!q) return;
    await cargarPerfiles();
    const { data: byUser } = await supabaseClient.from('perfiles').select('*').ilike('username', q).limit(5);
    let found = byUser && byUser[0];
    if (!found) {
        const { data: users } = await supabaseClient.from('perfiles').select('*');
        found = (users || []).find((p) => (p.username || '').toLowerCase() === q.toLowerCase());
    }
    if (!found) {
        msg.innerText = 'No se encontró. Buscá por nombre de usuario exacto.';
        msg.style.color = '#ff4d4d';
        jugadorCaja = null;
        pintarCajaResultado();
        return;
    }
    jugadorCaja = found;
    msg.innerText = '';
    pintarCajaResultado();
}

function pintarCajaResultado() {
    const box = document.getElementById('caja-resultado');
    if (!jugadorCaja) {
        box.innerHTML = '';
        return;
    }
    box.innerHTML = `<div class="caja-card"><strong>${escapeHtml(jugadorCaja.username || jugadorCaja.id.slice(0, 8))}</strong><span>Saldo ${formatMoney(jugadorCaja.saldo || 0)}</span></div>`;
}

async function moverFichas(signo) {
    const msg = document.getElementById('caja-msg');
    if (!jugadorCaja) {
        msg.innerText = 'Buscá un jugador primero.';
        msg.style.color = '#ff4d4d';
        return;
    }
    const monto = parseFloat(document.getElementById('caja-monto').value);
    if (!Number.isFinite(monto) || monto <= 0) {
        msg.innerText = 'Monto inválido.';
        msg.style.color = '#ff4d4d';
        return;
    }
    const { data: fresh } = await supabaseClient.from('perfiles').select('saldo').eq('id', jugadorCaja.id).single();
    const actual = Number(fresh && fresh.saldo) || 0;
    const nuevo = actual + signo * monto;
    if (nuevo < 0) {
        msg.innerText = 'El saldo no puede quedar negativo.';
        msg.style.color = '#ff4d4d';
        return;
    }
    const { error } = await supabaseClient.from('perfiles').update({ saldo: nuevo }).eq('id', jugadorCaja.id);
    if (error) {
        msg.innerText = error.message;
        msg.style.color = '#ff4d4d';
        return;
    }
    await registrarTransaccion(
        jugadorCaja.id,
        signo > 0 ? 'carga_cajero' : 'descuento_cajero',
        signo * monto,
        nuevo,
        'Operador ' + (signo > 0 ? 'acreditó' : 'descontó') + ' fichas'
    );
    jugadorCaja.saldo = nuevo;
    perfilesMap[jugadorCaja.id] = { ...perfilesMap[jugadorCaja.id], saldo: nuevo };
    pintarCajaResultado();
    msg.innerText = (signo > 0 ? 'Cargadas ' : 'Descontadas ') + formatMoney(monto);
    msg.style.color = '#2ecc71';
}

async function cargarSolicitudes() {
    const box = document.getElementById('op-solicitudes');
    const { data, error } = await supabaseClient
        .from('solicitudes_carga')
        .select('*')
        .eq('estado', 'pendiente')
        .order('created_at', { ascending: true });
    if (error) {
        box.innerHTML = '<p class="empty-msg">Corrê el SQL para ver solicitudes.</p>';
        return;
    }
    // Los retiros los puede atender cualquier operador. Los depósitos solo
    // se muestran al operador elegido por el jugador (o a todos si es una
    // solicitud vieja que no tiene operador asignado).
    const propias = (data || []).filter((s) => {
        const tipo = s.tipo || (s.metodo === 'retiro' ? 'retiro' : 'deposito');
        if (tipo === 'retiro') return true;
        return !s.operador_id || s.operador_id === opUserId;
    });
    if (!propias.length) {
        box.innerHTML = '<p class="empty-msg">No hay solicitudes pendientes.</p>';
        return;
    }
    box.innerHTML = '';
    propias.forEach((s) => {
        const div = document.createElement('div');
        div.className = 'sol-card';
        const tipo = s.tipo || (s.metodo === 'retiro' ? 'retiro' : 'deposito');
        div.innerHTML = `<div><strong>${escapeHtml(nombreDe(s.user_id))}</strong><br><small>${escapeHtml(tipo)} · ${formatFecha(s.created_at)}</small></div>
            <strong>${formatMoney(s.monto)}</strong>
            <div class="sol-actions">
                <button type="button" class="ok">Aprobar</button>
                <button type="button" class="no">Rechazar</button>
            </div>`;
        div.querySelector('.ok').addEventListener('click', () => resolverSolicitud(s, true));
        div.querySelector('.no').addEventListener('click', () => resolverSolicitud(s, false));
        box.appendChild(div);
    });
}

async function resolverSolicitud(s, aprobar) {
    if (aprobar) {
        const { data: fresh } = await supabaseClient.from('perfiles').select('saldo').eq('id', s.user_id).single();
        const actual = Number(fresh && fresh.saldo) || 0;
        const tipo = s.tipo || (s.metodo === 'retiro' ? 'retiro' : 'deposito');
        const delta = tipo === 'retiro' ? -Number(s.monto) : Number(s.monto);
        const nuevo = actual + delta;
        if (nuevo < 0) {
            alert('El jugador no tiene saldo para ese retiro.');
            return;
        }
        await supabaseClient.from('perfiles').update({ saldo: nuevo }).eq('id', s.user_id);
        await registrarTransaccion(s.user_id, tipo, delta, nuevo, 'Solicitud ' + s.metodo);
    }
    await supabaseClient.from('solicitudes_carga').update({
        estado: aprobar ? 'aprobada' : 'rechazada',
        procesado_por: opUserId,
        procesado_at: new Date().toISOString()
    }).eq('id', s.id);
    await cargarPerfiles();
    await cargarSolicitudes();
}

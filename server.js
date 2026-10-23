require('dotenv').config();

// Manejo global de excepciones para prevenir caídas del servidor
process.on('uncaughtException', (err) => {
    if (['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(err.code)) return;
    console.error('💥 [Backend storage_ram_db] Uncaught Exception:', err.message || err);
    if (err.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 [Backend storage_ram_db] Unhandled Rejection:', reason);
});

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// ==============================================================
// 📦 MÓDULOS PROPIOS
// ==============================================================
const { fetchRango, serviceAccountAuth, ID_SPREADSHEET_MASTER } = require('./utils/shared');
const { cargarNovedades, createNovedadesRouter } = require('./novedades');
const webhookRouter = require('./webhook');
const { iniciarCachePolling } = require('./cache/builder');
const createAuthRouter = require('./routes/auth');
const createProxyRouter = require('./routes/proxy');
const createFotosRouter = require('./routes/fotos');
const createDashRouter = require('./routes/dash');
const createDiagramasRouter = require('./routes/diagramas');
const createServiciosRouter = require('./routes/servicios');
const createActivosRouter = require('./routes/activos');
const createMovimientosRouter = require('./routes/movimientos');

// ==============================================================
// 🚀 EXPRESS + SOCKET.IO
// ==============================================================
const app = express();
app.use(compression());
const server = http.createServer(app);

// ==============================================================
// 🛡️ CONFIGURACIÓN DE CORS
// ==============================================================
const dominiosPermitidos = [
    "https://diagramas-hp1p.onrender.com",
    "https://diagramasnode.onrender.com",
    "http://localhost:3000",
    "https://dash-aa1f.onrender.com"
];

const checkOrigin = function(origin, callback) {
    if (!origin) return callback(null, true);
    if (dominiosPermitidos.includes(origin) || origin.endsWith('.onrender.com') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return callback(null, true);
    }
    return callback(null, true);
};

const corsConfig = {
    origin: checkOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
};

const io = new Server(server, {
    cors: corsConfig,
    transports: ['websocket', 'polling']
});

// Namespace dedicado para DASH — recibe solo novedades
const ioDash = io.of('/dash');

app.use(cors(corsConfig));
app.options(/(.*)/, cors(corsConfig));
app.use(express.json({ limit: '10mb' }));

// ==============================================================
// 🧠 ESTADO GLOBAL (RAM compartida)
// ==============================================================
let cacheDatosGlobales = {
    diagramas: null,
    nombresMesActual: [],
    ultimaActualizacion: null,
    novedades: []
};

// ==============================================================
// ⏱️ INICIAR CACHE + POLLING
// ==============================================================
iniciarCachePolling(cacheDatosGlobales, io, ioDash);

// ==============================================================
// 🛣️ RUTAS
// ==============================================================

// Health check & Keep-Alive pinger (Free Tier idle-reset)
app.get(['/health', '/ping'], (req, res) => res.status(200).send('OK'));

// Datos principales (lectura)
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });

    // Enviar el objeto completo incluyendo la ventana de 60 días de KM en RAM (nuevaSeccionViajes)
    const payload = {
        ...cacheDatosGlobales.diagramas,
        nuevaSeccionViajes: cacheDatosGlobales.diagramas.nuevaSeccionViajes || {}
    };

    // Cabecera de caché para permitir respuestas 304 Not Modified con ETag
    res.set('Cache-Control', 'public, max-age=10, must-revalidate');

    const clientEtag = req.headers['if-none-match'];
    const currentVersion = cacheDatosGlobales.ultimaActualizacion;
    if (clientEtag && (clientEtag === `"${currentVersion}"` || clientEtag === currentVersion || clientEtag.includes(currentVersion))) {
        return res.status(304).end();
    }
    if (currentVersion) {
        res.set('ETag', `"${currentVersion}"`);
    }

    res.json({
        success: true,
        diagramas: payload,
        ut: payload.ut || [],
        vencimientosObj: payload.vencimientosObj || [],
        timestamp: cacheDatosGlobales.ultimaActualizacion,
        usuarios: cacheDatosGlobales.usuarios || []
    });
});

// Viajes — Consulta histórica bajo demanda (Híbrido: RAM (2 meses) -> PostgreSQL movimientos_km -> Microservicio -> Cold Storage de respaldo)
app.get(['/api/viajes/historial', '/api/km/historial'], async (req, res) => {
    try {
        const { chofer, desde, hasta } = req.query;
        if (!chofer) return res.status(400).json({ error: "Falta parámetro 'chofer'" });
        
        const { normalizar, fetchRango, ID_SHEET_KILOMETROS, getFechaArgentina } = require('./utils/shared');
        const { isMicroservicioActivo, obtenerHistorialMicroservicio } = require('./utils/kmClient');
        const db = require('./utils/db');
        const nBuscado = normalizar(chofer);
        const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
        const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
        const limiteRamIso = new Date(hoyArKm.getTime() - (KM_RAM_DIAS * 24 * 3600 * 1000)).toISOString().split('T')[0];

        // 1. Si la consulta especifica un rango 'desde' que cae estrictamente dentro de la ventana de 2 meses en RAM
        if (desde && desde >= limiteRamIso && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) {
            const viajesRam = cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado] 
                || (nBuscado.includes('ñ') ? cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado.replace(/ñ/g, 'n')] : null)
                || {};
            let filtrados = {};
            for (let f in viajesRam) {
                if ((!desde || f >= desde) && (!hasta || f <= hasta)) {
                    filtrados[f] = viajesRam[f];
                }
            }
            if (Object.keys(filtrados).length > 0) {
                return res.json({ success: true, fuente: "RAM", data: filtrados });
            }
        }

        // 2. Si se solicitan fechas anteriores a los 2 meses o historial completo, consultar primero PostgreSQL nativo (pg)
        if (db.isConfigured()) {
            try {
                const choferClean = String(chofer).trim();
                let sql = `
                    SELECT fecha, dominio, km_totales, array_to_string(hoja_ruta, ', ') as hoja_ruta, id_unidad
                    FROM view_calendario_km
                    WHERE (chofer_nombre ILIKE $1 OR id_chofer::text = $2)
                `;
                const params = ['%' + choferClean + '%', choferClean];
                if (desde) {
                    params.push(desde);
                    sql += ` AND fecha >= $${params.length}::date`;
                }
                if (hasta) {
                    params.push(hasta);
                    sql += ` AND fecha <= $${params.length}::date`;
                }
                sql += ` ORDER BY fecha ASC`;

                const resPg = await db.query(sql, params);
                if (resPg.rows && resPg.rows.length > 0) {
                    const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
                    let resultadoPg = {};
                    resPg.rows.forEach(r => {
                        const iso = r.fecha instanceof Date ? r.fecha.toISOString().split('T')[0] : String(r.fecha).split('T')[0];
                        if (!resultadoPg[iso]) {
                            resultadoPg[iso] = { id_unidad: r.id_unidad || null, dominio: (r.dominio || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                        }
                        resultadoPg[iso].km += parseNum(r.km_totales);
                        if (r.hoja_ruta) {
                            String(r.hoja_ruta).split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(h => {
                                if (!resultadoPg[iso].hoja_ruta.includes(h)) resultadoPg[iso].hoja_ruta.push(h);
                            });
                        }
                    });
                    return res.json({ success: true, fuente: "POSTGRES_KM", data: resultadoPg });
                }
            } catch (dbErr) {
                console.warn("⚠️ [Server] Error consultando movimientos_km en Postgres, continuando a fallback:", dbErr.message);
            }
        }

        // 3. Fallback al microservicio exclusivo (Cold Index)
        if (isMicroservicioActivo()) {
            const histMicro = await obtenerHistorialMicroservicio(chofer, desde, hasta);
            if (histMicro && histMicro.success && Object.keys(histMicro.data || {}).length > 0) {
                return res.json(histMicro);
            }
        }

        // 4. Fallback de resiliencia final: Si no hay Postgres ni microservicio, consultar Sheets directamente
        console.warn("⚠️ [Server] Consultando Cold Storage directamente en Google Sheets (fallback)...");
        const rows = await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T");
        const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
        let resultado = {};

        rows.forEach(row => {
            let fRaw = row[1], nRaw = row[2]; if (!fRaw || !nRaw) return;
            let norm = normalizar(nRaw);
            if (norm !== nBuscado && norm.replace(/ñ/g, 'n') !== nBuscado.replace(/ñ/g, 'n')) return;

            let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
            if (parts.length >= 3) { let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2]; dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]); } else { dObj = new Date(fRaw); }
            if (isNaN(dObj.getTime())) return;
            let isoDate = dObj.toISOString().split('T')[0];

            if ((!desde || isoDate >= desde) && (!hasta || isoDate <= hasta)) {
                let km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]);
                let campo = parseNum(row[5]);
                let hojaStr = String(row[19] || "").trim();
                if (!resultado[isoDate]) resultado[isoDate] = { dominio: String(row[0] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                resultado[isoDate].km += km;
                resultado[isoDate].campo += campo;
                if (hojaStr) {
                    hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => {
                        if (!resultado[isoDate].hoja_ruta.includes(h)) resultado[isoDate].hoja_ruta.push(h);
                    });
                }
            }
        });

        res.json({ success: true, fuente: "COLD_STORAGE", data: resultado });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Webhook — Notificación de actualización desde microservicio KM para actualizar subnodos en vivo
app.post('/api/webhook/km-updated', async (req, res) => {
    try {
        console.log("📥 [Webhook] Ping de actualización recibido desde Microservicio KM");
        const { actualizarSubnodosKm } = require('./cache/builder');
        const ok = await actualizarSubnodosKm(cacheDatosGlobales, io);
        res.json({ success: ok, message: ok ? "Subnodos actualizados y broadcast emitido" : "No se pudo actualizar subnodos" });
    } catch (e) {
        console.error("❌ Error procesando webhook de KM:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Estado de salud y métricas de Kilómetros (RAM 60 días + PostgreSQL)
app.get('/api/km/status', async (req, res) => {
    try {
        const db = require('./utils/db');
        const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
        const ram = cacheDatosGlobales.diagramas?.nuevaSeccionViajes || {};
        const choferesEnRam = Object.keys(ram).length;
        let dbMetrics = null;
        if (db.isConfigured()) {
            try {
                const countRes = await db.query(`
                    SELECT COUNT(*)::int as total_registros,
                           MIN(fecha)::text as fecha_minima,
                           MAX(fecha)::text as fecha_maxima
                    FROM view_calendario_km
                `);
                dbMetrics = countRes.rows[0];
            } catch (e) {
                dbMetrics = { error: e.message };
            }
        }
        res.json({
            success: true,
            ram: {
                ventanaDias: KM_RAM_DIAS,
                choferesConViajes: choferesEnRam,
                estado: choferesEnRam > 0 ? "OPERATIVO" : "PENDIENTE"
            },
            database: dbMetrics
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// Estado de conexión y métricas de memoria de PostgreSQL (pg client)
app.get('/api/db/status', async (req, res) => {
    try {
        const db = require('./utils/db');
        const metrics = db.getPoolMetrics();
        let health = null;
        if (db.isConfigured()) {
            health = await db.checkHealth();
        }
        res.json({
            success: true,
            ...metrics,
            health
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Reensamblado manual o reactivo de memoria RAM desde Supabase
app.post(['/api/db/refresh', '/api/refresh'], async (req, res) => {
    try {
        const { flujoEncoladoGlobal } = require('./cache/builder');
        await flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, { forceFull: true, recargarKm: false });
        res.json({
            success: true,
            message: "Memoria RAM reensamblada desde Supabase exitosamente",
            timestamp: cacheDatosGlobales.ultimaActualizacion,
            unidadesCount: cacheDatosGlobales.ut ? cacheDatosGlobales.ut.length : 0,
            choferesCount: cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.diagramas ? cacheDatosGlobales.diagramas.diagramas.length : 0
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Auth — Login unificado (Sheets + Supabase)
app.use('/api/auth', createAuthRouter());

// Servicios — Catálogos canónicos de servicios (unidades y choferes)
app.use('/api/servicios', createServiciosRouter(cacheDatosGlobales));

// Activos — Catálogo canónico de tractores, semis y gestión de acoples
app.use('/api', createActivosRouter(cacheDatosGlobales, io));

// Movimientos — Partición 6: Recorte diario y sincronización Supabase (con desuniones)
app.use('/api/movimientos', createMovimientosRouter(cacheDatosGlobales, io, ioDash));

// Alias directo para trigger de Apps Script /sync
app.post('/sync', async (req, res) => {
    try {
        const { sincronizarMovimientosDesdeSheets } = require('./routes/movimientos');
        const resultado = await sincronizarMovimientosDesdeSheets(cacheDatosGlobales, io, ioDash, req.body?.dia);
        res.json(resultado);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DASH — API ligera (solo flota + usuarios, sin días) + Legajo bajo demanda
const dashRouter = createDashRouter(cacheDatosGlobales, io, ioDash);
app.use('/api/dash', dashRouter);
// Alias para acceso directo a chofer y legajo desde el frontend (/api/chofer/:id/legajo)
app.use('/api/chofer', (req, res, next) => {
    req.url = '/chofer' + req.url;
    dashRouter(req, res, next);
});

// Diagramas — Consultas bajo demanda e historial completo (Supabase)
const diagramasRouter = createDiagramasRouter();
app.use('/api/diagramas', diagramasRouter);
app.use('/diagramas', diagramasRouter);

// Novedades — CRUD + Polling
app.use('/api/novedades', createNovedadesRouter(cacheDatosGlobales, io, ioDash, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango));

// Proxy — Escritura directa a Google Sheets (observaciones, docs, estados, hojas de ruta)
app.use('/api/proxy', createProxyRouter(cacheDatosGlobales, io));

// Fotos — Subida a imgbb + vinculación
app.use('/api/subir-foto', createFotosRouter(cacheDatosGlobales, io));

// Webhooks — Inyección en RAM desde Google Sheets
app.use('/api/webhook', webhookRouter(cacheDatosGlobales, io, ioDash, cargarNovedades, fetchRango, ID_SPREADSHEET_MASTER));

// Bot — Asistente de consultas inteligente con Gemini y RAM (Módulo exclusivo local)
try {
    const { createBotRouter, botStaticDir } = require('./bot');
    app.use('/api/bot', createBotRouter(cacheDatosGlobales));
    app.use('/bot', express.static(botStaticDir));
    app.get('/bot', (req, res) => res.sendFile(path.join(botStaticDir, 'index.html')));
    console.log("🤖 Módulo Bot cargado correctamente (entorno local).");
} catch (e) {
    // Si la carpeta bot/ está ignorada en producción, continúa con normalidad
}

// ==============================================================
// 🛣️ ENDPOINTS NATIVOS DE KILÓMETROS (RAM 60 DÍAS + POSTGRESQL)
// ==============================================================

// 1. Catálogo de viajes en RAM (ventana activa de 60 días)
app.get(['/api/km/recientes', '/api/km/viajes'], (req, res) => {
    const chofer = req.query.chofer;
    const viajesRam = (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) || {};
    if (chofer) {
        const { normalizar } = require('./utils/shared');
        const n = normalizar(chofer);
        let data = viajesRam[n] || (n.includes('ñ') ? viajesRam[n.replace(/ñ/g, 'n')] : null);
        if (!data) {
            const matchKey = Object.keys(viajesRam).find(k => k.includes(n));
            if (matchKey) data = viajesRam[matchKey];
        }
        return res.json({ success: true, chofer: n, fuente: "RAM_60D", viajes: data || {} });
    }
    res.json({
        success: true,
        fuente: "RAM_60D",
        choferesCount: Object.keys(viajesRam).length,
        viajes: viajesRam
    });
});

// 2. Viajes de un chofer específico desde RAM
app.get('/api/km/viajes/:chofer', (req, res) => {
    const { normalizar } = require('./utils/shared');
    const n = normalizar(req.params.chofer);
    const viajesRam = (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) || {};
    let data = viajesRam[n] || (n.includes('ñ') ? viajesRam[n.replace(/ñ/g, 'n')] : null);
    if (!data) {
        const matchKey = Object.keys(viajesRam).find(k => k.includes(n));
        if (matchKey) data = viajesRam[matchKey];
    }
    res.json({ success: true, chofer: n, fuente: "RAM_60D", viajes: data || {} });
});

// 3. Consulta de viajes por rango de fechas (RAM para últimos 60 días, PostgreSQL para histórico)
app.get('/api/km/rango', async (req, res) => {
    try {
        const { desde, hasta, chofer } = req.query;
        if (!desde || !hasta) return res.status(400).json({ success: false, error: "Faltan parámetros 'desde' y 'hasta'" });
        const db = require('./utils/db');
        const { normalizar, getFechaArgentina } = require('./utils/shared');
        const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
        const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
        const limiteRamIso = new Date(hoyArKm.getTime() - (KM_RAM_DIAS * 24 * 3600 * 1000)).toISOString().split('T')[0];

        // Si el rango 'desde' cae dentro de los 60 días en RAM, servir desde memoria
        if (desde >= limiteRamIso && cacheDatosGlobales.diagramas?.nuevaSeccionViajes) {
            const ram = cacheDatosGlobales.diagramas.nuevaSeccionViajes;
            let filtrados = {};
            if (chofer) {
                const n = normalizar(chofer);
                const chViajes = ram[n] || (n.includes('ñ') ? ram[n.replace(/ñ/g, 'n')] : {}) || {};
                filtrados[n] = {};
                for (let f in chViajes) {
                    if (f >= desde && f <= hasta) filtrados[n][f] = chViajes[f];
                }
            } else {
                for (let ch in ram) {
                    for (let f in ram[ch]) {
                        if (f >= desde && f <= hasta) {
                            if (!filtrados[ch]) filtrados[ch] = {};
                            filtrados[ch][f] = ram[ch][f];
                        }
                    }
                }
            }
            return res.json({ success: true, fuente: "RAM", data: filtrados });
        }

        // Si se solicitan fechas históricas o fuera de RAM, consultar PostgreSQL view_calendario_km
        if (db.isConfigured()) {
            let sql = `
                SELECT TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, dominio, chofer_nombre, km_totales, array_to_string(hoja_ruta, ', ') AS hoja_ruta, id_unidad
                FROM view_calendario_km
                WHERE fecha >= $1::date AND fecha <= $2::date
            `;
            let params = [desde, hasta];
            if (chofer) {
                params.push('%' + String(chofer).trim() + '%');
                sql += ` AND chofer_nombre ILIKE $${params.length}`;
            }
            sql += ` ORDER BY fecha ASC`;

            const resPg = await db.query(sql, params);
            const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
            let resultado = {};
            resPg.rows.forEach(r => {
                if (!r.chofer_nombre) return;
                const n = normalizar(r.chofer_nombre);
                if (!resultado[n]) resultado[n] = {};
                if (!resultado[n][r.fecha]) resultado[n][r.fecha] = { id_unidad: r.id_unidad || null, dominio: (r.dominio || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                resultado[n][r.fecha].km += parseNum(r.km_totales);
                resultado[n][r.fecha].km = parseFloat(resultado[n][r.fecha].km.toFixed(2));
                if (r.hoja_ruta) {
                    String(r.hoja_ruta).split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(h => {
                        if (!resultado[n][r.fecha].hoja_ruta.includes(h)) resultado[n][r.fecha].hoja_ruta.push(h);
                    });
                }
            });
            return res.json({ success: true, fuente: "POSTGRES_KM", data: resultado });
        }

        res.status(503).json({ success: false, error: "Base de datos no disponible para consultas fuera de RAM" });
    } catch (err) {
        console.error("❌ Error en /api/km/rango:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint optimizado para Calendario / Diagrama utilizando View Tables de Supabase
app.get(['/api/km/calendario', '/api/viajes/calendario'], async (req, res) => {
    try {
        const { mes, chofer, desde, hasta } = req.query;
        const db = require('./utils/db');
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, error: "Base de datos PostgreSQL no configurada" });
        }

        // Si se pide por mes exacto (ej: 2026-09), usar la vista JSON optimizada view_calendario_mes_km
        if (mes) {
            let sql = `SELECT mes, id_chofer, chofer_nombre, legajo, total_km_mes, dias_activos, viajes_dia FROM view_calendario_mes_km WHERE mes = $1`;
            const params = [mes];
            if (chofer) {
                params.push('%' + String(chofer).trim() + '%');
                sql += ` AND (chofer_nombre ILIKE $${params.length} OR id_chofer::text = $${params.length})`;
            }
            sql += ` ORDER BY chofer_nombre ASC`;
            const resView = await db.query(sql, params);
            return res.json({ success: true, fuente: "VIEW_CALENDARIO_MES_KM", count: resView.rows.length, data: resView.rows });
        }

        // Si se pide por rango de fechas flexible (desde/hasta), usar view_calendario_km
        let sql = `
            SELECT TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, id_chofer, chofer_nombre, legajo, id_unidad, n_ute, dominio, km, cant_viajes, hoja_ruta
            FROM view_calendario_km
            WHERE 1=1
        `;
        const params = [];
        if (desde) {
            params.push(desde);
            sql += ` AND fecha >= $${params.length}::date`;
        }
        if (hasta) {
            params.push(hasta);
            sql += ` AND fecha <= $${params.length}::date`;
        }
        if (chofer) {
            params.push('%' + String(chofer).trim() + '%');
            sql += ` AND (chofer_nombre ILIKE $${params.length} OR id_chofer::text = $${params.length})`;
        }
        sql += ` ORDER BY fecha ASC, chofer_nombre ASC`;
        const resView = await db.query(sql, params);
        return res.json({ success: true, fuente: "VIEW_CALENDARIO_KM", count: resView.rows.length, data: resView.rows });
    } catch (err) {
        console.error("❌ Error en /api/km/calendario:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Registro / actualización de hojas de ruta en PostgreSQL y RAM
app.post('/api/km/hoja-ruta', async (req, res) => {
    try {
        const { chofer, fecha, hoja_ruta, startIso, endIso, nombre, hojas } = req.body;
        const nombreChofer = chofer || nombre;
        const fInicio = fecha || startIso;
        const fFin = fecha || endIso || startIso;
        const hrArray = Array.isArray(hojas) ? hojas : (hoja_ruta ? [hoja_ruta] : []);

        if (!nombreChofer || !fInicio) {
            return res.status(400).json({ success: false, error: "Faltan datos obligatorios (chofer/nombre, fecha/startIso)" });
        }

        const { normalizar } = require('./utils/shared');
        const db = require('./utils/db');
        const n = normalizar(nombreChofer);
        const hrStr = hrArray.filter(Boolean).join(',');

        // 1. Actualizar RAM
        if (cacheDatosGlobales.diagramas?.nuevaSeccionViajes) {
            if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[n]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[n] = {};
            const cur = new Date(fInicio + "T12:00:00");
            const fin = new Date(fFin + "T12:00:00");
            while (cur <= fin) {
                const iso = cur.toISOString().split('T')[0];
                if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[n][iso]) {
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[n][iso] = { dominio: '', km: 0, campo: 0, hoja_ruta: [] };
                }
                const target = cacheDatosGlobales.diagramas.nuevaSeccionViajes[n][iso];
                hrArray.forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                cur.setDate(cur.getDate() + 1);
            }
        }

        res.json({ success: true, message: "Hoja de ruta actualizada en RAM" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Archivos estáticos del frontend con Cache-Control y ETag optimizados
const path = require('path');
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '2h',
    etag: true,
    lastModified: true
}));

// Resumen de RAM y KPIs
app.get('/ram', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        ultimaActualizacion: cacheDatosGlobales.ultimaActualizacion,
        totalChoferes: cacheDatosGlobales.diagramas?.diagramas?.length || 0,
        totalUnidades: cacheDatosGlobales.ut?.length || 0,
        totalViajesEnRam: Object.keys(cacheDatosGlobales.diagramas?.nuevaSeccionViajes || {}).length
    });
});

app.get('/api/km/resumen', async (req, res) => {
    try {
        const db = require('./utils/db');
        const ram = cacheDatosGlobales.diagramas?.nuevaSeccionViajes || {};
        const choferesCount = Object.keys(ram).length;
        let totalKm = 0;
        let totalViajes = 0;
        for (let ch in ram) {
            for (let f in ram[ch]) {
                totalViajes++;
                totalKm += (ram[ch][f].km || 0);
            }
        }
        let totalesDb = null;
        if (db.isConfigured()) {
            try {
                const rDb = await db.query(`
                    SELECT 
                        COUNT(*)::int as total_viajes,
                        ROUND(SUM(km_totales))::float as total_kms_flota,
                        COUNT(DISTINCT chofer_nombre)::int as total_choferes
                    FROM public.view_calendario_km;
                `);
                totalesDb = rDb.rows[0];
            } catch (eDb) {
                console.warn('⚠️ Error consultando agregados en Supabase:', eDb.message);
            }
        }
        res.json({
            success: true,
            resumen: {
                total_kms_flota: totalesDb ? totalesDb.total_kms_flota : +totalKm.toFixed(2),
                total_viajes: totalesDb ? totalesDb.total_viajes : totalViajes,
                total_choferes: totalesDb ? totalesDb.total_choferes : choferesCount,
                totales_ram: {
                    total_kms: +totalKm.toFixed(2),
                    total_viajes: totalViajes,
                    choferes: choferesCount
                }
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==============================================================
// 🟢 INICIAR SERVIDOR
// ==============================================================
const PORT = process.env.PORT || 3005;
server.listen(PORT, () => console.log(`🚀 [Backend storage_ram_db] Servidor Node Activo en puerto ${PORT}`));
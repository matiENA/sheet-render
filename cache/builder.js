const { 
    normalizar, 
    getFechaArgentina, 
    mesesAbrev, 
    mesesLargo, 
    fetchRango, 
    getTabName, 
    serviceAccountAuth, 
    ID_SPREADSHEET_MASTER,
    ID_SPREADSHEET_DIAGRAMAS,
    ID_SHEET_OBSERVACIONES,
    ID_SHEET_APTOS_MEDICOS,
    ID_SHEET_KILOMETROS,
    ID_SHEET_HABILITACIONES,
    ID_SHEET_DOCUMENTOS,
    ID_SHEET_MOVIMIENTOS
} = require('../utils/shared');
const { cargarNovedades, enriquecerNovedadesConFlota, iniciarPollingNovedades } = require('../novedades');
const { obtenerViajesMicroservicio, isMicroservicioActivo } = require('../utils/kmClient');
let sincronizarDbChoferesExterna = async () => ({ success: true, message: 'Operación delegada a local_loader' });
try {
    const syncMod = require('../sync/syncChoferes');
    if (syncMod && syncMod.sincronizarDbChoferesExterna) sincronizarDbChoferesExterna = syncMod.sincronizarDbChoferesExterna;
} catch (e) {
    // Entorno aislado para Render: el backend opera directamente con Supabase
}
const db = require('../utils/db');
const { supabase } = require('../utils/shared');
const crypto = require('crypto');

// Control de versión para Dirty Check y supresión de Egress
let lastSupabaseStatsString = null;
let lastBroadcastHash = null;
let kmCacheCargado = false;

// ==============================================================
// 📦 HELPER: Payload reducido para WebSocket y HTTP (sin viajes de KM ni clones)
// nuevaSeccionViajes (~1.8MB) y ch.viajes se excluyen del broadcast.
// El frontend los pide bajo demanda vía /api/viajes/historial
// ==============================================================
function buildSocketPayload(cache) {
    if (!cache || !cache.diagramas) return cache;
    const { nuevaSeccionViajes, diagramas: listaDiagramas, utMap, flota, unidades, ...restoDiagramas } = cache.diagramas;
    const diagramasSinViajes = Array.isArray(listaDiagramas)
        ? listaDiagramas.map(({ viajes, diagrama_json, ...resto }) => resto)
        : listaDiagramas;
    return {
        timestamp: cache.ultimaActualizacion,
        diagramas: {
            ...restoDiagramas,
            diagramas: diagramasSinViajes,
            ut: cache.diagramas.ut || []
        },
        ut: cache.diagramas.ut || [],
        vencimientosObj: cache.diagramas.vencimientosObj || [],
        usuarios: cache.usuarios || []
    };
}

function emitirDatosSiCambiaron(io, cacheDatosGlobales, ioDash = null) {
    if (!io && !ioDash) return false;
    const payload = buildSocketPayload(cacheDatosGlobales);
    if (!payload || !payload.diagramas) return false;

    const payloadStr = JSON.stringify(payload);
    const hash = crypto.createHash('md5').update(payloadStr).digest('hex');

    if (hash === lastBroadcastHash) {
        return false;
    }

    lastBroadcastHash = hash;
    if (io) io.emit('datos_actualizados', payload);
    if (ioDash) ioDash.emit('datos_actualizados', payload);
    console.log(`📡 [Socket.io] Broadcast emitido (cambio detectado, hash: ${hash.substring(0, 8)}, ${(Buffer.byteLength(payloadStr) / 1024).toFixed(1)} KB raw).`);
    return true;
}

async function verificarCambiosSupabase() {
    if (db.isConfigured()) {
        try {
            const res = await db.query(`
                SELECT relname, n_tup_ins, n_tup_upd, n_tup_del 
                FROM pg_stat_user_tables 
                WHERE relname IN ('choferes', 'unidades', 'movimientos', 'tractores', 'semis', 'servicios_unidades', 'servicios_choferes')
                ORDER BY relname ASC
            `);
            if (res.rows && res.rows.length > 0) {
                return res.rows.map(r => `${r.relname}:${r.n_tup_ins}:${r.n_tup_upd}:${r.n_tup_del}`).join('|');
            }
        } catch (e) {
            return null;
        }
    }
    return null;
}

function formatDateISO(val) {
    if (!val) return '';
    if (val instanceof Date) return val.toISOString().split('T')[0];
    const s = String(val).trim();
    if (s.includes('T')) return s.split('T')[0];
    return s;
}

// ==============================================================
// ⚡ CONSTRUCTOR PRINCIPAL DE RAM DESDE SUPABASE
// ==============================================================
async function actualizarCacheDesdeSupabase(cacheDatosGlobales, io, ioDash, opciones = {}) {
    const { forceFull = false, recargarKm = false } = opciones;
    const t0 = Date.now();

    // 🛡️ 1. DIRTY CHECK: Si ya hay datos en RAM y no es forzado, validar si hubo cambios en BD
    if (!forceFull && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.diagramas?.length > 0) {
        const statsActuales = await verificarCambiosSupabase();
        if (statsActuales && statsActuales === lastSupabaseStatsString) {
            console.log("⚡ [RAM Supabase] Dirty Check: Sin cambios en BD (0 bytes egress). RAM al día.");
            return true;
        }
    }

    console.log("⚡ [RAM Supabase] Ensamblando caché reactivo desde base de datos...");

    let rowsUnidades = [];
    let rowsChoferes = [];
    let rowsMovimientos = [];
    let rowsUsuarios = [];
    let rowsMovimientosKm = [];
    const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
    const debeCargarKm = recargarKm || !kmCacheCargado;

    let rowsChoferDocumentacion = [];
    let rowsTractores = [];
    let rowsSemis = [];
    let rowsServiciosUnidades = [];
    let rowsServiciosChoferes = [];

    try {
        if (db.isConfigured()) {
            const queries = [
                db.query('SELECT id, n_ute, servicio_id, tractor_id, semi_id, fecha_acople, estado FROM unidades ORDER BY n_ute ASC'),
                db.query('SELECT id, nombre, legajo, servicio_id, estado, unidad_id, foto FROM choferes ORDER BY nombre ASC'),
                db.query('SELECT * FROM movimientos'),
                db.query('SELECT usuario FROM usuarios_auth'),
                db.query('SELECT * FROM chofer_documentacion').catch(e => {
                    console.warn("⚠️ [RAM Supabase] Error consultando chofer_documentacion en Postgres:", e.message);
                    return { rows: [] };
                }),
                db.query('SELECT id, servicio_id, patente, n_interno, marca, modelo, vtv, mas, estado FROM tractores ORDER BY patente ASC').catch(() => ({ rows: [] })),
                db.query('SELECT id, servicio_id, patente, n_interno, marca, cisternado, esp_es, vi, ve, vtv, mas, estado FROM semis ORDER BY patente ASC').catch(() => ({ rows: [] })),
                db.query('SELECT id, denominacion, spreadsheet_id, activo FROM servicios_unidades ORDER BY denominacion ASC').catch(() => ({ rows: [] })),
                db.query('SELECT id, denominacion, servicio_unidad_id, spreadsheet_id, activo FROM servicios_choferes ORDER BY denominacion ASC').catch(() => ({ rows: [] }))
            ];

            if (debeCargarKm) {
                queries.push(
                    db.query(`
                        SELECT TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, dominio, chofer_nombre, km AS km_totales, hoja_ruta, id_chofer, id_unidad
                        FROM view_calendario_km
                        WHERE fecha >= (CURRENT_DATE - ($1 || ' days')::interval)
                        ORDER BY fecha ASC
                    `, [KM_RAM_DIAS]).catch(e => {
                        console.warn("⚠️ [RAM Supabase] Error consultando view_calendario_km en Postgres:", e.message);
                        return { rows: [] };
                    })
                );
            }

            const results = await Promise.all(queries);
            rowsUnidades = results[0].rows || [];
            rowsChoferes = results[1].rows || [];
            rowsMovimientos = results[2].rows || [];
            rowsUsuarios = (results[3].rows || []).map(r => String(r.usuario || '').trim().toUpperCase());
            rowsChoferDocumentacion = results[4].rows || [];
            rowsTractores = results[5].rows || [];
            rowsSemis = results[6].rows || [];
            rowsServiciosUnidades = results[7].rows || [];
            rowsServiciosChoferes = results[8].rows || [];

            if (debeCargarKm && results[9]) {
                rowsMovimientosKm = results[9].rows || [];
                kmCacheCargado = true;
            }
        } else {
            const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
            const limiteIso = new Date(hoyArKm.getTime() - (KM_RAM_DIAS * 24 * 3600 * 1000)).toISOString().split('T')[0];
            const promises = [
                supabase.from('unidades').select('id, n_ute, servicio_id, tractor_id, semi_id, fecha_acople, estado').order('n_ute', { ascending: true }),
                supabase.from('choferes').select('id, nombre, legajo, servicio_id, estado, unidad_id, foto').order('nombre', { ascending: true }),
                supabase.from('movimientos').select('*'),
                supabase.from('usuarios_auth').select('usuario'),
                supabase.from('chofer_documentacion').select('*').catch(e => ({ data: [] })),
                supabase.from('tractores').select('*').order('patente', { ascending: true }).catch(() => ({ data: [] })),
                supabase.from('semis').select('*').order('patente', { ascending: true }).catch(() => ({ data: [] })),
                supabase.from('servicios_unidades').select('*').order('denominacion', { ascending: true }).catch(() => ({ data: [] })),
                supabase.from('servicios_choferes').select('*').order('denominacion', { ascending: true }).catch(() => ({ data: [] }))
            ];
            if (debeCargarKm) {
                promises.push(
                    supabase.from('view_calendario_km').select('fecha, dominio, chofer_nombre, km, hoja_ruta, id_chofer, id_unidad').gte('fecha', limiteIso).order('fecha', { ascending: true }).catch(e => ({ data: [] }))
                );
            }
            const results = await Promise.all(promises);
            rowsUnidades = results[0].data || [];
            rowsChoferes = results[1].data || [];
            rowsMovimientos = results[2].data || [];
            rowsUsuarios = (results[3].data || []).map(r => String(r.usuario || '').trim().toUpperCase());
            rowsChoferDocumentacion = results[4].data || [];
            rowsTractores = results[5].data || [];
            rowsSemis = results[6].data || [];
            rowsServiciosUnidades = results[7].data || [];
            rowsServiciosChoferes = results[8].data || [];

            if (debeCargarKm && results[9]) {
                rowsMovimientosKm = results[9].data || [];
                kmCacheCargado = true;
            }
        }

        if (rowsUnidades.length === 0 && rowsChoferes.length === 0 && rowsTractores.length === 0) {
            console.warn("⚠️ [RAM Supabase] Tablas vacías o sin respuesta. Manteniendo caché actual.");
            return false;
        }

        // 1. Mapeos de búsqueda rápida
        const choferesPorId = {};
        const choferesPorNombre = {};
        rowsChoferes.forEach(ch => {
            choferesPorId[ch.id] = ch;
            const norm = normalizar(ch.nombre);
            choferesPorNombre[norm] = ch;
            if (norm.includes('ñ')) choferesPorNombre[norm.replace(/ñ/g, 'n')] = ch;
        });

        const tractorById = {};
        const tractorByPatente = {};
        rowsTractores.forEach(t => {
            tractorById[t.id] = t;
            if (t.patente) tractorByPatente[t.patente.toUpperCase().trim()] = t;
        });

        const semiById = {};
        const semiByPatente = {};
        rowsSemis.forEach(s => {
            semiById[s.id] = s;
            if (s.patente) semiByPatente[s.patente.toUpperCase().trim()] = s;
        });

        const servicioUnidadById = {};
        rowsServiciosUnidades.forEach(su => {
            servicioUnidadById[su.id] = su;
        });

        const servicioChoferById = {};
        rowsServiciosChoferes.forEach(sc => {
            servicioChoferById[sc.id] = sc;
        });

        const asignacionPorUnidadId = {};
        const asignacionPorChoferId = {};
        rowsMovimientos.forEach(m => {
            if (m.id_unidad && m.id_chofer) {
                asignacionPorUnidadId[m.id_unidad] = m.id_chofer;
                asignacionPorChoferId[m.id_chofer] = m.id_unidad;
            }
        });

        // 2. Construcción de estructuras de Unidades (hidratadas desde Tractores y Semis)
        const catalogoUnidades = [];
        const utById = {};
        const utMap = {};
        const marcasTractores = {};
        const marcasSemis = {};
        const vencimientosObj = [];
        const vencimientosPorPatente = {};
        const flotaMap = {};

        rowsUnidades.forEach(u => {
            const tr = u.tractor_id ? tractorById[u.tractor_id] : null;
            const se = u.semi_id ? semiById[u.semi_id] : null;
            const su = u.servicio_id ? servicioUnidadById[u.servicio_id] : null;

            const trPat = tr ? (tr.patente || '').trim().toUpperCase().replace(/\s+/g, '') : '';
            const sePat = se ? (se.patente || '').trim().toUpperCase().replace(/\s+/g, '') : '';
            const nUte = (u.n_ute || '').trim();
            const srvDenom = su ? su.denominacion : 'S/A';

            if (trPat && tr.marca) marcasTractores[trPat] = tr.marca;
            if (sePat && se.marca) marcasSemis[sePat] = se.marca;

            const vTr = trPat ? {
                id: tr.id,
                patente: trPat,
                marca: tr.marca || '',
                vtv: formatDateISO(tr.vtv),
                mas: formatDateISO(tr.mas),
                estado: tr.estado || 'disponible'
            } : null;

            const vSe = sePat ? {
                id: se.id,
                patente: sePat,
                marca: se.marca || '',
                cisternado: se.cisternado || '',
                vtv: formatDateISO(se.vtv),
                mas: formatDateISO(se.mas),
                esp_es: se.esp_es || '',
                vi: se.vi || '',
                ve: se.ve || '',
                estado: se.estado || 'disponible'
            } : null;

            if (vTr) {
                vencimientosPorPatente[trPat] = vTr;
                vencimientosObj.push(vTr);
            }
            if (vSe) {
                vencimientosPorPatente[sePat] = vSe;
                vencimientosObj.push(vSe);
            }

            let choferAsignado = null;
            const idChofer = asignacionPorUnidadId[u.id];
            if (idChofer && choferesPorId[idChofer]) {
                const ch = choferesPorId[idChofer];
                const norm = normalizar(ch.nombre);
                choferAsignado = {
                    id: ch.id,
                    nom: ch.nombre,
                    _safeId: 'drv_' + norm.replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, '_')
                };
            }

            const objUt = {
                id: u.id,
                n_ute: nUte,
                srv_ut: srvDenom,
                servicio_id: u.servicio_id,
                tractor_id: u.tractor_id,
                semi_id: u.semi_id,
                fecha_acople: u.fecha_acople || null,
                estado: u.estado || 'disponible',
                tractor: vTr,
                semi: vSe,
                cisternado: se?.cisternado || '',
                chofer_asignado: choferAsignado
            };

            catalogoUnidades.push(objUt);
            utById[u.id] = objUt;
            if (nUte) utMap[nUte] = objUt;
        });

        // 2.5. Construcción de Viajes y Kilómetros en RAM (ventana configurada de 60 días)
        const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
        const nuevaSeccionViajes = {};

        rowsMovimientosKm.forEach(r => {
            let nom = r.chofer_nombre;
            if (!nom && r.id_chofer && choferesPorId[r.id_chofer]) {
                nom = choferesPorId[r.id_chofer].nombre;
            }
            if (!nom) return;

            const norm = normalizar(nom);
            const isoDate = r.fecha instanceof Date ? r.fecha.toISOString().split('T')[0] : String(r.fecha).split('T')[0];
            const km = parseNum(r.km_totales);
            const hojaStr = String(r.hoja_ruta || '').trim();

            if (!nuevaSeccionViajes[norm]) nuevaSeccionViajes[norm] = {};
            if (!nuevaSeccionViajes[norm][isoDate]) {
                nuevaSeccionViajes[norm][isoDate] = {
                    id_unidad: r.id_unidad || null,
                    dominio: (r.dominio || '').trim(),
                    km: 0,
                    campo: 0,
                    hoja_ruta: []
                };
            }

            const target = nuevaSeccionViajes[norm][isoDate];
            target.km += km;
            target.km = parseFloat(target.km.toFixed(2));
            if (r.id_unidad && !target.id_unidad) target.id_unidad = r.id_unidad;
            if (r.dominio && !target.dominio) target.dominio = r.dominio.trim();

            if (hojaStr) {
                hojaStr.split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(h => {
                    if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h);
                });
            }

            if (norm.includes('ñ')) {
                const sinEnie = norm.replace(/ñ/g, 'n');
                nuevaSeccionViajes[sinEnie] = nuevaSeccionViajes[norm];
            }

            // Si id_chofer corresponde a un chofer con nombre ligeramente distinto en choferes, enlazarlo
            if (r.id_chofer && choferesPorId[r.id_chofer]) {
                const chNorm = normalizar(choferesPorId[r.id_chofer].nombre);
                if (chNorm !== norm) {
                    nuevaSeccionViajes[chNorm] = nuevaSeccionViajes[norm];
                    if (chNorm.includes('ñ')) nuevaSeccionViajes[chNorm.replace(/ñ/g, 'n')] = nuevaSeccionViajes[norm];
                }
            }
        });

        // 2.8. Indexar Documentación, Habilitaciones y Aptos desde chofer_documentacion (Supabase)
        const docPorChoferId = {};
        const docPorDni = {};
        const docPorDrv = {};
        (rowsChoferDocumentacion || []).forEach(doc => {
            if (doc.chofer_id) docPorChoferId[doc.chofer_id] = doc;
            if (doc.dni) docPorDni[String(doc.dni).replace(/\D/g, '')] = doc;
            if (doc.drv_codigo) docPorDrv[doc.drv_codigo] = doc;
        });

        const calcEstDoc = (iso) => {
            if (!iso) return 'OK';
            const s = String(iso).trim().split('T')[0];
            const p = s.split(/[-/]/);
            if (p.length !== 3) return 'OK';
            let y, m, d;
            if (p[0].length === 4) { y = parseInt(p[0], 10); m = parseInt(p[1], 10) - 1; d = parseInt(p[2], 10); }
            else { d = parseInt(p[0], 10); m = parseInt(p[1], 10) - 1; y = parseInt(p[2].length === 2 ? '20' + p[2] : p[2], 10); }
            const diff = Math.ceil((new Date(y, m, d) - new Date()) / 86400000);
            return diff < 0 ? 'VENCIDO' : (diff <= 30 ? 'POR_VENCER' : 'VIGENTE');
        };

        const docsMap = {};
        const habsMap = {};
        const certsMap = {};
        const aptosMap = {};
        const telefonosMap = {};
        const dnisMap = {};

        // 3. Construcción de Choferes / Diagramas
        const diagramasHibridos = rowsChoferes.map(ch => {
            const norm = normalizar(ch.nombre);
            const safeId = 'drv_' + norm.replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, '_');

            let objUt = null;
            const idUnidad = asignacionPorChoferId[ch.id] || ch.unidad_id;
            if (idUnidad && utById[idUnidad]) {
                objUt = utById[idUnidad];
            } else if (idUnidad) {
                const u = rowsUnidades.find(x => x.id === idUnidad);
                if (u && u.n_ute && utMap[u.n_ute.trim()]) {
                    objUt = utMap[u.n_ute.trim()];
                }
            }

            // Reconstruir mapa de meses en formato tira para el frontend (ej: { 'Sep-26': '12,13,F,...' })
            const diasMesesTira = {};
            if (ch.diagrama_json && ch.diagrama_json.meses) {
                for (const mesKey in ch.diagrama_json.meses) {
                    diasMesesTira[mesKey] = ch.diagrama_json.meses[mesKey].tira || '';
                }
            }

            // Enriquecer con documentación oficial desde Supabase
            const doc = (ch.id ? docPorChoferId[ch.id] : null);
            const dniClean = String(doc?.dni || '').replace(/\D/g, '');

            let docMedico = null;
            let docLic = null;
            let docCert = null;
            let docApto = null;

            if (doc) {
                if (doc.venc_periodico) {
                    const venIso = formatDateISO(doc.venc_periodico);
                    docMedico = { ven: venIso, estado: calcEstDoc(venIso) };
                }
                if (doc.venc_licencia_nacional) {
                    const venIso = formatDateISO(doc.venc_licencia_nacional);
                    docLic = { ven: venIso, estado: calcEstDoc(venIso) };
                }
                if (doc.venc_cargas_peligrosas) {
                    const venIso = formatDateISO(doc.venc_cargas_peligrosas);
                    docCert = { ven: venIso, estado: calcEstDoc(venIso) };
                }
                if (doc.apto_medico_estado || doc.apto_medico_venc) {
                    docApto = {
                        estado: doc.apto_medico_estado || 'ACTIVO',
                        venc: formatDateISO(doc.apto_medico_venc),
                        avalado: doc.avalado_contratos || '',
                        observaciones: doc.obs_documentacion || ''
                    };
                }
            }

            if (docMedico) { docsMap[norm] = docMedico; if (norm.includes('ñ')) docsMap[norm.replace(/ñ/g, 'n')] = docMedico; }
            if (docLic) { habsMap[norm] = docLic; if (norm.includes('ñ')) habsMap[norm.replace(/ñ/g, 'n')] = docLic; }
            if (docCert) { certsMap[norm] = docCert; if (norm.includes('ñ')) certsMap[norm.replace(/ñ/g, 'n')] = docCert; }
            if (docApto) {
                aptosMap[norm] = docApto;
                if (dniClean) aptosMap[dniClean] = docApto;
                if (norm.includes('ñ')) aptosMap[norm.replace(/ñ/g, 'n')] = docApto;
            }
            if (doc?.telefono) {
                const telObj = { telefono: doc.telefono, email: doc?.email || '', fechaAlta: doc?.fecha_alta || '' };
                telefonosMap[norm] = telObj;
                if (dniClean) telefonosMap[dniClean] = telObj;
                if (norm.includes('ñ')) telefonosMap[norm.replace(/ñ/g, 'n')] = telObj;
            }
            if (dniClean) {
                dnisMap[norm] = { dni: dniClean };
                if (norm.includes('ñ')) dnisMap[norm.replace(/ñ/g, 'n')] = { dni: dniClean };
            }

            const srvNombre = (ch.servicio_id && servicioChoferById[ch.servicio_id]) ? servicioChoferById[ch.servicio_id].denominacion : 'S/A';

            const objChofer = {
                id: ch.id || null,
                nom: ch.nombre,
                dni: doc?.dni || '',
                legajo: ch.legajo || '',
                contacto: doc?.telefono || '',
                email: doc?.email || '',
                srv: srvNombre,
                srv_chofer: srvNombre,
                servicio_id: ch.servicio_id || null,
                servicio_chofer_nombre: srvNombre,
                servicio_flota: (ch.servicio_id && servicioChoferById[ch.servicio_id]?.servicio_unidad_id && servicioUnidadById[servicioChoferById[ch.servicio_id].servicio_unidad_id]) ? servicioUnidadById[servicioChoferById[ch.servicio_id].servicio_unidad_id].denominacion : null,
                estado: ch.estado || (objUt ? 'circulando' : 'inactivo'),
                _safeId: safeId,
                ut: objUt,
                tractor: objUt?.tractor?.patente || '',
                semi: objUt?.semi?.patente || '',
                cisternado: objUt?.cisternado || '',
                n_ute: objUt?.n_ute || '',
                dias: diasMesesTira,
                diagrama_tipo: null,

                diagrama_json: ch.diagrama_json || null,
                contabilizador: ch.contabilizador || null,
                documentos: {
                    medico: docMedico,
                    licencia: docLic,
                    certificados: docCert,
                    apto_medico: docApto
                },
                viajes: nuevaSeccionViajes[norm] || (norm.includes('ñ') ? nuevaSeccionViajes[norm.replace(/ñ/g, 'n')] : null) || {}
            };

            flotaMap[norm] = {
                tractor: objChofer.tractor,
                semi: objChofer.semi,
                servicio: objChofer.srv,
                n_ute: objChofer.n_ute,
                cisternado: objChofer.cisternado,
                ut: objUt
            };
            if (norm.includes('ñ')) flotaMap[norm.replace(/ñ/g, 'n')] = flotaMap[norm];

            return objChofer;
        });

        // 4. Asignación atómica a cacheDatosGlobales
        const previoViajes = (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) || {};
        const viajesFinales = Object.keys(nuevaSeccionViajes).length > 0 ? nuevaSeccionViajes : previoViajes;
        cacheDatosGlobales.diagramas = {
            diagramas: diagramasHibridos,
            ut: catalogoUnidades,
            unidades: catalogoUnidades,
            utMap: utMap,
            flota: flotaMap,
            vencimientosObj: vencimientosObj,
            marcasTractores: marcasTractores,
            marcasSemis: marcasSemis,
            vencimientosPorPatente: vencimientosPorPatente,
            nuevaSeccionViajes: viajesFinales,
            documentos: docsMap,
            habilitaciones: habsMap,
            certificados: certsMap,
            aptosMedicos: aptosMap,
            telefonos: telefonosMap,
            dnis: dnisMap,
            tractores: rowsTractores,
            semis: rowsSemis,
            servicios_unidades: rowsServiciosUnidades,
            servicios_choferes: rowsServiciosChoferes
        };
        cacheDatosGlobales.ut = catalogoUnidades;
        cacheDatosGlobales.vencimientosObj = vencimientosObj;
        cacheDatosGlobales.marcasTractores = marcasTractores;
        cacheDatosGlobales.marcasSemis = marcasSemis;
        cacheDatosGlobales.tractores = rowsTractores;
        cacheDatosGlobales.semis = rowsSemis;
        cacheDatosGlobales.serviciosUnidades = rowsServiciosUnidades;
        cacheDatosGlobales.serviciosChoferes = rowsServiciosChoferes;
        cacheDatosGlobales.documentos = docsMap;
        cacheDatosGlobales.habilitaciones = habsMap;
        cacheDatosGlobales.certificados = certsMap;
        cacheDatosGlobales.aptosMedicos = aptosMap;
        if (rowsUsuarios.length > 0) cacheDatosGlobales.usuarios = rowsUsuarios;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();

        // 🛡️ Actualizar firma del Dirty Check tras sincronización exitosa
        lastSupabaseStatsString = await verificarCambiosSupabase();

        console.log(`✅ [RAM Supabase] Caché ensamblado en ${Date.now() - t0} ms (${catalogoUnidades.length} UTs, ${diagramasHibridos.length} choferes, ${Object.keys(viajesFinales).length} con KM en RAM).`);

        // Emitir WebSocket a clientes conectados (solo si hubo cambio real en los datos)
        if (io || ioDash) emitirDatosSiCambiaron(io, cacheDatosGlobales, ioDash);
        if (ioDash && cacheDatosGlobales.novedades && cacheDatosGlobales.novedades.length > 0) {
            ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
        }

        return true;
    } catch (err) {
        console.error("❌ Error actualizando caché desde Supabase:", err.message);
        return false;
    }
}

let ejecutandoGlobal = false, pendienteGlobal = false; 

async function flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, opciones = {}) {
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;
    try { 
        // 1. Prioridad: Construir RAM directamente desde Supabase en milisegundos con Dirty Check
        const ok = await actualizarCacheDesdeSupabase(cacheDatosGlobales, io, ioDash, opciones);
        if (!ok) {
            console.warn("⚠️ [RAM] Supabase no respondió. Intentando fallback secundario de Google Sheets...");
            await actualizarCacheDesdeGoogle(cacheDatosGlobales, io, ioDash);
        }
    } catch (e) {
        console.error("❌ Error en flujo global:", e.message);
    } finally { 
        ejecutandoGlobal = false; 
        if (pendienteGlobal) { 
            pendienteGlobal = false; 
            flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, opciones); 
        } 
    }
}

async function actualizarCacheDesdeGoogle(cacheDatosGlobales, io, ioDash) {
    try {
        console.log("🚀 INICIANDO DESCARGA CRUDA: Ensamblando RAM protegida...");

        let resDiagGAS = {
            vencimientosObj: [], fotosImgur: {}, observaciones: {}, aptosMedicos: {},
            documentos: {}, habilitaciones: {}, dnis: {}, certificados: {}, telefonos: {}, flota: {}
        };
        // 0. Sincronización automática de VENCIMIENTOS y PERIODICOS -> DB_CHOFERES
        try {
            await sincronizarDbChoferesExterna();
        } catch (eSync) {
            console.error("⚠️ Error en sincronización inicial de DB_CHOFERES:", eSync.message);
        }

        let choferesRouter = {};
        let mapaNombreDiagramaAId = {};
        try {
            const rowsDB = await fetchRango(ID_SPREADSHEET_MASTER, "'DB_CHOFERES'!A2:H");
            rowsDB.forEach(row => {
                let id = String(row[0] || "").trim();
                if (!id) return;
                let nomVenc = String(row[1] || "").trim();
                let dniVal = String(row[2] || "").replace(/\D/g, '');
                let nomPer = String(row[3] || "").trim();
                let cuilVal = String(row[4] || "").trim();
                let nombreDiagrama = String(row[5] || "").trim();
                let dniFallback = String(row[6] || "").replace(/\D/g, '');
                let passApp = String(row[7] || "").trim();

                choferesRouter[id] = { 
                    id: id, 
                    nombreVencimientos: nomVenc,
                    nombre: nomVenc || nombreDiagrama, 
                    dni: dniVal, 
                    nombrePeriodicos: nomPer,
                    cuil: cuilVal, 
                    nombreDiagrama: nombreDiagrama, 
                    dniFallback: dniFallback,
                    passwordApp: passApp
                };

                if (nombreDiagrama) {
                    let nd = normalizar(nombreDiagrama);
                    mapaNombreDiagramaAId[nd] = id;
                    if (nd.includes('ñ')) mapaNombreDiagramaAId[nd.replace(/ñ/g, 'n')] = id;
                }
                if (nomVenc) {
                    let nm = normalizar(nomVenc);
                    if (!mapaNombreDiagramaAId[nm]) mapaNombreDiagramaAId[nm] = id;
                    if (nm.includes('ñ') && !mapaNombreDiagramaAId[nm.replace(/ñ/g, 'n')]) mapaNombreDiagramaAId[nm.replace(/ñ/g, 'n')] = id;
                }
                if (nomPer) {
                    let np = normalizar(nomPer);
                    if (!mapaNombreDiagramaAId[np]) mapaNombreDiagramaAId[np] = id;
                    if (np.includes('ñ') && !mapaNombreDiagramaAId[np.replace(/ñ/g, 'n')]) mapaNombreDiagramaAId[np.replace(/ñ/g, 'n')] = id;
                }
            });
            cacheDatosGlobales.choferesRouter = choferesRouter; 
            cacheDatosGlobales.mapaNombreDiagramaAId = mapaNombreDiagramaAId;
        } catch (e) {}

        // 👉 DELEGAMOS LA CARGA DE NOVEDADES AL MÓDULO EXTERNO (PASANDO EL MAPA DE CHOFERES)
        await cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, mapaNombreDiagramaAId);

        // Poda: mantener solo novedades activas + resueltas de los últimos 7 días
        const LIMITE_RESUELTAS_MS = 7 * 24 * 60 * 60 * 1000;
        const ahora = Date.now();
        cacheDatosGlobales.novedades = (cacheDatosGlobales.novedades || []).filter(n => 
            !n.resuelto || !n.fecha_resolucion || (ahora - new Date(n.fecha_resolucion).getTime()) < LIMITE_RESUELTAS_MS
        );

        let listaChoferesMaestros = [];
        let catalogoUnidades = [];
        let mapaChoferAUt = {};
        let marcasTractores = {};
        let marcasSemis = {};
        let vencimientosPorPatente = {};
        let rowsVencimientosSheet = [];
        try {
            let hoyAr = getFechaArgentina();
            let anio = hoyAr.getFullYear(); 
            let nombreHojaActual = mesesAbrev[hoyAr.getMonth()] + "-" + String(anio).slice(-2);
            
            (await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHojaActual}'!A6:C1000`)).forEach(row => {
                if (row[1] && !["APELLIDO Y NOMBRE", "Personal Activo"].includes(row[1])) {
                    let norm = normalizar(row[1]);
                    if (!resDiagGAS.flota[norm]) { 
                        let objFlota = { tractor: '', semi: '', servicio: row[2] || 'S/A', n_ute: '', cisternado: '' };
                        resDiagGAS.flota[norm] = objFlota; 
                        if (norm.includes('ñ')) resDiagGAS.flota[norm.replace(/ñ/g, 'n')] = objFlota;
                        listaChoferesMaestros.push({ nombre: String(row[1]).trim(), norm }); 
                    }
                }
            });

            // 1. Cargar marcas de tractores y semis, y vencimientos de patentes (Uni QM + Vencimientos.)
            let nombrePestañaMov = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "Mov.Unidades y Choferes");
            let rowsMov = [];
            try {
                const [rowsTractores, rowsSemis, rowsUniQM, rowsVenc, fetchedRowsMov] = await Promise.all([
                    fetchRango(ID_SPREADSHEET_MASTER, "'TRACTORES'!C2:D").catch(() => []),
                    fetchRango(ID_SPREADSHEET_MASTER, "'SEMIS'!C2:D").catch(() => []),
                    fetchRango(ID_SHEET_MOVIMIENTOS, "'base datos Uni QM'!A3:F").catch(() => []),
                    fetchRango(ID_SHEET_MOVIMIENTOS, "'Vencimientos.'!A2:N").catch(() => []),
                    fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaMov}'!A1:ZZ1000`).catch(() => [])
                ]);

                rowsMov = fetchedRowsMov || [];
                rowsVencimientosSheet = rowsVenc || [];

                // Detectar conjunto de patentes activas en Movimientos del mes
                const patentesFlotaMes = new Set();
                for (let i = 1; i < rowsMov.length; i++) {
                    const tr = String(rowsMov[i][4] || '').trim().toUpperCase().replace(/\s+/g, '');
                    const se = String(rowsMov[i][5] || '').trim().toUpperCase().replace(/\s+/g, '');
                    if (tr && tr !== 'TRACTOR') patentesFlotaMes.add(tr);
                    if (se && se !== 'SEMI') patentesFlotaMes.add(se);
                }

                rowsTractores.forEach(r => {
                    let pat = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
                    let marca = String(r[1] || '').trim();
                    if (pat && marca && pat !== 'DOMINIO') marcasTractores[pat] = marca;
                });

                rowsSemis.forEach(r => {
                    let pat = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
                    let marca = String(r[1] || '').trim();
                    if (pat && marca && pat !== 'DOMINIO') marcasSemis[pat] = marca;
                });

                rowsUniQM.forEach(row => {
                    let patente = String(row[0] || '').trim().toUpperCase().replace(/\s+/g, '');
                    if (!patente || patente === 'PATENTE') return;
                    if (patentesFlotaMes.size > 0 && !patentesFlotaMes.has(patente)) return;
                    vencimientosPorPatente[patente] = {
                        patente: patente,
                        mas: String(row[1] || '').trim(),
                        vtv: String(row[2] || '').trim(),
                        esp_es: String(row[3] || '').trim(),
                        vi: String(row[4] || '').trim(),
                        ve: String(row[5] || '').trim()
                    };
                });

                // Enriquecer o complementar con la pestaña 'Vencimientos.' de la planilla mensual
                rowsVencimientosSheet.forEach(r => {
                    let tr = String(r[1] || '').trim().toUpperCase().replace(/\s+/g, '');
                    let se = String(r[2] || '').trim().toUpperCase().replace(/\s+/g, '');
                    if (tr && tr !== 'TRACTOR' && (patentesFlotaMes.size === 0 || patentesFlotaMes.has(tr))) {
                        if (!vencimientosPorPatente[tr]) {
                            vencimientosPorPatente[tr] = { patente: tr, mas: '', vtv: '', esp_es: '', vi: '', ve: '' };
                        }
                        if (r[6]) vencimientosPorPatente[tr].mas = String(r[6]).trim();
                        if (r[7]) vencimientosPorPatente[tr].vtv = String(r[7]).trim();
                    }
                    if (se && se !== 'SEMI' && (patentesFlotaMes.size === 0 || patentesFlotaMes.has(se))) {
                        if (!vencimientosPorPatente[se]) {
                            vencimientosPorPatente[se] = { patente: se, mas: '', vtv: '', esp_es: '', vi: '', ve: '' };
                        }
                        if (r[9]) vencimientosPorPatente[se].mas = String(r[9]).trim();
                        if (r[10]) vencimientosPorPatente[se].vtv = String(r[10]).trim();
                        if (r[11]) vencimientosPorPatente[se].esp_es = String(r[11]).trim();
                        if (r[12]) vencimientosPorPatente[se].vi = String(r[12]).trim();
                        if (r[13]) vencimientosPorPatente[se].ve = String(r[13]).trim();
                    }
                });

                console.log(`🚚 Base de datos de vencimientos indexada: ${Object.keys(vencimientosPorPatente).length} patentes activas.`);
            } catch (eUni) {
                console.error("Error cargando marcas / vencimientos de unidades:", eUni);
            }

            // 2. Parseo estructurado de la planilla mensual de Movimientos
            if (rowsMov.length === 0) {
                rowsMov = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaMov}'!A1:ZZ1000`);
            }
            
            if (rowsMov.length > 0) {
                let dateMap = [];
                const row0 = rowsMov[0] || [];

                function parseHeaderDate(str) {
                    if (!str) return null;
                    let clean = String(str).toLowerCase().replace(/\s+/g, ' ').trim();
                    let matchWord = clean.match(/(\d{1,2})[\s/\-de]+([a-z]+)[\s/\-de]+(\d{2,4})/);
                    if (matchWord) {
                        let day = parseInt(matchWord[1], 10);
                        let mStr = matchWord[2].substring(0, 3);
                        let monthIdx = mesesAbrev.map(m => m.toLowerCase()).indexOf(mStr);
                        if (monthIdx === -1) monthIdx = mesesLargo.map(m => m.toLowerCase()).indexOf(matchWord[2]);
                        let year = parseInt(matchWord[3], 10);
                        if (year < 100) year += 2000;
                        if (monthIdx !== -1 && day >= 1 && day <= 31) return new Date(year, monthIdx, day);
                    }
                    let matchSlash = clean.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
                    if (matchSlash) {
                        let day = parseInt(matchSlash[1], 10);
                        let monthIdx = parseInt(matchSlash[2], 10) - 1;
                        let year = parseInt(matchSlash[3], 10);
                        if (year < 100) year += 2000;
                        return new Date(year, monthIdx, day);
                    }
                    return null;
                }

                row0.forEach((cell, cIdx) => {
                    let parsedDate = parseHeaderDate(cell);
                    if (parsedDate) {
                        let choferCol = Math.max(0, cIdx - 3);
                        dateMap.push({ colFecha: cIdx, colNom: choferCol, dateObj: parsedDate });
                    }
                });

                let todayStr = hoyAr.toISOString().split('T')[0];
                let selectedDateCol = dateMap.find(d => d.dateObj.toISOString().split('T')[0] === todayStr);

                if (!selectedDateCol) {
                    let validPast = dateMap.filter(d => d.dateObj <= hoyAr).sort((a,b) => b.dateObj - a.dateObj);
                    if (validPast.length > 0) selectedDateCol = validPast[0];
                }
                if (!selectedDateCol && dateMap.length > 0) {
                    selectedDateCol = dateMap[dateMap.length - 1];
                }

                const ESTADOS_ICONOS = ['⚪', '🟢', '🔴', '🟡', '🔵', '⚫', '🟣'];
                let currentSrvUt = 'S/A';

                for (let i = 1; i < rowsMov.length; i++) {
                    let row = rowsMov[i];
                    if (!row || row.length === 0) continue;

                    let col0 = String(row[0] || '').trim();
                    let col2 = String(row[2] || '').trim();
                    let col4 = String(row[4] || '').trim();
                    let col5 = String(row[5] || '').trim();

                    // Detectar cabecera de sección de servicio (ej: LIVIANO, METANOL, CAMPO, SOCIO, etc.)
                    if (col0 && !ESTADOS_ICONOS.includes(col0) && !col2 && !col4 && !col5) {
                        currentSrvUt = col0.toUpperCase();
                        continue;
                    }

                    let n_ute = col2;
                    let cistVal = String(row[3] || '').trim();
                    let tractorPat = col4.toUpperCase().replace(/\s+/g, '');
                    let semiPat = col5.toUpperCase().replace(/\s+/g, '');

                    if (!tractorPat && !semiPat && !n_ute) continue;
                    if (cistVal.toLowerCase() === 'cisternado') continue;



                    let objSemi = semiPat ? {
                        patente: semiPat,
                        marca: marcasSemis[semiPat] || '',
                        cisternado: cistVal || '',
                        vencimientos: vencimientosPorPatente[semiPat] || null
                    } : null;

                    let objTractor = tractorPat ? {
                        patente: tractorPat,
                        marca: marcasTractores[tractorPat] || '',
                        vencimientos: vencimientosPorPatente[tractorPat] || null,
                        semi: objSemi,
                        cisternado: cistVal || (objSemi ? objSemi.cisternado : '')
                    } : null;

                    let choferAsignado = null;
                    if (selectedDateCol) {
                        let nomRaw = String(row[selectedDateCol.colNom] || '').trim();
                        if (nomRaw && nomRaw !== '1' && nomRaw.length >= 3) {
                            let norm = normalizar(nomRaw);
                            let safeId = "drv_" + norm.replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, "_");
                            choferAsignado = { nom: nomRaw, _safeId: safeId };
                        }
                    }

                    let objUt = {
                        n_ute: n_ute || '',
                        srv_ut: currentSrvUt,
                        tractor: objTractor,
                        semi: objSemi,
                        cisternado: cistVal || (objSemi ? objSemi.cisternado : ''),
                        chofer_asignado: choferAsignado
                    };

                    catalogoUnidades.push(objUt);

                    // Si hay chofer asignado en la fecha seleccionada, vincular en mapa
                    if (choferAsignado) {
                        let nomRaw = choferAsignado.nom;
                        let norm = normalizar(nomRaw);
                        let targetKey = norm;
                        if (mapaNombreDiagramaAId) {
                            let choferId = mapaNombreDiagramaAId[norm] || (norm.includes('ñ') ? mapaNombreDiagramaAId[norm.replace(/ñ/g, 'n')] : null);
                            if (choferId && choferesRouter[choferId]) {
                                let diagName = normalizar(choferesRouter[choferId].nombreDiagrama || choferesRouter[choferId].nombre);
                                if (resDiagGAS.flota[diagName]) targetKey = diagName;
                                else if (diagName.includes('ñ') && resDiagGAS.flota[diagName.replace(/ñ/g, 'n')]) targetKey = diagName.replace(/ñ/g, 'n');
                            }
                        }
                        if (!resDiagGAS.flota[targetKey]) {
                            let keys = Object.keys(resDiagGAS.flota);
                            let foundKey = keys.find(k => k === norm || (norm.includes('ñ') && k === norm.replace(/ñ/g, 'n')));
                            if (foundKey) targetKey = foundKey;
                        }

                        mapaChoferAUt[targetKey] = objUt;
                        mapaChoferAUt[norm] = objUt;
                        if (targetKey.includes('ñ')) mapaChoferAUt[targetKey.replace(/ñ/g, 'n')] = objUt;
                        if (norm.includes('ñ')) mapaChoferAUt[norm.replace(/ñ/g, 'n')] = objUt;

                        if (resDiagGAS.flota[targetKey]) {
                            if (n_ute) resDiagGAS.flota[targetKey].n_ute = n_ute;
                            if (tractorPat) resDiagGAS.flota[targetKey].tractor = tractorPat;
                            if (semiPat) resDiagGAS.flota[targetKey].semi = semiPat;
                            if (cistVal || (objSemi && objSemi.cisternado)) {
                                resDiagGAS.flota[targetKey].cisternado = cistVal || (objSemi ? objSemi.cisternado : '');
                            }
                            resDiagGAS.flota[targetKey].srv_ut = currentSrvUt;
                            resDiagGAS.flota[targetKey].ut = objUt;
                        }
                    }
                }
            }
        } catch (e) { console.error("Error en lectura de Movimientos / Unidades:", e); }

        let dnisMap = {}; let telefonosMap = {};
        try {
            (await fetchRango(ID_SPREADSHEET_MASTER, "'dni'!A1:D")).forEach(row => { 
                let n = String(row[0] || "").trim(); 
                let dni = String(row[2] || "").replace(/\D/g, ''); 
                if (n && dni) {
                    let norm = normalizar(n);
                    let valDni = { dni: String(parseInt(dni, 10)) };
                    dnisMap[norm] = valDni;
                    if (norm.includes('ñ')) dnisMap[norm.replace(/ñ/g, 'n')] = valDni;
                }
            });
            (await fetchRango(ID_SPREADSHEET_MASTER, "'LEGAJOS'!A2:P")).forEach(row => {
                let n = String(row[1] || "").trim(); if (!n || n.toLowerCase().includes("baja")) return; let norm = normalizar(n);
                let datos = { legajo: String(row[0] || "").trim(), telefono: String(row[3] || "").trim(), email: String(row[4] || "").trim(), fechaAlta: String(row[10] || "").trim() };
                telefonosMap[norm] = datos; 
                if (norm.includes('ñ')) telefonosMap[norm.replace(/ñ/g, 'n')] = datos;
                let dni = String(row[2] || "").replace(/\D/g, '');
                if (dni && !dnisMap[norm]) {
                    let valDni = { dni: String(parseInt(dni, 10)) };
                    dnisMap[norm] = valDni;
                    if (norm.includes('ñ')) dnisMap[norm.replace(/ñ/g, 'n')] = valDni;
                }
                if (dnisMap[norm]?.dni) telefonosMap[dnisMap[norm].dni] = datos;
            });
        } catch (e) { }
        resDiagGAS.dnis = dnisMap; resDiagGAS.telefonos = telefonosMap;

        try {
            const rowsAptos = await fetchRango(ID_SHEET_APTOS_MEDICOS, "'Seguimiento Avalados Mensual'!A1:DZ");
            resDiagGAS.aptosMedicos = {};
            if (rowsAptos.length > 0) {
                let colDiaria = -1; for (let c = rowsAptos[0].length - 1; c >= 12; c--) { if (String(rowsAptos[0][c] || "").trim() !== "") { colDiaria = c; break; } }
                for (let i = 1; i < rowsAptos.length; i++) {
                    let n = String(rowsAptos[i][0] || "").trim(); if (!n || n.toLowerCase() === "nombre completo") continue;
                    let dni = String(rowsAptos[i][1] || "").replace(/\D/g, ''); if (dni.length >= 10) dni = String(parseInt(dni.substring(2, 10), 10));
                    let estado = "-"; let limit = colDiaria > -1 ? colDiaria : rowsAptos[i].length - 1;
                    for (let c = limit; c >= 12; c--) { let val = String(rowsAptos[i][c] || "").trim(); if (val !== "" && val !== "-") { estado = val; break; } }
                    let objApto = { dni, cuil: String(rowsAptos[i][1] || ""), estadoGeneral: String(rowsAptos[i][2] || ""), estado, observaciones: rowsAptos[i][10] || "", observaciones_sector_salud: rowsAptos[i][11] || "" };
                    let norm = normalizar(n);
                    resDiagGAS.aptosMedicos[dni] = objApto; 
                    resDiagGAS.aptosMedicos[norm] = objApto;
                    if (norm.includes('ñ')) resDiagGAS.aptosMedicos[norm.replace(/ñ/g, 'n')] = objApto;
                }
            }
        } catch (e) {}
        
        const rowsObs = await fetchRango(ID_SHEET_OBSERVACIONES, "'Movimientos'!A5:H");
        resDiagGAS.observaciones = {};
        rowsObs.forEach(row => {
            if(!row[1]) return; 
            let norm = normalizar(row[1]); 
            if (!resDiagGAS.observaciones[norm]) resDiagGAS.observaciones[norm] = [];
            let obsItem = { admin: row[0] || "-", fecha: row[2] || "-", unidad: row[3] || "-", evento: row[4] || "-", obsEvento: row[5] || "", estado: row[6] || "-", obsEstado: row[7] || "" };
            resDiagGAS.observaciones[norm].push(obsItem);
            if (norm.includes('ñ')) {
                let sinEnie = norm.replace(/ñ/g, 'n');
                if (!resDiagGAS.observaciones[sinEnie]) resDiagGAS.observaciones[sinEnie] = resDiagGAS.observaciones[norm];
            }
        });

        let diasLegacyIso = {}; let hojasInfo = []; let nuevaSeccionViajes = {};
        try {
            const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60; // 2 meses configurados en RAM
            const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
            const limiteRamKmMs = hoyArKm.getTime() - (KM_RAM_DIAS * 24 * 3600 * 1000);
            const limiteRamIso = new Date(limiteRamKmMs).toISOString().split('T')[0];

            // 🌟 1. Intentar obtener la partición de RAM desde el microservicio exclusivo
            let viajesDesdeMicroservicio = null;
            if (isMicroservicioActivo()) {
                viajesDesdeMicroservicio = await obtenerViajesMicroservicio();
            }

            if (viajesDesdeMicroservicio && typeof viajesDesdeMicroservicio === 'object' && Object.keys(viajesDesdeMicroservicio).length > 0) {
                console.log(`⚡ [RAM] Partición de Kilómetros hidratada (${KM_RAM_DIAS} días) desde microservicio exclusivo.`);
                // Garantizar que la RAM principal solo retenga los 2 meses configurados
                nuevaSeccionViajes = {};
                for (const chKey in viajesDesdeMicroservicio) {
                    const viajesCh = viajesDesdeMicroservicio[chKey];
                    if (!viajesCh || typeof viajesCh !== 'object') continue;
                    for (const fIso in viajesCh) {
                        if (fIso >= limiteRamIso) {
                            if (!nuevaSeccionViajes[chKey]) nuevaSeccionViajes[chKey] = {};
                            nuevaSeccionViajes[chKey][fIso] = viajesCh[fIso];
                        }
                    }
                }
            } else {
                // 🔄 2. Fallback de resiliencia: Extracción local directa si el microservicio no está activo o no responde
                if (isMicroservicioActivo()) {
                    console.warn("⚠️ [RAM] Microservicio configurado pero no respondió. Ejecutando extracción local de respaldo...");
                } else {
                    console.log(`ℹ️ [RAM] Microservicio no configurado (KM_SERVICE_URL vacío). Ejecutando extracción local para KM (${KM_RAM_DIAS} días)...`);
                }

                const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;

                (await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T")).forEach(row => {
                    let fRaw = row[1], nRaw = row[2]; if (!fRaw || !nRaw) return;
                    let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
                    if (parts.length >= 3) { let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2]; dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]); } else { dObj = new Date(fRaw); }
                    if (isNaN(dObj.getTime())) return;
                    
                    // Descartar registros históricos mayores a 2 meses en RAM (el resto se sirve por consulta)
                    if (dObj.getTime() < limiteRamKmMs) return;

                    let choferNorm = normalizar(nRaw); let isoDate = dObj.toISOString().split('T')[0];
                    let km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]); let campo = parseNum(row[5]); let hojaStr = String(row[19] || "").trim();
                    if (km > 0 || campo > 0 || hojaStr !== "") {
                        if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                        if (!nuevaSeccionViajes[choferNorm][isoDate]) nuevaSeccionViajes[choferNorm][isoDate] = { dominio: String(row[0] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                        let target = nuevaSeccionViajes[choferNorm][isoDate]; target.km += km; target.campo += campo;
                        if (hojaStr !== "") hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                        if (choferNorm.includes('ñ')) {
                            let sinEnie = choferNorm.replace(/ñ/g, 'n');
                            nuevaSeccionViajes[sinEnie] = nuevaSeccionViajes[choferNorm];
                        }
                    }
                });
            }
        } catch(e) {
            console.error("❌ Error cargando viajes/km en RAM:", e);
        }



        resDiagGAS.fotosImgur = {};
        try {
            const { data: dbChoferes } = await supabase.from('choferes').select('dni, foto').not('foto', 'is', null);
            if (dbChoferes && dbChoferes.length > 0) {
                dbChoferes.forEach(c => {
                    if (c.dni && c.foto) {
                        let n = String(c.dni).replace(/\D/g, '');
                        if (n.length >= 10) n = n.substring(2, 10);
                        resDiagGAS.fotosImgur[String(parseInt(n, 10))] = String(c.foto).trim();
                    }
                });
            }
        } catch (e) {
            console.warn("⚠️ Fallback al cargar fotos desde Supabase DB:", e.message);
        }

        // Fallback a Sheets de respaldo si la base estuviera vacía
        if (Object.keys(resDiagGAS.fotosImgur).length === 0) {
            (await fetchRango(ID_SPREADSHEET_MASTER, "'fotos'!A:B")).forEach(row => { 
                if (row[0] && row[1] && String(row[1]).includes('http')) { let n = String(row[0]).replace(/\D/g, ''); if (n.length >= 10) n = n.substring(2, 10); resDiagGAS.fotosImgur[String(parseInt(n, 10))] = String(row[1]).trim(); }
            });
        }

        try {
            const [rowsDoc, rowsHab] = await Promise.all([ fetchRango(ID_SHEET_DOCUMENTOS, "'PERIODICOS'!A:I"), fetchRango(ID_SHEET_HABILITACIONES, "'VENCIMIENTOS'!A:E") ]);
            const fRev = (s) => { if (!s) return null; let p = String(s).split('/'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : null; };
            const calcEst = (s) => { if (!s) return 'OK'; let p = String(s).split('/'); if(p.length !== 3) return 'OK'; let d = Math.ceil((new Date(p[2], p[1]-1, p[0]) - new Date()) / 86400000); return d < 0 ? 'VENCIDO' : (d <= 30 ? 'POR_VENCER' : 'VIGENTE'); };

            let traductorCuil = {}; let traductorDni = {};
            let cuilToDni = {}; let dniToRouterName = {};
            let cuilToDiagramaName = {}; let dniToDiagramaName = {};
            
            if (cacheDatosGlobales.choferesRouter) {
                for (let key in cacheDatosGlobales.choferesRouter) {
                    let c = cacheDatosGlobales.choferesRouter[key]; 
                    let nombreOficial = normalizar(c.nombre);
                    let nombreDiagrama = normalizar(c.nombreDiagrama);
                    
                    if (c.cuil) { 
                        traductorCuil[c.cuil] = nombreOficial; 
                        if (c.dni) cuilToDni[c.cuil] = String(parseInt(c.dni, 10)); 
                        if (nombreDiagrama) cuilToDiagramaName[c.cuil] = nombreDiagrama;
                    }
                    if (c.dni) { 
                        let d = String(parseInt(c.dni, 10)); 
                        traductorDni[d] = nombreOficial; 
                        dniToRouterName[d] = nombreOficial; 
                        if (nombreDiagrama) dniToDiagramaName[d] = nombreDiagrama;
                    }
                }
            }

            let dniToDiagramasName = {};
            for (let norm in dnisMap) {
                if (dnisMap[norm] && dnisMap[norm].dni) {
                    dniToDiagramasName[dnisMap[norm].dni] = norm;
                }
            }

            rowsDoc.forEach(r => { 
                let cuilCelda = String(r[4] || "").replace(/\D/g, ''); 
                let dniCelda = cuilToDni[cuilCelda];
                let diagName = dniCelda ? dniToDiagramasName[dniCelda] : null;
                let explicitDiagName = cuilToDiagramaName[cuilCelda];
                let routerName = dniCelda ? dniToRouterName[dniCelda] : null;
                let fallbackRouterName = traductorCuil[cuilCelda];
                let sheetName = normalizar(r[1]);
                let v = fRev(r[8]); 

                if (v) {
                    let obj = { ven: v, estado: calcEst(r[8]) };
                    const regDoc = (k) => {
                        if (!k) return;
                        resDiagGAS.documentos[k] = obj;
                        if (k.includes('ñ')) resDiagGAS.documentos[k.replace(/ñ/g, 'n')] = obj;
                    };
                    regDoc(sheetName);
                    regDoc(diagName);
                    regDoc(explicitDiagName);
                    regDoc(routerName);
                    regDoc(fallbackRouterName);
                }
            });

            rowsHab.forEach(r => { 
                let rawDni = String(r[2] || "").replace(/\D/g, '');
                let dniCelda = rawDni ? String(parseInt(rawDni, 10)) : "";
                
                let diagName = dniCelda ? dniToDiagramasName[dniCelda] : null;
                let explicitDiagName = dniCelda ? dniToDiagramaName[dniCelda] : null;
                let routerName = dniCelda ? dniToRouterName[dniCelda] : null;
                let fallbackRouterName = traductorDni[dniCelda];
                let sheetName = normalizar(r[1]);
                let c = fRev(r[3]); let l = fRev(r[4]); 

                if (c) { 
                    let obj = { ven: c, estado: calcEst(r[3]) };
                    const regCert = (k) => {
                        if (!k) return;
                        resDiagGAS.certificados[k] = obj;
                        if (k.includes('ñ')) resDiagGAS.certificados[k.replace(/ñ/g, 'n')] = obj;
                    };
                    regCert(sheetName);
                    regCert(diagName);
                    regCert(explicitDiagName);
                    regCert(routerName);
                    regCert(fallbackRouterName);
                } 
                if (l) { 
                    let obj = { ven: l, estado: calcEst(r[4]) };
                    const regHab = (k) => {
                        if (!k) return;
                        resDiagGAS.habilitaciones[k] = obj;
                        if (k.includes('ñ')) resDiagGAS.habilitaciones[k.replace(/ñ/g, 'n')] = obj;
                    };
                    regHab(sheetName);
                    regHab(diagName);
                    regHab(explicitDiagName);
                    regHab(routerName);
                    regHab(fallbackRouterName);
                } 
            });
        } catch(e) { console.error("Error cargando docs/habs:", e); }

        // 1. Cargar cache histórico de diagramas desde Master (CACHE_DIAGRAMAS tab)
        diasLegacyIso = {};
        try {
            const rowsMasterCache = await fetchRango(ID_SPREADSHEET_MASTER, "'CACHE_DIAGRAMAS'!A2:C1000");
            rowsMasterCache.forEach(r => {
                let norm = normalizar(r[0]);
                if (norm && r[1]) {
                    try {
                        diasLegacyIso[norm] = JSON.parse(r[1]);
                    } catch(eJson) {}
                }
            });
            console.log(`📦 Cache de diagramas cargado desde Master: ${Object.keys(diasLegacyIso).length} choferes.`);
        } catch(eMasterCache) {
            console.error("Error leyendo CACHE_DIAGRAMAS de Master:", eMasterCache);
        }

        let hoyAr2 = getFechaArgentina();
        let offsetsMeses = [-1, 0, 1, 2]; 
        for (let i of offsetsMeses) {
            let d = new Date(hoyAr2.getFullYear(), hoyAr2.getMonth() + i, 1); 
            let anio = d.getFullYear(); 
            let targetMonthNum = d.getMonth() + 1;
            let mesStr = String(targetMonthNum).padStart(2, '0');
            let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2); 

            const rowsSheet = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A1:AL1000`);
            if (rowsSheet.length === 0) continue;

            let dayColMap = {};
            for (let r = 0; r < Math.min(10, rowsSheet.length); r++) {
                let tempMap = {};
                let matchesCount = 0;
                if (!rowsSheet[r]) continue;

                for (let c = 0; c < rowsSheet[r].length; c++) {
                    let cellVal = String(rowsSheet[r][c] || "").trim();
                    let m = cellVal.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-](0*([1-9]|1[0-2]))$/);
                    if (m) {
                        let dayNum = parseInt(m[1], 10);
                        let monthNum = parseInt(m[2], 10);
                        if (monthNum === targetMonthNum) {
                            if (tempMap[dayNum] === undefined) {
                                tempMap[dayNum] = c;
                                matchesCount++;
                            }
                        }
                    }
                }

                if (matchesCount >= 15) {
                    dayColMap = tempMap;
                    break;
                }
            }

            const maxDaysInMonth = new Date(anio, targetMonthNum, 0).getDate();

            if (Object.keys(dayColMap).length === 0) {
                let offsetDia1 = 4;
                const patronDia1 = new RegExp(`^0*1[\\\/\\-]${targetMonthNum}$`);
                outer: for (let r = 0; r < Math.min(12, rowsSheet.length); r++) {
                    if (!rowsSheet[r]) continue;
                    for (let c = 0; c < rowsSheet[r].length; c++) {
                        let cellVal = String(rowsSheet[r][c] || '').trim();
                        if (patronDia1.test(cellVal)) {
                            offsetDia1 = c;
                            break outer;
                        }
                    }
                }
                for (let dia = 1; dia <= maxDaysInMonth; dia++) dayColMap[dia] = offsetDia1 + (dia - 1);
            }

            rowsSheet.forEach(row => {
                let n = row[1]; 
                if (!n || ["APELLIDO Y NOMBRE", "Personal Activo", "LEGAJO"].includes(String(n).trim())) return; 
                let nomNorm = normalizar(n); 
                if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};

                for (let dia = 1; dia <= maxDaysInMonth; dia++) { 
                    let colIdx = dayColMap[dia];
                    let est = colIdx !== undefined ? row[colIdx] : undefined; 
                    if (est && est !== '-') {
                        diasLegacyIso[nomNorm][`${anio}-${mesStr}-${String(dia).padStart(2, '0')}`] = String(est).toUpperCase().trim(); 
                    }
                }
            });
        }

        // Construir hojasInfo para TODOS los meses del año (para que el front tenga la tira completa de cada mes)
        let baseYear = hoyAr2.getFullYear();
        hojasInfo = [];
        let mesesTotal = [
            { anio: baseYear - 1, mes: 11 }, { anio: baseYear - 1, mes: 12 },
            { anio: baseYear, mes: 1 }, { anio: baseYear, mes: 2 }, { anio: baseYear, mes: 3 }, { anio: baseYear, mes: 4 },
            { anio: baseYear, mes: 5 }, { anio: baseYear, mes: 6 }, { anio: baseYear, mes: 7 }, { anio: baseYear, mes: 8 },
            { anio: baseYear, mes: 9 }, { anio: baseYear, mes: 10 }, { anio: baseYear, mes: 11 }, { anio: baseYear, mes: 12 },
            { anio: baseYear + 1, mes: 1 }, { anio: baseYear + 1, mes: 2 }
        ];
        mesesTotal.forEach(m => {
            let mesStr = String(m.mes).padStart(2, '0');
            let nombreHoja = mesesAbrev[m.mes - 1] + "-" + String(m.anio).slice(-2);
            hojasInfo.push({ nombre: nombreHoja, anio: m.anio, mesStr });
        });

        let diagramasHibridos = []; 
        listaChoferesMaestros.forEach(ch => {
            let nomNorm = ch.norm;
            let nomNormSinEnie = nomNorm.includes('ñ') ? nomNorm.replace(/ñ/g, 'n') : null;
            let flota = resDiagGAS.flota[nomNorm] || {};
            let mergeIso = diasLegacyIso[nomNorm] || {};
            let diasFront = {};
            hojasInfo.forEach(info => {
                let tira = [];
                for (let dia = 1; dia <= 31; dia++) {
                    tira.push(mergeIso[`${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`] || "-");
                }
                diasFront[info.nombre] = tira.join(",");
            });

            let safeId = "drv_" + nomNorm.replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, "_");
            let utChofer = mapaChoferAUt[nomNorm] || (nomNormSinEnie ? mapaChoferAUt[nomNormSinEnie] : null) || null;
            if (utChofer) {
                utChofer.chofer_asignado = { nom: ch.nombre, _safeId: safeId };
            }

            // Datos centralizados de identidad, contacto, fotos y documentos
            let dniVal = (resDiagGAS.dnis[nomNorm]?.dni || (nomNormSinEnie ? resDiagGAS.dnis[nomNormSinEnie]?.dni : null)) || '';
            let fotoUrl = (dniVal && resDiagGAS.fotosImgur[dniVal]) ? resDiagGAS.fotosImgur[dniVal] : '';
            let contactoObj = resDiagGAS.telefonos[nomNorm] || (nomNormSinEnie ? resDiagGAS.telefonos[nomNormSinEnie] : null) || (dniVal ? resDiagGAS.telefonos[dniVal] : null) || null;
            let aptoMed = (dniVal ? resDiagGAS.aptosMedicos[dniVal] : null) || resDiagGAS.aptosMedicos[nomNorm] || (nomNormSinEnie ? resDiagGAS.aptosMedicos[nomNormSinEnie] : null) || null;
            let docMed = resDiagGAS.documentos[nomNorm] || (nomNormSinEnie ? resDiagGAS.documentos[nomNormSinEnie] : null) || null;
            let docLic = resDiagGAS.habilitaciones[nomNorm] || (nomNormSinEnie ? resDiagGAS.habilitaciones[nomNormSinEnie] : null) || null;
            let docCert = resDiagGAS.certificados[nomNorm] || (nomNormSinEnie ? resDiagGAS.certificados[nomNormSinEnie] : null) || null;
            let obsList = resDiagGAS.observaciones[nomNorm] || (nomNormSinEnie ? resDiagGAS.observaciones[nomNormSinEnie] : null) || [];
            let nomLimpio = nomNorm.replace(/[,;.]/g, ' ').replace(/\s+/g, ' ').trim();
            let viajesChofer = nuevaSeccionViajes[nomNorm] 
                || (nomNormSinEnie ? nuevaSeccionViajes[nomNormSinEnie] : null) 
                || nuevaSeccionViajes[nomLimpio]
                || (nomLimpio.includes('ñ') ? nuevaSeccionViajes[nomLimpio.replace(/ñ/g, 'n')] : null)
                || {};

            let chInfo = cacheDatosGlobales.choferesRouter ? Object.values(cacheDatosGlobales.choferesRouter).find(c => {
                let nd = normalizar(c.nombreDiagrama);
                let nv = normalizar(c.nombreVencimientos);
                let np = normalizar(c.nombrePeriodicos);
                return nd === nomNorm || nv === nomNorm || np === nomNorm || (c.dni && dniVal && c.dni === dniVal);
            }) : null;

            diagramasHibridos.push({
                _safeId: safeId,
                nom: ch.nombre,
                srv_chofer: flota.servicio || 'S/A',
                dni: dniVal,
                cuil: chInfo ? chInfo.cuil : (flota.cuil || ''),
                identidad_fuentes: chInfo ? {
                    nombre_vencimientos: chInfo.nombreVencimientos || ch.nombre,
                    nombre_periodicos: chInfo.nombrePeriodicos || ch.nombre,
                    nombre_diagrama: chInfo.nombreDiagrama || ch.nombre
                } : {
                    nombre_vencimientos: ch.nombre,
                    nombre_periodicos: ch.nombre,
                    nombre_diagrama: ch.nombre
                },
                foto: fotoUrl,
                contacto: contactoObj ? {
                    telefono: contactoObj.telefono || '',
                    email: contactoObj.email || '',
                    legajo: contactoObj.legajo || '',
                    fechaAlta: contactoObj.fechaAlta || ''
                } : null,
                documentos: {
                    medico: docMed,
                    licencia: docLic,
                    certificados: docCert,
                    apto_medico: aptoMed
                },
                dias: diasFront,
                ut: utChofer,
                tractor: utChofer?.tractor?.patente || flota.tractor || '',
                semi: utChofer?.semi?.patente || flota.semi || '',
                cisternado: utChofer?.semi?.cisternado || utChofer?.tractor?.semi?.cisternado || utChofer?.tractor?.cisternado || flota.cisternado || '',
                n_ute: utChofer?.n_ute || flota.n_ute || '',
                observaciones: obsList,
                viajes: viajesChofer
            });
        });

        // Delimitar catálogo de Control de Flota estrictamente a la flota actual de ID_SHEET_MOVIMIENTOS
        const patentesFlotaActual = new Set();
        const listaVencimientosFlotaActual = [];

        // 1. Patentes de la flota activa desde catalogoUnidades (Mov.Unidades y Choferes)
        catalogoUnidades.forEach(ut => {
            if (ut.tractor?.patente) {
                let p = ut.tractor.patente.toUpperCase().trim();
                if (!patentesFlotaActual.has(p)) {
                    patentesFlotaActual.add(p);
                    let v = vencimientosPorPatente[p] || ut.tractor.vencimientos || {};
                    listaVencimientosFlotaActual.push({
                        patente: p,
                        marca: ut.tractor.marca || marcasTractores[p] || '',
                        esSemi: false,
                        tipo: 'TRACTOR',
                        n_ute: ut.n_ute || '',
                        srv_ut: ut.srv_ut || 'S/A',
                        semi: ut.semi || ut.tractor?.semi || null,
                        cisternado: ut.semi?.cisternado || ut.tractor?.semi?.cisternado || ut.tractor?.cisternado || '',
                        mas: v.mas || '',
                        vtv: v.vtv || '',
                        esp_es: v.esp_es || '',
                        vi: v.vi || '',
                        ve: v.ve || '',
                        col_b: p,
                        col_g: v.mas || '',
                        col_h: v.vtv || '',
                        col_j: '',
                        col_k: '',
                        col_l: v.esp_es || '',
                        col_m: v.vi || '',
                        col_n: v.ve || ''
                    });
                }
            }
            if (ut.semi?.patente) {
                let p = ut.semi.patente.toUpperCase().trim();
                if (!patentesFlotaActual.has(p)) {
                    patentesFlotaActual.add(p);
                    let v = vencimientosPorPatente[p] || ut.semi.vencimientos || {};
                    listaVencimientosFlotaActual.push({
                        patente: p,
                        marca: ut.semi.marca || marcasSemis[p] || '',
                        esSemi: true,
                        tipo: 'SEMI',
                        cisternado: ut.semi.cisternado || '',
                        n_ute: ut.n_ute || '',
                        srv_ut: ut.srv_ut || 'S/A',
                        mas: v.mas || '',
                        vtv: v.vtv || '',
                        esp_es: v.esp_es || '',
                        vi: v.vi || '',
                        ve: v.ve || '',
                        col_b: p,
                        col_g: '',
                        col_h: '',
                        col_j: v.mas || '',
                        col_k: v.vtv || '',
                        col_l: v.esp_es || '',
                        col_m: v.vi || '',
                        col_n: v.ve || ''
                    });
                }
            }
        });

        // 2. Patentes adicionales desde 'Vencimientos.' si existieran en la flota activa
        if (Array.isArray(rowsVencimientosSheet)) {
            rowsVencimientosSheet.forEach(r => {
                let ute = String(r[0] || '').trim();
                let tr = String(r[1] || '').trim().toUpperCase().replace(/\s+/g, '');
                let se = String(r[2] || '').trim().toUpperCase().replace(/\s+/g, '');
                if (tr && tr !== 'TRACTOR' && !patentesFlotaActual.has(tr)) {
                    patentesFlotaActual.add(tr);
                    let v = vencimientosPorPatente[tr] || {};
                    listaVencimientosFlotaActual.push({
                        patente: tr,
                        marca: marcasTractores[tr] || '',
                        esSemi: false,
                        tipo: 'TRACTOR',
                        n_ute: ute,
                        srv_ut: 'S/A',
                        mas: v.mas || '',
                        vtv: v.vtv || '',
                        esp_es: v.esp_es || '',
                        vi: v.vi || '',
                        ve: v.ve || '',
                        col_b: tr,
                        col_g: v.mas || '',
                        col_h: v.vtv || '',
                        col_j: '',
                        col_k: '',
                        col_l: v.esp_es || '',
                        col_m: v.vi || '',
                        col_n: v.ve || ''
                    });
                }
                if (se && se !== 'SEMI' && !patentesFlotaActual.has(se)) {
                    patentesFlotaActual.add(se);
                    let v = vencimientosPorPatente[se] || {};
                    listaVencimientosFlotaActual.push({
                        patente: se,
                        marca: marcasSemis[se] || '',
                        esSemi: true,
                        tipo: 'SEMI',
                        n_ute: ute,
                        srv_ut: 'S/A',
                        mas: v.mas || '',
                        vtv: v.vtv || '',
                        esp_es: v.esp_es || '',
                        vi: v.vi || '',
                        ve: v.ve || '',
                        col_b: se,
                        col_g: '',
                        col_h: '',
                        col_j: v.mas || '',
                        col_k: v.vtv || '',
                        col_l: v.esp_es || '',
                        col_m: v.vi || '',
                        col_n: v.ve || ''
                    });
                }
            });
        }

        resDiagGAS.vencimientosObj = listaVencimientosFlotaActual;
        console.log(`🚚 Catálogo de Control de Flota delimitado a la flota actual (${ID_SHEET_MOVIMIENTOS}): ${listaVencimientosFlotaActual.length} unidades activas.`);

        // Mapa indexado de UTs por N° UTE para búsqueda inmediata O(1)
        const mapaUtPorNumero = {};
        catalogoUnidades.forEach(u => {
            if (u.n_ute) mapaUtPorNumero[u.n_ute] = u;
        });

        // Protección de resiliencia: Si la descarga falló por red/cuota y devolvió 0 choferes,
        // no sobreescribir la memoria existente con una base de datos vacía.
        if (diagramasHibridos.length === 0 && cacheDatosGlobales.diagramas && Array.isArray(cacheDatosGlobales.diagramas.diagramas) && cacheDatosGlobales.diagramas.diagramas.length > 0) {
            console.warn("⚠️ [RAM] Escaneo incompleto o error de conexión con Google Sheets (0 choferes). Conservando RAM previa intacta.");
            return;
        }

        cacheDatosGlobales.diagramas = { 
            diagramas: diagramasHibridos,
            ut: catalogoUnidades,             // Grupo completo de objetos UT en RAM (incluso inactivos/no asignados)
            unidades: catalogoUnidades,       // Alias de compatibilidad
            utMap: mapaUtPorNumero,           // Diccionario indexado por n_ute
            flota: resDiagGAS.flota,
            vencimientosObj: resDiagGAS.vencimientosObj,
            marcasTractores: marcasTractores,
            marcasSemis: marcasSemis,
            vencimientosPorPatente: vencimientosPorPatente,
            nuevaSeccionViajes: nuevaSeccionViajes
        };
        cacheDatosGlobales.ut = catalogoUnidades; // Acceso directo en raíz de RAM
        cacheDatosGlobales.vencimientosObj = resDiagGAS.vencimientosObj;
        cacheDatosGlobales.marcasTractores = marcasTractores;
        cacheDatosGlobales.marcasSemis = marcasSemis;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        // Load users for mentions autocomplete
        try {
            const rowsUsuarios = await fetchRango(ID_SPREADSHEET_MASTER, "'DB_Usuarios'!A:C");
            cacheDatosGlobales.usuarios = rowsUsuarios
                .filter(row => row[0] && String(row[0]).trim().toLowerCase() !== 'usuario')
                .map(row => String(row[0]).trim().toUpperCase());
            console.log(`👥 Usuarios cargados para menciones: ${cacheDatosGlobales.usuarios.length}`);
        } catch (eUsers) {
            console.error('Error cargando usuarios:', eUsers);
            if (!cacheDatosGlobales.usuarios) cacheDatosGlobales.usuarios = [];
        }
        
        // 👉 Auto-enriquecer novedades con los tractores / n_ute de la flota recién ensamblada y persistir en Sheets
        try {
            await enriquecerNovedadesConFlota(cacheDatosGlobales, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango);
        } catch (eEnrich) {
            console.error("Error al enriquecer novedades con la flota:", eEnrich);
        }

        if (io) emitirDatosSiCambiaron(io, cacheDatosGlobales);
        
        // 👉 SE EMITE AL NUEVO DASHBOARD CADA VEZ QUE LA RAM SE RE-ENSAMBLA
        if(cacheDatosGlobales.novedades && cacheDatosGlobales.novedades.length > 0) ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
        
        console.log(`✅ RAM Ensamblada Completa.`);
        
    } catch (error) { console.error("❌ Error RAM:", error); } 
}

async function syncAllDiagramasToMaster(cacheDatosGlobales = null, io = null) {
    try {
        console.log("🔄 INICIANDO SINCRONIZACIÓN COMPLETA DE DIAGRAMAS -> MASTER (1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc)...");
        const resMeta = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}` });
        const allSheets = (resMeta.data.sheets || []).map(s => s.properties.title);

        const monthTabs = allSheets.filter(s => {
            let low = s.toLowerCase();
            return mesesAbrev.some(m => low.includes(m.toLowerCase())) && /\d{2}/.test(s);
        });

        let diasLegacyIso = {};

        for (let nombreHoja of monthTabs) {
            let parts = nombreHoja.split('-');
            if (parts.length < 2) continue;
            let mIdx = mesesAbrev.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
            if (mIdx === -1) continue;
            let anioStr = "20" + parts[1].replace(/\D/g, '');
            let targetMonthNum = mIdx + 1;
            let mesStr = String(targetMonthNum).padStart(2, '0');
            let anio = parseInt(anioStr, 10);

            const rowsSheet = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A1:AL1000`);
            if (rowsSheet.length === 0) continue;

            let dayColMap = {};
            for (let r = 0; r < Math.min(10, rowsSheet.length); r++) {
                let tempMap = {};
                let matchesCount = 0;
                if (!rowsSheet[r]) continue;

                for (let c = 0; c < rowsSheet[r].length; c++) {
                    let cellVal = String(rowsSheet[r][c] || "").trim();
                    let m = cellVal.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-](0*([1-9]|1[0-2]))$/);
                    if (m) {
                        let dayNum = parseInt(m[1], 10);
                        let monthNum = parseInt(m[2], 10);
                        if (monthNum === targetMonthNum) {
                            if (tempMap[dayNum] === undefined) {
                                tempMap[dayNum] = c;
                                matchesCount++;
                            }
                        }
                    }
                }

                if (matchesCount >= 15) {
                    dayColMap = tempMap;
                    break;
                }
            }

            const maxDaysInMonth = new Date(anio, targetMonthNum, 0).getDate();

            if (Object.keys(dayColMap).length === 0) {
                let offsetDia1 = 4;
                const patronDia1 = new RegExp(`^0*1[\\\/\\-]${targetMonthNum}$`);
                outer: for (let r = 0; r < Math.min(12, rowsSheet.length); r++) {
                    if (!rowsSheet[r]) continue;
                    for (let c = 0; c < rowsSheet[r].length; c++) {
                        let cellVal = String(rowsSheet[r][c] || '').trim();
                        if (patronDia1.test(cellVal)) {
                            offsetDia1 = c;
                            break outer;
                        }
                    }
                }
                for (let dia = 1; dia <= maxDaysInMonth; dia++) dayColMap[dia] = offsetDia1 + (dia - 1);
            }

            rowsSheet.forEach(row => {
                let n = row[1]; 
                if (!n || ["APELLIDO Y NOMBRE", "Personal Activo", "LEGAJO"].includes(String(n).trim())) return; 
                let nomNorm = normalizar(n); 
                if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};

                for (let dia = 1; dia <= maxDaysInMonth; dia++) { 
                    let colIdx = dayColMap[dia];
                    let est = colIdx !== undefined ? row[colIdx] : undefined; 
                    if (est && est !== '-') {
                        diasLegacyIso[nomNorm][`${anio}-${mesStr}-${String(dia).padStart(2, '0')}`] = String(est).toUpperCase().trim(); 
                    }
                }
            });
        }

        const nowIso = new Date().toISOString();
        const rowsToWrite = [["CHOFER_NORM", "DIAGRAMAS_JSON", "ULTIMA_ACTUALIZACION"]];
        for (let normKey in diasLegacyIso) {
            rowsToWrite.push([normKey, JSON.stringify(diasLegacyIso[normKey]), nowIso]);
        }

        try {
            const resMasterMeta = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}` });
            const masterSheets = (resMasterMeta.data.sheets || []).map(s => s.properties.title);
            if (!masterSheets.includes("CACHE_DIAGRAMAS")) {
                await serviceAccountAuth.request({
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}:batchUpdate`,
                    method: 'POST',
                    data: { requests: [{ addSheet: { properties: { title: "CACHE_DIAGRAMAS" } } }] }
                });
            }
        } catch(eTab) {}

        await serviceAccountAuth.request({
            url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'CACHE_DIAGRAMAS'!A1:Z:clear`,
            method: 'POST'
        });

        await serviceAccountAuth.request({
            url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'CACHE_DIAGRAMAS'!A1?valueInputOption=USER_ENTERED`,
            method: 'PUT',
            data: { values: rowsToWrite }
        });

        console.log(`✅ Sincronización guardada en 'CACHE_DIAGRAMAS' en Master (${rowsToWrite.length - 1} choferes).`);

        if (cacheDatosGlobales && io) {
            await actualizarCacheDesdeGoogle(cacheDatosGlobales, io);
        }
        return true;
    } catch(e) {
        console.error("❌ Error en syncAllDiagramasToMaster:", e);
        return false;
    }
}

async function actualizarSubnodosKm(cacheDatosGlobales, io, viajesExternos = null) {
    try {
        let nuevosViajes = viajesExternos;
        if (!nuevosViajes && isMicroservicioActivo()) {
            nuevosViajes = await obtenerViajesMicroservicio();
        }
        if (!nuevosViajes || typeof nuevosViajes !== 'object') {
            console.warn("⚠️ [Subnodos-KM] No se pudieron obtener viajes válidos para actualizar subnodos.");
            return false;
        }

        if (!cacheDatosGlobales.diagramas) {
            console.warn("⚠️ [Subnodos-KM] La RAM principal de diagramas aún no está ensamblada.");
            return false;
        }

        // 1. Actualizar sección global de viajes
        cacheDatosGlobales.diagramas.nuevaSeccionViajes = nuevosViajes;

        // 2. Vincular como subnodo a cada entidad chofer
        if (Array.isArray(cacheDatosGlobales.diagramas.diagramas)) {
            let actualizados = 0;
            cacheDatosGlobales.diagramas.diagramas.forEach(ch => {
                const nomNorm = normalizar(ch.nom);
                const nomNormSinEnie = nomNorm.includes('ñ') ? nomNorm.replace(/ñ/g, 'n') : null;
                const nomLimpio = nomNorm.replace(/[,;.]/g, ' ').replace(/\s+/g, ' ').trim();
                const viajesChofer = nuevosViajes[nomNorm] 
                    || (nomNormSinEnie ? nuevosViajes[nomNormSinEnie] : null) 
                    || nuevosViajes[nomLimpio]
                    || (nomLimpio.includes('ñ') ? nuevosViajes[nomLimpio.replace(/ñ/g, 'n')] : null)
                    || {};
                ch.viajes = viajesChofer;
                actualizados++;
            });
            console.log(`🔗 [Subnodos-KM] ${actualizados} choferes actualizados con subnodos de viajes.`);
        }

        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();

        if (io) {
            emitirDatosSiCambiaron(io, cacheDatosGlobales);
            console.log("📡 [Subnodos-KM] Verificación de cambios completada tras actualización de subnodos.");
        }

        return true;
    } catch (e) {
        console.error("❌ Error en actualizarSubnodosKm:", e);
        return false;
    }
}

function iniciarCachePolling(cacheDatosGlobales, io, ioDash) {
    // ⚡ Arranque inmediato desde Supabase (carga inicial completa forzada con KM)
    flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, { forceFull: true, recargarKm: true }); 
    
    // Refresco periódico ligero desde Supabase cada 5 minutos (con Dirty Check activado y sin recargar KM)
    setInterval(() => { 
        console.log("⏱️ Refresco periódico desde Supabase (5 min, Dirty Check activado)..."); 
        flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, { forceFull: false, recargarKm: false }); 
    }, 5 * 60 * 1000);

    // 🔄 Sincronización autónoma de Partición 6 (Movimientos Activos y Desuniones)
    // Mantiene Supabase y Hot RAM al día desde Google Sheets cuando n8n está inactivo
    setTimeout(() => {
        try {
            const { sincronizarMovimientosDesdeSheets } = require('../routes/movimientos');
            sincronizarMovimientosDesdeSheets(cacheDatosGlobales, io, ioDash).catch(e => {
                console.warn("⚠️ [Partición 6 Auto-Sync] Advertencia en ciclo inicial:", e.message);
            });
        } catch (eReq) {
            console.warn("⚠️ [Partición 6 Auto-Sync] No se pudo cargar módulo movimientos:", eReq.message);
        }

        setInterval(async () => {
            try {
                console.log("⏱️ [Partición 6 Auto-Sync] Sincronizando Movimientos y Desuniones desde Google Sheets...");
                const { sincronizarMovimientosDesdeSheets } = require('../routes/movimientos');
                await sincronizarMovimientosDesdeSheets(cacheDatosGlobales, io, ioDash);
            } catch (eSync) {
                console.warn("⚠️ [Partición 6 Auto-Sync] Error en ciclo periódico:", eSync.message);
            }
        }, 5 * 60 * 1000);
    }, 45 * 1000); // Primer barrido a los 45s tras el arranque

    // 📅 Sincronización autónoma de Partición 5 (Días Diagrama - EOR)
    // Mantiene Supabase y Hot RAM al día desde Google Sheets sin depender de n8n local
    setTimeout(() => {
        try {
            const { sincronizarDiagramasDesdeSheets } = require('../routes/diagramasSync');
            sincronizarDiagramasDesdeSheets(cacheDatosGlobales, io, ioDash).catch(e => {
                console.warn("⚠️ [Partición 5 Auto-Sync] Advertencia en ciclo inicial:", e.message);
            });
        } catch (eReq) {
            console.warn("⚠️ [Partición 5 Auto-Sync] No se pudo cargar módulo diagramasSync:", eReq.message);
        }

        setInterval(async () => {
            try {
                console.log("⏱️ [Partición 5 Auto-Sync] Sincronizando Días Diagrama desde Google Sheets...");
                const { sincronizarDiagramasDesdeSheets } = require('../routes/diagramasSync');
                await sincronizarDiagramasDesdeSheets(cacheDatosGlobales, io, ioDash);
            } catch (eSync) {
                console.warn("⚠️ [Partición 5 Auto-Sync] Error en ciclo periódico:", eSync.message);
            }
        }, 15 * 60 * 1000); // Cada 15 minutos (Diffing O(1) Zero Egress)
    }, 60 * 1000); // Primer barrido a los 60s tras el arranque

    // 🚚 Sincronización autónoma de Partición 7 (Kilómetros y Viajes)
    // Mantiene public.choferes_km_mensual al día sin depender de n8n local
    setTimeout(() => {
        try {
            const { sincronizarKmDesdeSheets } = require('../routes/kmSync');
            sincronizarKmDesdeSheets(cacheDatosGlobales, io, ioDash).catch(e => {
                console.warn("⚠️ [Partición 7 Auto-Sync] Advertencia en ciclo inicial:", e.message);
            });
        } catch (eReq) {
            console.warn("⚠️ [Partición 7 Auto-Sync] No se pudo cargar módulo kmSync:", eReq.message);
        }

        setInterval(async () => {
            try {
                console.log("⏱️ [Partición 7 Auto-Sync] Sincronizando Kilómetros desde Google Sheets...");
                const { sincronizarKmDesdeSheets } = require('../routes/kmSync');
                await sincronizarKmDesdeSheets(cacheDatosGlobales, io, ioDash);
            } catch (eSync) {
                console.warn("⚠️ [Partición 7 Auto-Sync] Error en ciclo periódico:", eSync.message);
            }
        }, 30 * 60 * 1000); // Cada 30 minutos (Diffing O(1) Zero Egress)
    }, 90 * 1000); // Primer barrido a los 90s tras el arranque
}

module.exports = { 
    iniciarCachePolling, 
    flujoEncoladoGlobal,
    actualizarCacheDesdeSupabase,
    actualizarCacheDesdeGoogle,
    syncAllDiagramasToMaster, 
    actualizarSubnodosKm,
    buildSocketPayload,
    emitirDatosSiCambiaron
};


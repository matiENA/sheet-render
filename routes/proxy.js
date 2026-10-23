const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { 
    normalizar, 
    mesesAbrev, 
    serviceAccountAuth, 
    fetchRango, 
    ID_SPREADSHEET_DIAGRAMAS, 
    ID_SHEET_OBSERVACIONES, 
    ID_SHEET_DOCUMENTOS, 
    ID_SHEET_HABILITACIONES, 
    ID_SHEET_KILOMETROS,
    ID_SPREADSHEET_MASTER 
} = require('../utils/shared');
const { isMicroservicioActivo, guardarHojaRutaMicroservicio } = require('../utils/kmClient');
const { buildSocketPayload, emitirDatosSiCambiaron } = require('../cache/builder');
const db = require('../utils/db');

module.exports = function createProxyRouter(cacheDatosGlobales, io) {
    const router = express.Router();

    router.all('/sync-diagramas', async (req, res) => {
        try {
            const { syncAllDiagramasToMaster } = require('../cache/builder');
            syncAllDiagramasToMaster(cacheDatosGlobales, io).catch(e => console.error("Error en sync-diagramas:", e));
            res.json({ success: true, message: "Sincronización de diagramas históricos a Master iniciada." });
        } catch(e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.all('/sync-choferes', async (req, res) => {
        try {
            let sincronizarDbChoferesExterna = null;
            try {
                const syncMod = require('../sync/syncChoferes');
                sincronizarDbChoferesExterna = syncMod.sincronizarDbChoferesExterna;
            } catch(e) {}

            if (typeof sincronizarDbChoferesExterna === 'function') {
                const resultado = await sincronizarDbChoferesExterna();
                return res.json(resultado);
            }
            res.json({ success: true, message: "Sincronización gestionada localmente por local_loader." });
        } catch(e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/', async (req, res) => {
        try {
            const body = req.body;

            // Compatibilidad para login vía proxy
            if (body && body.action === 'login') {
                const { usuario, password } = body;
                if (!usuario || !password) {
                    return res.json({ success: false, error: "Usuario y contraseña requeridos" });
                }
                const uClean = String(usuario).trim().toLowerCase();
                const pClean = String(password).trim();
                const db = require('../utils/db');
                const { supabase } = require('../utils/shared');
                
                if (db.isConfigured()) {
                    try {
                        const { rows } = await db.query(
                            'SELECT id, usuario, rol FROM usuarios_auth WHERE LOWER(TRIM(usuario)) = LOWER(TRIM($1)) AND password = $2 LIMIT 1',
                            [usuario, password]
                        );
                        if (rows && rows.length > 0) {
                            const user = rows[0];
                            return res.json({ 
                                success: true, 
                                token: 'auth_' + user.id + '_' + Date.now(), 
                                usuario: String(user.usuario).toUpperCase(), 
                                rol: user.rol,
                                fuente: 'POSTGRES_PG'
                            });
                        }
                    } catch (ePg) {
                        console.error("Error en proxy login con pg:", ePg.message);
                    }
                }

                try {
                    const { data: user } = await supabase
                        .from('usuarios_auth')
                        .select('id, usuario, rol')
                        .eq('usuario', usuario)
                        .eq('password', password)
                        .single();
                    if (user) {
                        return res.json({ 
                            success: true, 
                            token: 'auth_' + user.id + '_' + Date.now(), 
                            usuario: String(user.usuario).toUpperCase(), 
                            rol: user.rol,
                            fuente: 'SUPABASE_REST'
                        });
                    }
                } catch (eSupa) {}

                return res.json({ success: false, error: "Usuario o contraseña incorrectos" });
            }

            if (body && (body.action === 'guardarObservacion' || body.action === 'guardarNuevaObservacion')) {
                let nBuscado = normalizar(body.chofer);
                if (cacheDatosGlobales.diagramas) {
                    const nuevaObs = { admin: body.usuario || body.admin || 'Sistema', fecha: body.fecha, unidad: body.unidad || "-", evento: body.evento, obsEvento: body.obsEvento || "", estado: body.estado || "-", obsEstado: body.obsEstado || "" };
                    
                    // 1. Actualizar entidad centralizada de Chofer en RAM
                    if (Array.isArray(cacheDatosGlobales.diagramas.diagramas)) {
                        const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => {
                            const nomNorm = normalizar(c.nom);
                            return nomNorm === nBuscado || nomNorm.replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n');
                        });
                        if (choferObj) {
                            if (!Array.isArray(choferObj.observaciones)) choferObj.observaciones = [];
                            choferObj.observaciones.push(nuevaObs);
                        }
                    }

                    // 2. Fallback de compatibilidad si existiese mapa de observaciones
                    if (cacheDatosGlobales.diagramas.observaciones) {
                        if (!cacheDatosGlobales.diagramas.observaciones[nBuscado]) cacheDatosGlobales.diagramas.observaciones[nBuscado] = [];
                        cacheDatosGlobales.diagramas.observaciones[nBuscado].push(nuevaObs);
                    }

                    emitirDatosSiCambiaron(io, cacheDatosGlobales); 
                }

                // 3. Persistir en Supabase (chofer_observaciones)
                try {
                    const { supabase } = require('../utils/shared');
                    if (supabase) {
                        let targetChoferId = null;
                        const lista = cacheDatosGlobales?.diagramas?.diagramas || [];
                        const chEnCache = lista.find(c => {
                            const normC = normalizar(c.nom);
                            return normC === nBuscado || (nBuscado.includes('ñ') && normC.replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n'));
                        });
                        if (chEnCache?.id) {
                            targetChoferId = chEnCache.id;
                        } else {
                            const { data: cDb } = await supabase.from('choferes').select('id').ilike('nombre', `%${body.chofer}%`).limit(1).maybeSingle();
                            if (cDb?.id) targetChoferId = cDb.id;
                        }

                        if (targetChoferId) {
                            await supabase.from('chofer_observaciones').insert([{
                                chofer_id: targetChoferId,
                                fecha: body.fecha || new Date().toISOString().split('T')[0],
                                unidad_dominio: body.unidad || null,
                                evento: body.evento || 'Observación general',
                                obs_evento: body.obsEvento || '',
                                estado: body.estado || 'PENDIENTE',
                                obs_estado: body.obsEstado || '',
                                admin_carga: body.usuario || body.admin || 'Sistema'
                            }]);
                        }
                    }
                } catch (eSupaObs) {
                    console.warn("⚠️ Error guardando observación en Supabase:", eSupaObs.message);
                }

                // 4. Fallback a Google Sheets (no bloqueante)
                try {
                    const docObs = new GoogleSpreadsheet(ID_SHEET_OBSERVACIONES, serviceAccountAuth);
                    await docObs.loadInfo(); const sheetMov = docObs.sheetsByTitle['Movimientos'];
                    if (sheetMov) { await sheetMov.addRow([ body.usuario || body.admin || 'Sistema', body.chofer, body.fecha, body.unidad || "-", body.evento, body.obsEvento || "", body.estado || "-", body.obsEstado || "", "","","","","","","","" ]); }
                } catch(eSheetObs) {
                    console.warn("⚠️ Error en respaldo Sheets para observación:", eSheetObs.message);
                }

                return res.json({ success: true, message: "OK" });
            }

            if (body && body.action === 'guardarDocumentos') {
                let routerData = null;
                if (cacheDatosGlobales.choferesRouter) {
                    if (body.id && cacheDatosGlobales.choferesRouter[body.id]) { routerData = cacheDatosGlobales.choferesRouter[body.id]; } 
                    else if (body.dni || body.nombre) {
                        let dniBuscadoLimpio = body.dni ? String(body.dni).replace(/\D/g, '') : "";
                        let nomNormalizadoFront = normalizar(body.nombre);
                        routerData = Object.values(cacheDatosGlobales.choferesRouter).find(c => (dniBuscadoLimpio && (c.dniFallback === dniBuscadoLimpio || c.dni === dniBuscadoLimpio)) || normalizar(c.nombre) === nomNormalizadoFront || normalizar(c.nombre).replace(/ñ/g, 'n') === nomNormalizadoFront.replace(/ñ/g, 'n'));
                    }
                }

                let nBuscado = routerData ? normalizar(routerData.nombre) : normalizar(body.nombre);
                let dniParaVencimientos = routerData ? routerData.dni : (body.dni ? String(body.dni).replace(/\D/g, '') : "");
                let cuilParaPeriodicos = routerData ? routerData.cuil : dniParaVencimientos;

                const calcularEstadoISO = (fechaStr) => { 
                    if (!fechaStr) return 'OK'; 
                    let p = fechaStr.split('-'); let d = Math.ceil((new Date(p[0], p[1] - 1, p[2]) - new Date()) / 86400000); 
                    return d < 0 ? 'VENCIDO' : (d <= 30 ? 'POR_VENCER' : 'VIGENTE'); 
                };

                if (cacheDatosGlobales.diagramas) {
                    const docVen = body.exVen ? { ven: body.exVen, estado: calcularEstadoISO(body.exVen) } : null;
                    const licVen = body.licVen ? { ven: body.licVen, estado: calcularEstadoISO(body.licVen) } : null;
                    const certVen = body.certVen ? { ven: body.certVen, estado: calcularEstadoISO(body.certVen) } : null;

                    // 1. Actualizar entidad centralizada de Chofer en RAM
                    if (Array.isArray(cacheDatosGlobales.diagramas.diagramas)) {
                        const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => {
                            if (routerData && c._safeId && routerData.id && c._safeId === routerData.id) return true;
                            const nomNorm = normalizar(c.nom);
                            return nomNorm === nBuscado || nomNorm.replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n');
                        });
                        if (choferObj) {
                            if (!choferObj.documentos) choferObj.documentos = {};
                            if (docVen) choferObj.documentos.medico = docVen;
                            if (licVen) choferObj.documentos.licencia = licVen;
                            if (certVen) choferObj.documentos.certificados = certVen;
                        }
                    }

                    if (cacheDatosGlobales.diagramas.documentos && docVen) cacheDatosGlobales.diagramas.documentos[nBuscado] = docVen;
                    if (cacheDatosGlobales.diagramas.habilitaciones && licVen) cacheDatosGlobales.diagramas.habilitaciones[nBuscado] = licVen;
                    if (cacheDatosGlobales.diagramas.certificados && certVen) cacheDatosGlobales.diagramas.certificados[nBuscado] = certVen;
                    emitirDatosSiCambiaron(io, cacheDatosGlobales); 
                }

                // 2. Persistir en Supabase (chofer_documentacion)
                try {
                    const { supabase } = require('../utils/shared');
                    if (supabase) {
                        let targetChoferId = null;
                        const lista = cacheDatosGlobales?.diagramas?.diagramas || [];
                        const chEnCache = lista.find(c => {
                            if (routerData && c._safeId && routerData.id && c._safeId === routerData.id) return true;
                            const normC = normalizar(c.nom);
                            return normC === nBuscado || (nBuscado.includes('ñ') && normC.replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n'));
                        });
                        if (chEnCache?.id) {
                            targetChoferId = chEnCache.id;
                        } else if (dniParaVencimientos) {
                            const { data: docDb } = await supabase.from('chofer_documentacion').select('chofer_id').eq('dni', dniParaVencimientos).limit(1).maybeSingle();
                            if (docDb?.chofer_id) targetChoferId = docDb.chofer_id;
                        }
                        if (!targetChoferId && body.nombre) {
                            const { data: cDb } = await supabase.from('choferes').select('id').ilike('nombre', `%${body.nombre}%`).limit(1).maybeSingle();
                            if (cDb?.id) targetChoferId = cDb.id;
                        }

                        if (targetChoferId) {
                            const dbDocPayload = { actualizado_el: new Date().toISOString() };
                            if (body.exVen) dbDocPayload.venc_periodico = body.exVen;
                            if (body.licVen) dbDocPayload.venc_licencia_nacional = body.licVen;
                            if (body.certVen) dbDocPayload.venc_cargas_peligrosas = body.certVen;
                            await supabase.from('chofer_documentacion').update(dbDocPayload).eq('chofer_id', targetChoferId);
                        }
                    }
                } catch (eSupaDoc) {
                    console.warn("⚠️ Error actualizando chofer_documentacion en Supabase:", eSupaDoc.message);
                }

                let reqs = [];
                if (body.exVen && cuilParaPeriodicos) {
                    try {
                        const rowsDoc = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!E5:E1000` })).data.values || [];
                        let rIdxDoc = -1; for (let i = 0; i < rowsDoc.length; i++) { if (String(rowsDoc[i][0] || "").replace(/\D/g, '') === cuilParaPeriodicos) { rIdxDoc = i + 5; break; } }
                        let p = body.exVen.split('-'); let fechaHardcodeada = `${p[2]}/${p[1]}/${p[0]}`;
                        if (rIdxDoc !== -1) reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!I${rIdxDoc}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[fechaHardcodeada]] } }));
                    } catch(e) {}
                }

                if ((body.licVen || body.certVen) && dniParaVencimientos) {
                    try {
                        const rowsHab = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!C5:C1000` })).data.values || [];
                        let rIdxHab = -1; for (let i = 0; i < rowsHab.length; i++) { if (String(rowsHab[i][0] || "").replace(/\D/g, '') === dniParaVencimientos) { rIdxHab = i + 5; break; } }
                        let pL = body.licVen ? body.licVen.split('-') : null, pC = body.certVen ? body.certVen.split('-') : null;
                        let valL = pL ? `${pL[2]}/${pL[1]}/${pL[0]}` : "", valC = pC ? `${pC[2]}/${pC[1]}/${pC[0]}` : "";
                        if (rIdxHab !== -1) {
                            if (valL) reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!E${rIdxHab}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[valL]] } }));
                            if (valC) reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!D${rIdxHab}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[valC]] } }));
                        }
                    } catch(e) {}
                }

                await Promise.all(reqs);
                return res.json({ success: true, message: "OK" });
            }

            if (body && (body.action === 'actualizarEstado' || body.action === 'actualizarEstadoLote')) {
                let items = (body.action === 'actualizarEstadoLote' && Array.isArray(body.items)) 
                    ? body.items 
                    : (Array.isArray(body.items) ? body.items : [body]);

                // 1. Inyección inmediata en RAM para todos los ítems e inyección vía WebSockets
                items.forEach(item => {
                    let nBuscado = normalizar(item.nombre);
                    let safeIdItem = item._safeId || item.safeId;
                    let cur = new Date(item.startIso + "T12:00:00");
                    let fFin = new Date(item.endIso + "T12:00:00");
                    let idxEst = 0;

                    while (cur <= fFin) {
                        let tName = mesesAbrev[cur.getMonth()] + "-" + String(cur.getFullYear()).slice(-2);
                        let val = Array.isArray(item.est) ? item.est[idxEst] : item.est;
                        if (val === 'BORRAR') val = '';
                        let isoStr = cur.toISOString().split('T')[0];

                        if (cacheDatosGlobales.diagramas?.diagramas) {
                            let ch = cacheDatosGlobales.diagramas.diagramas.find(c => 
                                (safeIdItem && c._safeId === safeIdItem) || normalizar(c.nom) === nBuscado || normalizar(c.nom).replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n')
                            );
                            if (ch) {
                                if (!ch.dias) ch.dias = {}; if (!ch.dias[tName]) ch.dias[tName] = new Array(31).fill('-').join(',');
                                let tiraDias = ch.dias[tName].split(',');
                                tiraDias[cur.getDate() - 1] = val === '' ? '-' : val;
                                ch.dias[tName] = tiraDias.join(',');
                            }
                        }
                        cur.setDate(cur.getDate() + 1); idxEst++;
                    }
                });

                emitirDatosSiCambiaron(io, cacheDatosGlobales);

                // 2. Persistencia asíncrona optimizada a Google Sheets agrupando por pestaña (1 llamada batchUpdate por tab)
                (async () => {
                    let updatesByTab = {};

                    for (let item of items) {
                        let nBuscado = normalizar(item.nombre);
                        let cur = new Date(item.startIso + "T12:00:00");
                        let fFin = new Date(item.endIso + "T12:00:00");
                        let idxEst = 0;

                        while (cur <= fFin) {
                            let tName = mesesAbrev[cur.getMonth()] + "-" + String(cur.getFullYear()).slice(-2);
                            if (!updatesByTab[tName]) updatesByTab[tName] = {};
                            if (!updatesByTab[tName][nBuscado]) updatesByTab[tName][nBuscado] = {};

                            let val = Array.isArray(item.est) ? item.est[idxEst] : item.est;
                            if (val === 'BORRAR') val = '';
                            updatesByTab[tName][nBuscado][cur.getDate()] = val;
                            cur.setDate(cur.getDate() + 1); idxEst++;
                        }
                    }

                    for (let tab in updatesByTab) {
                        try {
                            const resSheet = await serviceAccountAuth.request({ 
                                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values/'${tab}'!A:AI` 
                            });
                            const rowsTab = resSheet.data.values || [];
                            if (rowsTab.length === 0) continue;

                            let batchDataUpdates = [];

                            for (let nBuscado in updatesByTab[tab]) {
                                let rIdx = -1;
                                for (let i = 0; i < rowsTab.length; i++) {
                                    if (normalizar(rowsTab[i][1]) === nBuscado || normalizar(rowsTab[i][1]).replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n')) {
                                        rIdx = i + 1;
                                        break;
                                    }
                                }

                                if (rIdx !== -1) {
                                    let rowData = rowsTab[rIdx - 1].slice(4, 35) || [];
                                    while (rowData.length < 31) rowData.push('');

                                    let diasModificados = updatesByTab[tab][nBuscado];
                                    for (let day in diasModificados) {
                                        rowData[parseInt(day) - 1] = diasModificados[day];
                                    }

                                    batchDataUpdates.push({
                                        range: `'${tab}'!E${rIdx}:AI${rIdx}`,
                                        values: [rowData]
                                    });
                                }
                            }

                            if (batchDataUpdates.length > 0) {
                                await serviceAccountAuth.request({
                                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values:batchUpdate`,
                                    method: 'POST',
                                    data: {
                                        valueInputOption: 'USER_ENTERED',
                                        data: batchDataUpdates
                                    }
                                });
                            }
                        } catch (errTab) {
                            console.error(`Error en actualización masiva de la pestaña ${tab}:`, errTab.message);
                        }
                    }
                })().catch(e => console.error("Error guardando lote en Google Sheets:", e));

                return res.json({ success: true, message: "OK", count: items.length });
            }

            if (body && body.action === 'guardarHojaRutaRango') {
                const nBuscado = normalizar(body.nombre);
                const curDate = new Date(body.startIso + "T12:00:00"), endDate = new Date(body.endIso + "T12:00:00");
                const hojasEntrantes = Array.isArray(body.hojas) ? body.hojas : String(body.hojas || '').split(',').map(s => s.trim()).filter(Boolean);
                const flagOverwrite = body.overwrite === true;

                if (cacheDatosGlobales.diagramas) {
                    let choferObj = null;
                    if (Array.isArray(cacheDatosGlobales.diagramas.diagramas)) {
                        choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => {
                            const nomNorm = normalizar(c.nom);
                            return nomNorm === nBuscado || nomNorm.replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n');
                        });
                        if (choferObj && !choferObj.viajes) choferObj.viajes = {};
                    }

                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado] = {};
                    let tempCur = new Date(curDate);
                    while (tempCur <= endDate) {
                        let isoStr = tempCur.toISOString().split('T')[0];
                        if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][isoStr]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][isoStr] = { dominio: body.tractor || '', km: 0, campo: 0, hoja_ruta: [] };
                        let target = cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][isoStr];
                        if (flagOverwrite) target.hoja_ruta = [...hojasEntrantes]; else hojasEntrantes.forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });

                        if (choferObj) {
                            if (!choferObj.viajes[isoStr]) choferObj.viajes[isoStr] = { dominio: body.tractor || '', km: 0, campo: 0, hoja_ruta: [] };
                            let targetChofer = choferObj.viajes[isoStr];
                            if (flagOverwrite) targetChofer.hoja_ruta = [...hojasEntrantes]; else hojasEntrantes.forEach(h => { if (!targetChofer.hoja_ruta.includes(h)) targetChofer.hoja_ruta.push(h); });
                        }

                        tempCur.setDate(tempCur.getDate() + 1);
                    }
                    emitirDatosSiCambiaron(io, cacheDatosGlobales);
                }

                // 🌟 Persistencia directa en PostgreSQL (movimientos_km)
                if (db.isConfigured()) {
                    try {
                        const hrTexto = hojasEntrantes.join(',');
                        if (hrTexto) {
                            await db.query(`
                                UPDATE movimientos_km
                                SET hoja_ruta = CASE
                                    WHEN $1::boolean = true THEN $2
                                    WHEN hoja_ruta IS NULL OR hoja_ruta = '' THEN $2
                                    WHEN NOT (hoja_ruta LIKE ('%' || $2 || '%')) THEN hoja_ruta || ',' || $2
                                    ELSE hoja_ruta
                                END
                                WHERE chofer_nombre ILIKE $3 AND fecha >= $4::date AND fecha <= $5::date
                            `, [flagOverwrite, hrTexto, '%' + String(body.nombre).trim() + '%', body.startIso, body.endIso]);
                        }
                    } catch (ePg) {
                        console.warn("⚠️ [Proxy] Error actualizando hoja de ruta en movimientos_km:", ePg.message);
                    }
                }

                // 🌟 1. Si el microservicio está activo, delegar la persistencia pesada al microservicio
                if (isMicroservicioActivo()) {
                    guardarHojaRutaMicroservicio({
                        tractor: body.tractor,
                        startIso: body.startIso,
                        endIso: body.endIso,
                        nombre: body.nombre,
                        hojas: body.hojas,
                        overwrite: flagOverwrite
                    }).catch(e => console.error("Error delegando hoja de ruta al microservicio:", e));
                    return res.json({ success: true, message: "OK" });
                }

                // 🔄 2. Fallback de respaldo: Escritura directa en Google Sheets si el microservicio está apagado
                const rowsKM = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!A:T` })).data.values || [];
                let reqs = []; const docKm = new GoogleSpreadsheet(ID_SHEET_KILOMETROS, serviceAccountAuth); let sheetLoaded = false;
                let loopDate = new Date(curDate);
                while (loopDate <= endDate) {
                    let isoStr = loopDate.toISOString().split('T')[0];
                    let targetStrSheet = `${String(loopDate.getDate()).padStart(2, '0')}/${String(loopDate.getMonth() + 1).padStart(2, '0')}/${String(loopDate.getFullYear()).slice(-2)}`;
                    let filaIndex = -1; let hojasSheetExistentes = "";

                    for (let i = 1; i < rowsKM.length; i++) {
                        if (normalizar(rowsKM[i][2]) === nBuscado || normalizar(rowsKM[i][2]).replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n')) {
                            let fechaCelda = String(rowsKM[i][1] || '').trim(); let celdaIso = "";
                            let partes = fechaCelda.split(' ')[0].split(/[\/\-]/);
                            if (partes.length >= 3) {
                                if (partes[0].length === 4) celdaIso = `${partes[0]}-${partes[1].padStart(2, '0')}-${partes[2].padStart(2, '0')}`;
                                else { let aa = partes[2].length === 2 ? "20" + partes[2] : partes[2]; celdaIso = `${aa}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`; }
                            }
                            if (celdaIso === isoStr || fechaCelda === isoStr) { filaIndex = i + 1; hojasSheetExistentes = String(rowsKM[i][19] || "").trim(); break; }
                        }
                    }

                    let finalHojasStr = "";
                    if (flagOverwrite) finalHojasStr = hojasEntrantes.join(', ');
                    else { let arrExistentes = hojasSheetExistentes ? hojasSheetExistentes.split(',').map(s => s.trim()).filter(Boolean) : []; hojasEntrantes.forEach(h => { if (!arrExistentes.includes(h)) arrExistentes.push(h); }); finalHojasStr = arrExistentes.join(', '); }

                    if (filaIndex !== -1) { reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!T${filaIndex}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[finalHojasStr]] } })); } 
                    else {
                        if (!sheetLoaded) { await docKm.loadInfo(); sheetLoaded = true; }
                        let sheetTarget = docKm.sheetsByTitle['KM'] || docKm.sheetsByIndex[0];
                        await sheetTarget.addRow([ body.tractor || "", targetStrSheet, body.nombre, "","","","","","","","","","","","","","","","", finalHojasStr ]);
                    }
                    loopDate.setDate(loopDate.getDate() + 1);
                }
                if (reqs.length > 0) await Promise.all(reqs).catch(e => console.error(e));
                return res.json({ success: true, message: "OK" });
            }

            res.json({ success: true, message: "OK" });

        } catch (error) { res.status(500).json({ success: false, error: "Error en Proxy" }); }
    });

    return router;
};

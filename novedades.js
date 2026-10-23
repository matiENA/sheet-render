const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { normalizar, serviceAccountAuth, fetchRango: sharedFetchRango, ID_SPREADSHEET_MASTER: SHARED_ID_MASTER, ID_SHEET_MOVIMIENTOS, getFechaArgentina } = require('./utils/shared');

async function inyectarServicioEnSheetDispo(tractorPatente, choferNom, servicioDB, serviceAccountAuth, fetchRango) {
    if (!servicioDB) return;
    const tractor = (tractorPatente || '').trim().toUpperCase();
    const nomNorm = choferNom ? normalizar(choferNom) : '';

    const spreadsheetId = process.env.MES_MOVIMIENTOS_ID || ID_SHEET_MOVIMIENTOS;
    
    // Obtener la fecha actual en Argentina
    const hoyAr = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
    const diaActual = hoyAr.getDate();
    const mesActual = hoyAr.getMonth();
    const anioActual = hoyAr.getFullYear();

    const mesesLargo = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

    let nombreHoja = null;
    try {
        const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
        const metaRes = await serviceAccountAuth.request({ url: metaUrl });
        const sheetTitles = metaRes.data.sheets.map(s => s.properties.title);
        
        // Pestaña dinámica del mes: ej: "AGOSTO 2026- Mov.Unidades y Choferes"
        const mesNombreUpper = mesesLargo[mesActual].toUpperCase();
        nombreHoja = sheetTitles.find(s => s.toUpperCase().includes(mesNombreUpper) && s.toLowerCase().includes('mov.unidades')) ||
                     sheetTitles.find(s => s.toLowerCase().includes('mov.unidades')) ||
                     sheetTitles.find(s => s.toLowerCase().includes('dispo')) ||
                     sheetTitles[0];
    } catch(e) {
        console.error("[Dispo] Error obteniendo pestañas:", e);
        return;
    }

    if (!nombreHoja) return;

    try {
        const rows = await fetchRango(spreadsheetId, `'${nombreHoja}'!A1:ZZ500`);
        if (!rows || rows.length === 0) return;

        let tractorColIdx = 4; // Col E (0-indexed = 4)
        let choferBaseColIdx = -1;
        let targetDispoColIdx = -1;

        // 1. Encontrar la columna "Dispo." para la FECHA ACTUAL (ej: "04 agosto 2026")
        const diaStr = String(diaActual).padStart(2, '0');
        const regexFechaActual = new RegExp(`\\b0?${diaActual}\\s+${mesesLargo[mesActual]}\\b`, 'i');

        let colFechaHeaderIdx = -1;
        if (rows[0]) {
            for (let c = 0; c < rows[0].length; c++) {
                const cellVal = String(rows[0][c] || '').trim();
                if (regexFechaActual.test(cellVal) || cellVal.includes(`${diaStr} ${mesesLargo[mesActual]}`)) {
                    colFechaHeaderIdx = c;
                    break;
                }
            }
        }

        if (colFechaHeaderIdx !== -1) {
            // Columna "Dispo." inmediatamente anterior al bloque de fecha o relativa a Chofer
            targetDispoColIdx = colFechaHeaderIdx - 2;
            if (targetDispoColIdx < 0) targetDispoColIdx = colFechaHeaderIdx + 1;
        }

        if (targetDispoColIdx === -1) {
            for (let r = 0; r < Math.min(5, rows.length); r++) {
                for (let c = 0; c < rows[r].length; c++) {
                    const cellVal = String(rows[r][c] || '').trim();
                    if (cellVal.toLowerCase() === 'tractor') tractorColIdx = c;
                    if (cellVal.toLowerCase() === 'chofer' || cellVal.toLowerCase() === 'choferes') choferBaseColIdx = c;
                }
            }

            if (choferBaseColIdx !== -1) {
                targetDispoColIdx = choferBaseColIdx + 1; // "UNA ADELANTE DEL NOM" (Columna Dispo.)
            }
        }

        if (targetDispoColIdx === -1) {
            targetDispoColIdx = 26; // Fallback Col AA
        }

        // 2. Buscar fila por tractor o chofer
        let targetRowIdx = -1;
        for (let i = 0; i < rows.length; i++) {
            const tVal = String(rows[i][tractorColIdx] || '').trim().toUpperCase();
            if (tractor && tVal === tractor) {
                targetRowIdx = i + 1;
                break;
            }

            if (choferBaseColIdx !== -1 && nomNorm) {
                const cVal = String(rows[i][choferBaseColIdx] || '').trim();
                if (cVal && normalizar(cVal) === nomNorm) {
                    targetRowIdx = i + 1;
                    break;
                }
            }
        }

        if (targetRowIdx === -1) {
            console.warn(`[Dispo] Tractor [${tractor}] o Chofer [${choferNom}] no encontrado en hoja ${nombreHoja}`);
            return;
        }

        function colToLetter(colIndex) {
            let temp, letter = '';
            while (colIndex >= 0) {
                temp = colIndex % 26;
                letter = String.fromCharCode(temp + 65) + letter;
                colIndex = (colIndex - temp) / 26 - 1;
            }
            return letter;
        }

        const colLetter = colToLetter(targetDispoColIdx);
        const rangeToUpdate = `'${nombreHoja}'!${colLetter}${targetRowIdx}`;

        await serviceAccountAuth.request({
            url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rangeToUpdate)}?valueInputOption=USER_ENTERED`,
            method: 'PUT',
            data: { values: [[servicioDB]] }
        });

        console.log(`✓ [Dispo] Servicio [${servicioDB}] inyectado en columna Dispo. (${rangeToUpdate}) para tractor ${tractor}`);
    } catch(e) {
        console.error("[Dispo] Error inyectando servicio:", e);
    }
}

// ==============================================================
// 1. CARGA E INSPECCIÓN DE NOVEDADES EN RAM
// ==============================================================
async function cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, mapaChoferesInput = null) {
    try {
        const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
        const mapaChoferes = mapaChoferesInput || cacheDatosGlobales.mapaNombreDiagramaAId || {};
        
        let temporalNovedades = [];
        if (rowsNov.length > 0) {
            rowsNov.forEach(row => {
                let id = row[0];
                let jsonStr = row[1];
                
                if(!id || id === 'id' || !jsonStr) return; 
                
                try {
                    let novedadParseada = JSON.parse(jsonStr);
                    
                    // 👉 Purgar novedades resueltas con más de 2 semanas (14 días)
                    // Las novedades NO resueltas se conservan siempre en RAM
                    if (novedadParseada.resuelto) {
                        const ahoraMs = Date.now();
                        const ms14Dias = 14 * 24 * 3600 * 1000;
                        const fRes = new Date(novedadParseada.fecha_resolucion || novedadParseada.timestamp || novedadParseada.fecha || 0).getTime();
                        if (!isNaN(fRes) && (ahoraMs - fRes) > ms14Dias) {
                            return; // Se descarta de la RAM activa (permanece en Google Sheets / Cold Storage)
                        }
                    }

                    // 👉 Parsear con Col F (nombreDiagrama) de DB_CHOFERES para obtener id de Col A
                    let nomChofer = novedadParseada.nom || novedadParseada.nombre || novedadParseada.chofer;
                    if (nomChofer) {
                        let norm = normalizar(nomChofer);
                        if (mapaChoferes && mapaChoferes[norm]) {
                            novedadParseada.chofer_id = mapaChoferes[norm];
                            novedadParseada.id_chofer = mapaChoferes[norm];
                        }
                        // 👉 Auto-actualizar n_ute, tractor y srv desde la RAM de flota si están disponibles
                        if (cacheDatosGlobales && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.flota && cacheDatosGlobales.diagramas.flota[norm]) {
                            const infoF = cacheDatosGlobales.diagramas.flota[norm];
                            if (infoF.n_ute) novedadParseada.n_ute = infoF.n_ute;
                            if (infoF.tractor) novedadParseada.tractor = infoF.tractor;
                            if (infoF.servicio) novedadParseada.srv = infoF.servicio;
                        }
                    }

                    temporalNovedades.push(novedadParseada);
                } catch(parseError) {
                    console.error(`Error parseando el JSON del ID ${id}:`, parseError);
                }
            });
        }

        // Verificamos si cambió el contenido con respecto a la RAM previa
        // Hash ligero: comparar IDs + timestamps en vez de serializar toda la RAM
        const buildHash = (arr) => arr.map(n => n.id + ':' + (n.fecha_edicion || n.fecha_resolucion || n.timestamp || '')).join('|');
        const huboCambio = buildHash(cacheDatosGlobales.novedades || []) !== buildHash(temporalNovedades);

        cacheDatosGlobales.novedades = temporalNovedades;
        return huboCambio;
    } catch (e) { 
        console.error("Error leyendo Novedades:", e); 
        return false;
    }
}

// ==============================================================
// 1.B AUTO-ENRIQUECIMIENTO EN RAM Y GOOGLE SHEETS
// ==============================================================
/**
 * Auto-enriquece en RAM (y opcionalmente en Google Sheets) las novedades
 * cruzándolas con los datos de flota vigentes (n_ute, tractor, srv).
 */
async function enriquecerNovedadesConFlota(cacheDatosGlobales, serviceAccountAuth = null, ID_SPREADSHEET_MASTER = null, fetchRango = null) {
    if (!cacheDatosGlobales || !cacheDatosGlobales.novedades || !cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.flota) {
        return false;
    }

    const flotaMap = cacheDatosGlobales.diagramas.flota;
    const mapaChoferes = cacheDatosGlobales.mapaNombreDiagramaAId || {};
    let novedadesModificadas = [];

    cacheDatosGlobales.novedades.forEach(nov => {
        let nomChofer = nov.nom || nov.nombre || nov.chofer;
        if (!nomChofer) return;
        let norm = normalizar(nomChofer);

        let modificado = false;
        
        // Auto-asociar chofer_id e id_chofer si faltaban
        if (!nov.chofer_id && mapaChoferes[norm]) {
            nov.chofer_id = mapaChoferes[norm];
            nov.id_chofer = mapaChoferes[norm];
            modificado = true;
        }

        const infoF = flotaMap[norm];
        if (infoF) {
            if (infoF.n_ute && nov.n_ute !== infoF.n_ute) {
                nov.n_ute = infoF.n_ute;
                modificado = true;
            }
            if (infoF.tractor && nov.tractor !== infoF.tractor) {
                nov.tractor = infoF.tractor;
                modificado = true;
            }
            if (infoF.semi && nov.semi !== infoF.semi) {
                nov.semi = infoF.semi;
                modificado = true;
            }
            if (infoF.cisternado && nov.cisternado !== infoF.cisternado) {
                nov.cisternado = infoF.cisternado;
                modificado = true;
            }
            if (infoF.servicio && nov.srv !== infoF.servicio && infoF.servicio !== 'S/A') {
                nov.srv = infoF.servicio;
                modificado = true;
            }
        }

        if (modificado) {
            novedadesModificadas.push(nov);
        }
    });

    // Si hubo novedades enriquecidas y tenemos credenciales para Sheets, persistimos en la hoja 'novedades'
    if (novedadesModificadas.length > 0 && serviceAccountAuth && ID_SPREADSHEET_MASTER && fetchRango) {
        try {
            const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
            const batchUpdates = [];

            novedadesModificadas.forEach(nov => {
                for (let i = 0; i < rowsNov.length; i++) {
                    if (String(rowsNov[i][0]) === String(nov.id)) {
                        let rIdx = i + 1;
                        batchUpdates.push(
                            serviceAccountAuth.request({
                                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'novedades'!B${rIdx}?valueInputOption=USER_ENTERED`,
                                method: 'PUT',
                                data: { values: [[JSON.stringify(nov)]] }
                            })
                        );
                        break;
                    }
                }
            });

            if (batchUpdates.length > 0) {
                await Promise.all(batchUpdates);
                console.log(`✅ [RAM -> Sheets] Se persistieron ${batchUpdates.length} novedades con nuevo n_ute / tractor en Google Sheets.`);
            }
        } catch (err) {
            console.error("Error persistiendo novedades enriquecidas en Google Sheets:", err.message);
        }
    }

    return novedadesModificadas.length > 0;
}

// ==============================================================
// 2. POLLING PERIÓDICO DE NOVEDADES
// ==============================================================
function iniciarPollingNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, io, ioDash, intervaloMs = 30000) {
    console.log(`⏱️ Polling de Novedades activado (frecuencia: ${Math.round(intervaloMs / 1000)}s)...`);
    
    return setInterval(async () => {
        try {
            const huboCambioNov = await cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, cacheDatosGlobales.mapaNombreDiagramaAId);
            const huboCambioEnrich = await enriquecerNovedadesConFlota(cacheDatosGlobales, serviceAccountAuth, SHARED_ID_MASTER, sharedFetchRango);

            if (huboCambioNov || huboCambioEnrich) {
                console.log("⚡ [Polling Novedades] Se detectaron cambios externos o nuevos datos de flota. Notificando a clientes...");
                ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
            }
        } catch (error) {
            console.error("❌ Error en Polling Novedades:", error);
        }
    }, intervaloMs);
}

// ==============================================================
// 3. ENDPOINTS DE LA API (Router)
// ==============================================================
function createNovedadesRouter(cacheDatosGlobales, io, ioDash, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango) {
    const router = express.Router();

    // GET: Leer novedades en vivo (RAM activa: pendientes + resueltas en los últimos 14 días)
    // Parámetro opcional ?historico=true para leer archivo completo desde Google Sheets (Cold Storage)
    router.get('/', async (req, res) => {
        if (req.query.historico === 'true') {
            try {
                const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
                const listaCompleta = [];
                rowsNov.forEach(row => {
                    if (row[0] && row[0] !== 'id' && row[1]) {
                        try { listaCompleta.push(JSON.parse(row[1])); } catch (e) {}
                    }
                });
                return res.json({ success: true, count: listaCompleta.length, data: listaCompleta });
            } catch (eHist) {
                return res.status(500).json({ success: false, error: eHist.message });
            }
        }
        res.json({ success: true, count: (cacheDatosGlobales.novedades || []).length, data: cacheDatosGlobales.novedades || [] });
    });

    // POST: Crear o Resolver novedades
    router.post('/actualizar', async (req, res) => {
        try {
            const { action, id_novedad, payload } = req.body;
            if (!cacheDatosGlobales.novedades) cacheDatosGlobales.novedades = [];

            if (action === 'nueva') {
                let nomChofer = payload.nom || payload.nombre || payload.chofer;
                let choferIdFound = null;
                let norm = nomChofer ? normalizar(nomChofer) : null;

                if (norm) {
                    if (cacheDatosGlobales.mapaNombreDiagramaAId) {
                        choferIdFound = cacheDatosGlobales.mapaNombreDiagramaAId[norm] || null;
                    }
                    if (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.flota && cacheDatosGlobales.diagramas.flota[norm]) {
                        const infoF = cacheDatosGlobales.diagramas.flota[norm];
                        if (infoF.n_ute && (!payload.n_ute || payload.n_ute === 'S/D')) payload.n_ute = infoF.n_ute;
                        if (infoF.tractor && !payload.tractor) payload.tractor = infoF.tractor;
                        if (infoF.servicio && (!payload.srv || payload.srv === 'S/A')) payload.srv = infoF.servicio;
                    }
                }

                const choferIdFinal = choferIdFound || payload.chofer_id || payload.id_chofer || null;

                const nuevaNovedad = { 
                    id: String(Date.now()), 
                    resuelto: false, 
                    chofer_id: choferIdFinal,
                    id_chofer: choferIdFinal,
                    ...payload, 
                    timestamp: new Date().toISOString() 
                };
                
                // Optimistic Server RAM
                cacheDatosGlobales.novedades.unshift(nuevaNovedad);
                ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                res.json({ success: true, data: nuevaNovedad });

                // Guardado en Sheets (como JSON)
                try {
                    const docNov = new GoogleSpreadsheet(ID_SPREADSHEET_MASTER, serviceAccountAuth);
                    await docNov.loadInfo();
                    let sheet = docNov.sheetsByTitle['novedades'];
                    
                    if (!sheet) sheet = await docNov.addSheet({ title: 'novedades', headerValues: ['id', 'json_data'] });
                    await sheet.addRow([ nuevaNovedad.id, JSON.stringify(nuevaNovedad) ]);
                } catch(e) { console.error("Error Escribiendo JSON Novedades:", e); }
            }
            else if (action === 'editar') {
                let index = cacheDatosGlobales.novedades.findIndex(n => String(n.id) === String(id_novedad));
                if(index > -1) {
                    cacheDatosGlobales.novedades[index] = {
                        ...cacheDatosGlobales.novedades[index],
                        ...payload,
                        fecha_edicion: new Date().toISOString()
                    };
                    let novedadActualizada = cacheDatosGlobales.novedades[index];
                    
                    ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                    res.json({ success: true, data: novedadActualizada });

                    try {
                        const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
                        let rIdx = -1;
                        for (let i = 0; i < rowsNov.length; i++) { 
                            if (String(rowsNov[i][0]) === String(id_novedad)) { rIdx = i + 1; break; } 
                        }
                        
                        if (rIdx !== -1) {
                            await serviceAccountAuth.request({ 
                                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'novedades'!B${rIdx}?valueInputOption=USER_ENTERED`, 
                                method: 'PUT', 
                                data: { values: [[JSON.stringify(novedadActualizada)]] } 
                            });
                        }
                    } catch(e) { console.error("Error Editando Novedad en Sheets:", e); }
                } else { 
                    res.status(404).json({ success: false, error: "No encontrada" }); 
                }
            }
            else if (action === 'resolver') {
                let index = cacheDatosGlobales.novedades.findIndex(n => String(n.id) === String(id_novedad));
                if(index > -1) {
                    const fechaRes = new Date().toISOString();

                    let rawServ = payload ? payload.servicio : null;
                    let dbServicio = rawServ;
                    if (rawServ === 'EURO') dbServicio = 'DOCK SUD';
                    if (rawServ === 'LIVIANO' || rawServ === 'LIV') dbServicio = 'UTE';

                    cacheDatosGlobales.novedades[index] = {
                        ...cacheDatosGlobales.novedades[index],
                        ...(payload || {}),
                        ...(dbServicio ? { servicio: dbServicio } : {}),
                        resuelto: true,
                        fecha_resolucion: fechaRes
                    };
                    let novedadActualizada = cacheDatosGlobales.novedades[index];
                    
                    ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                    res.json({ success: true, data: novedadActualizada });

                    // Re-escritura en Sheets 'novedades'
                    try {
                        const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
                        let rIdx = -1;
                        for (let i = 0; i < rowsNov.length; i++) { 
                            if (String(rowsNov[i][0]) === String(id_novedad)) { rIdx = i + 1; break; } 
                        }
                        
                        if (rIdx !== -1) {
                            await serviceAccountAuth.request({ 
                                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'novedades'!B${rIdx}?valueInputOption=USER_ENTERED`, 
                                method: 'PUT', 
                                data: { values: [[JSON.stringify(novedadActualizada)]] } 
                            });
                        }
                    } catch(e) { console.error("Error Resolviendo Novedad:", e); }

                    // Inyección en la hoja 'Dispo' de spreadsheet 1vYw-Zm51m50PeJmvLqshW4lBDonI7KTvBD14uIJioAU
                    if (dbServicio) {
                        inyectarServicioEnSheetDispo(novedadActualizada.tractor, novedadActualizada.nom, dbServicio, serviceAccountAuth, fetchRango).catch(e => {
                            console.error("Error inyectando en Dispo:", e);
                        });
                    }
                } else { 
                    res.status(404).json({ success: false, error: "No encontrada" }); 
                }
            }
        } catch (err) { res.status(500).json({ success: false, error: "Error en servidor" }); }
    });

    // POST: Add/Remove individual mention from a card
    router.post('/mencion', async (req, res) => {
        try {
            const { id_novedad, usuario, accion } = req.body; // accion: 'agregar' | 'quitar'
            if (!id_novedad || !usuario || !accion) {
                return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
            }
            
            let index = cacheDatosGlobales.novedades.findIndex(n => String(n.id) === String(id_novedad));
            if (index === -1) {
                return res.status(404).json({ success: false, error: 'Novedad no encontrada' });
            }
            
            let nov = cacheDatosGlobales.novedades[index];
            if (!Array.isArray(nov.menciones)) nov.menciones = [];
            
            const uNorm = String(usuario).trim().toUpperCase();
            
            if (accion === 'agregar') {
                if (!nov.menciones.includes(uNorm)) {
                    nov.menciones.push(uNorm);
                }
            } else if (accion === 'quitar') {
                nov.menciones = nov.menciones.filter(m => m !== uNorm);
            }
            
            ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
            res.json({ success: true, data: nov });
            
            // Persist to Sheets
            try {
                const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
                let rIdx = -1;
                for (let i = 0; i < rowsNov.length; i++) {
                    if (String(rowsNov[i][0]) === String(id_novedad)) { rIdx = i + 1; break; }
                }
                if (rIdx !== -1) {
                    await serviceAccountAuth.request({
                        url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'novedades'!B${rIdx}?valueInputOption=USER_ENTERED`,
                        method: 'PUT',
                        data: { values: [[JSON.stringify(nov)]] }
                    });
                }
            } catch(e) { console.error('Error persistiendo mención en Sheets:', e); }
        } catch (err) {
            res.status(500).json({ success: false, error: 'Error en servidor' });
        }
    });

    // POST: Quick update terminal for a novelty card
    router.post('/terminal', async (req, res) => {
        try {
            const { id_novedad, terminal } = req.body;
            if (!id_novedad) {
                return res.status(400).json({ success: false, error: 'Id de novedad requerido' });
            }
            
            let index = cacheDatosGlobales.novedades.findIndex(n => String(n.id) === String(id_novedad));
            if (index === -1) {
                return res.status(404).json({ success: false, error: 'Novedad no encontrada' });
            }
            
            let nov = cacheDatosGlobales.novedades[index];
            nov.terminal = String(terminal || '').toUpperCase().trim();
            
            ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
            res.json({ success: true, data: nov });
            
            // Persist to Sheets
            try {
                const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
                let rIdx = -1;
                for (let i = 0; i < rowsNov.length; i++) {
                    if (String(rowsNov[i][0]) === String(id_novedad)) { rIdx = i + 1; break; }
                }
                if (rIdx !== -1) {
                    await serviceAccountAuth.request({
                        url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'novedades'!B${rIdx}?valueInputOption=USER_ENTERED`,
                        method: 'PUT',
                        data: { values: [[JSON.stringify(nov)]] }
                    });
                }
            } catch(e) { console.error('Error persistiendo terminal en Sheets:', e); }
        } catch (err) {
            res.status(500).json({ success: false, error: 'Error en servidor' });
        }
    });

    return router;
}

module.exports = { cargarNovedades, enriquecerNovedadesConFlota, iniciarPollingNovedades, createNovedadesRouter };
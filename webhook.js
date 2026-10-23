const express = require('express');
const { normalizar } = require('./utils/shared');
const { buildSocketPayload, emitirDatosSiCambiaron } = require('./cache/builder');

module.exports = function(cacheDatosGlobales, io, ioDash, cargarNovedades, fetchRango, ID_SPREADSHEET_MASTER) {
    const router = express.Router();

    let emitTimeout = null;
    const debouncedEmitDatos = (cache) => {
        if (emitTimeout) clearTimeout(emitTimeout);
        emitTimeout = setTimeout(() => {
            emitirDatosSiCambiaron(io, cache);
            console.log("📡 [Socket] Broadcast debounced emitido a los clientes.");
        }, 1500);
    };

    router.post('/google', async (req, res) => {
        try {
            const body = req.body;

            // ==============================================================
            // 1. WEBHOOK: KILÓMETROS
            // ==============================================================
            if (body && body.action === 'webhook_update_viaje') {
                const { chofer, fecha, datos } = body;
                if (chofer && fecha && cacheDatosGlobales.diagramas) {
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer] = {};
                    
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] = {
                        ...(cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] || {}),
                        ...datos
                    };

                    // Sincronizar también en la entidad centralizada de Chofer
                    if (Array.isArray(cacheDatosGlobales.diagramas.diagramas)) {
                        const nBuscado = normalizar(chofer);
                        const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => {
                            const nomNorm = normalizar(c.nom);
                            return nomNorm === nBuscado || nomNorm.replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n');
                        });
                        if (choferObj) {
                            if (!choferObj.viajes) choferObj.viajes = {};
                            choferObj.viajes[fecha] = {
                                ...(choferObj.viajes[fecha] || {}),
                                ...datos
                            };
                        }
                    }

                    debouncedEmitDatos(cacheDatosGlobales);
                }
                return res.status(200).json({ success: true, message: "Viaje inyectado" });
            }

            // ==============================================================
            // 2. WEBHOOK: LOTE DE ESTADOS (Ideal para Multi-Delete en Excel)
            // ==============================================================
            if (body && body.action === 'webhook_update_estado_batch') {
                const updates = body.updates || [];
                
                if(updates.length > 0 && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.diagramas) {
                    updates.forEach(upd => {
                        const { chofer, fechaIso, estado, sheetTab } = upd;
                        const nBuscado = normalizar(chofer);
                        const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => normalizar(c.nom) === nBuscado);
                        
                        if (choferObj) {
                            const estadoLimpio = estado === "" ? "" : estado;

                            if (sheetTab && choferObj.dias && choferObj.dias[sheetTab]) {
                                let tiraDias = choferObj.dias[sheetTab].split(',');
                                let diaNum = parseInt(fechaIso.split('-')[2], 10);
                                
                                if (diaNum >= 1 && diaNum <= 31) {
                                    tiraDias[diaNum - 1] = estadoLimpio;
                                    choferObj.dias[sheetTab] = tiraDias.join(',');
                                }
                            }
                        }
                    });
                    console.log(`⚡ [Webhook] Se sincronizaron ${updates.length} celdas en RAM.`);
                    debouncedEmitDatos(cacheDatosGlobales);
                }
                return res.status(200).json({ success: true, message: "Batch de estados inyectado en RAM" });
            }

            // ==============================================================
            // 3. WEBHOOK: NOVEDAD INDIVIDUAL O BATCH DE NOVEDADES
            // ==============================================================
            if (body && (body.action === 'webhook_update_novedad' || body.action === 'webhook_novedades_batch')) {
                if (!cacheDatosGlobales.novedades) cacheDatosGlobales.novedades = [];
                
                const lista = body.action === 'webhook_novedades_batch' ? (body.novedades || []) : [body.novedad || body.payload || body];
                let actualizados = 0;

                lista.forEach(nov => {
                    if (!nov || !nov.id) return;
                    let idx = cacheDatosGlobales.novedades.findIndex(n => String(n.id) === String(nov.id));
                    if (idx > -1) {
                        cacheDatosGlobales.novedades[idx] = { ...cacheDatosGlobales.novedades[idx], ...nov };
                    } else {
                        cacheDatosGlobales.novedades.unshift({ resuelto: false, timestamp: new Date().toISOString(), ...nov });
                    }
                    actualizados++;
                });

                if (actualizados > 0) {
                    console.log(`⚡ [Webhook] ${actualizados} novedad(es) actualizada(s) en RAM.`);
                    ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                }
                return res.status(200).json({ success: true, message: `${actualizados} novedad(es) inyectada(s) en RAM` });
            }

            // ==============================================================
            // 4. WEBHOOK: RECARGA COMPLETA DE NOVEDADES DESDE GOOGLE SHEETS
            // ==============================================================
            if (body && body.action === 'webhook_reload_novedades') {
                if (typeof cargarNovedades === 'function' && fetchRango && ID_SPREADSHEET_MASTER) {
                    await cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales);
                    ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                    console.log("⚡ [Webhook] Novedades recargadas completamente desde Google Sheets.");
                    return res.status(200).json({ success: true, message: "Novedades recargadas" });
                }
            }

            // ==============================================================
            // 5. WEBHOOK: SINCRONIZACIÓN COMPLETA DE DIAGRAMAS -> MASTER
            // ==============================================================
            if (body && (body.action === 'sync_diagramas' || body.action === 'webhook_sync_diagramas')) {
                const { syncAllDiagramasToMaster } = require('./cache/builder');
                syncAllDiagramasToMaster(cacheDatosGlobales, io).catch(e => console.error("Error en sync webhook:", e));
                console.log("⚡ [Webhook] Sincronización de diagramas iniciada hacia Master.");
                return res.status(200).json({ success: true, message: "Sincronización de diagramas a Master iniciada" });
            }

            return res.status(200).json({ success: true, message: "Ping ignorado" });

        } catch (error) {
            console.error("❌ Error crítico en Webhook:", error);
            return res.status(500).json({ success: false, error: "Error procesando el webhook" });
        }
    });

    return router;
};